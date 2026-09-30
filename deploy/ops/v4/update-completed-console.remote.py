"""Replace a v4 console after Stage1; preserve its reviewed hold and journals."""
import argparse
from contextlib import closing
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVICE = 'pinkuang-deploy-v4.service'
UNIT = Path('/etc/systemd/system') / SERVICE
DROPINS = Path(str(UNIT) + '.d')
DB = Path('/var/lib/pinkuang-deploy-v4/journal.sqlite')
RELEASES = Path('/srv/pinkuang-deploy-v4/releases')
TABLES = ('fresh_activation', 'deployment_archives', 'market', 'market_abandoned',
          'market_signing', 'market_results', 'budget_queues', 'quotes')
FLAGS = {'BEMINE_FRESH_CONSOLE_PRE_GENESIS': '1', 'BEMINE_FRESH_STAGE2_HOLD': '1',
         'AUTHORITY_RELAY_ENABLED': '0', 'AUTHORITY_RELAY_PUBLIC_ENABLED': '0'}

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def regular(path):
    s = path.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o022,
            'A reviewed root-owned regular file is required.')
    return path.read_bytes()

def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, timeout=kwargs.pop('timeout', 45), **kwargs)
    require(result.returncode == 0, 'Command failed: ' + args[0] + ' (private output withheld).')
    return result.stdout.strip()

def service_state(name=SERVICE):
    value = run(['systemctl', 'show', name, '--property=ActiveState,MainPID,WorkingDirectory,FragmentPath,DropInPaths,NeedDaemonReload'])
    return dict(line.split('=', 1) for line in value.splitlines() if '=' in line)

def environment(pid):
    return dict(entry.decode().split('=', 1) for entry in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in entry)

def required_flags(plan):
    hold = plan.get('expectedStage2Hold', '1')
    require(hold in ('0', '1'), 'Expected Stage2 hold must be explicitly 0 or 1.')
    return {**FLAGS, 'BEMINE_FRESH_STAGE2_HOLD': hold}

def verify_process(plan, root):
    state = service_state()
    require(state['ActiveState'] == 'active' and state['WorkingDirectory'] == str(root)
            and state['FragmentPath'] == str(UNIT) and state['NeedDaemonReload'] == 'no',
            'Running v4 service differs from the reviewed release.')
    expected_drop = verify_dropin(plan)
    require(state['DropInPaths'] == str(expected_drop), 'Unreviewed effective service drop-ins.')
    env = environment(int(state['MainPID']))
    require(all(env.get(key) == value for key, value in required_flags(plan).items()),
            'The reviewed hold or disabled relay flags changed.')
    require(not env.get('KEEPER_PRIVATE_KEY'), 'Public process must not receive a private key.')
    credentials = Path(env.get('CREDENTIALS_DIRECTORY', '/nonexistent'))
    require(credentials.is_dir() and sorted(p.name for p in credentials.iterdir()) == ['authority-ipc-hmac'],
            'Public process must receive only its IPC credential.')
    return state

def verify_dropin(plan):
    expected_drop = DROPINS / '20-stage2-attestation.conf'
    require(sorted(DROPINS.iterdir()) == [expected_drop]
            and sha(regular(expected_drop)) == plan['publicDropInSha256'], 'Drop-in changed.')
    return expected_drop

def journal_snapshot(plan):
    require(DB.is_file() and not DB.is_symlink(), 'The existing journal is unavailable.')
    with closing(sqlite3.connect(f'file:{DB}?mode=ro', uri=True)) as db:
        require(all(db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] == 0 for table in TABLES),
                'Stage2 or another business journal is no longer empty.')
        rows = db.execute('SELECT account, revision, record FROM deployment').fetchall()
        require(len(rows) == 1, 'Expected one completed Stage1 record.')
        account, revision, raw = rows[0]
        record = json.loads(raw)
        require(account.lower() == plan['account'].lower() and record['id'] == plan['deploymentId']
                and record['status'] == 'complete' and record['artifactDigest'] == plan['artifactDigest']
                and len(record['steps']) == 16 and all(s['status'] == 'confirmed' for s in record['steps']),
                'Stage1 identity or completion differs from the reviewed evidence.')
        fingerprint = sha(canonical({'account': account, 'revision': revision, 'record': record}))
        require(fingerprint == plan['journalSha256'], 'Stage1 record changed; re-review before release.')
        return fingerprint

def verify_package(package, plan):
    require(package.is_dir() and package.resolve() == package and str(package).startswith('/root/pinkuang-v4-stage/'),
            'Package must be in a root-private canonical staging directory.')
    manifest_bytes = regular(package / 'public/fresh-release-manifest.json')
    require(sha(manifest_bytes) == plan['manifestSha256'], 'Release manifest hash differs.')
    manifest = json.loads(manifest_bytes)
    require(manifest['sourceHead'] == plan['sourceHead'] and manifest['artifactDigest'] == plan['artifactDigest']
            and manifest['kind'] == 'fresh-console-pre-genesis' and manifest['chainId'] == 56,
            'Release identity differs.')
    expected = set(manifest['files']) | {'public/fresh-release-manifest.json'}
    actual = set()
    for path in package.rglob('*'):
        require(not path.is_symlink(), 'Symlinks are not allowed in a release.')
        require(path.is_file() or path.is_dir(), 'Special release file rejected.')
        if path.is_file():
            actual.add(path.relative_to(package).as_posix())
    require(actual == expected, 'Release file inventory differs.')
    for name, detail in manifest['files'].items():
        require(not Path(name).is_absolute() and '..' not in Path(name).parts and '\\' not in name,
                'Unsafe release filename.')
        data = regular(package / name)
        require(sha(data) == detail['sha256'] and len(data) == detail['bytes'], 'Release file hash differs.')
    for name in ('public/deployment-artifacts.json', 'dist/deployment-artifacts.json'):
        require(sha(regular(package / name)) == plan['artifactSha256'], 'Deployed Solidity artifact changed.')
    return manifest

def replacement_unit(original, old, new):
    before = [f'WorkingDirectory={old}\n', f'ExecStart=/usr/bin/node {old}/server/index.mjs\n']
    after = [f'WorkingDirectory={new}\n', f'ExecStart=/usr/bin/node {new}/server/index.mjs\n']
    for source, target in zip(before, after):
        require(original.count(source) == 1, 'Unit path replacement is ambiguous.')
        original = original.replace(source, target)
    return original

def install_text(path, content):
    temporary = path.with_name(path.name + '.v4-review-tmp')
    with temporary.open('xb') as handle:
        os.chmod(temporary, 0o600)
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)

def status(url, expected, expected_data=None):
    try:
        with urllib.request.urlopen(url, timeout=12) as response:
            code, data = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, data = error.code, error.read()
    require(code == expected and (expected_data is None or data == expected_data), 'HTTP health or access control check failed.')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--package-dir', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Root is required.')
    os.umask(0o077)
    raw = regular(args.plan)
    require(sha(raw) == args.plan_sha256, 'Plan hash differs.')
    plan = json.loads(raw)
    require(all(re.fullmatch(r'v4-[a-z0-9][a-z0-9-]{1,70}', plan[name]) for name in ('oldReleaseId', 'newReleaseId')),
            'Invalid release name.')
    require(re.fullmatch(r'[a-f0-9]{40}', plan['sourceHead']), 'Invalid source commit.')
    old, new = RELEASES / plan['oldReleaseId'], RELEASES / plan['newReleaseId']
    require(old.is_dir() and not new.exists(), 'Old or new release state differs.')
    original = regular(UNIT)
    require(sha(original) == plan['unitSha256'], 'Existing unit changed.')
    require(sha(regular(old / 'public/deployment-artifacts.json')) == plan['artifactSha256'], 'Current artifact differs.')
    verify_process(plan, old)
    journal_snapshot(plan)
    verify_package(args.package_dir, plan)
    updated = replacement_unit(original.decode(), old, new).encode()
    v2_before = service_state('pinkuang-purchase-v2.service')
    status('https://tapeout.cc.cd/pinkuang-deploy-v4/', 401)
    if args.dry_run:
        print(json.dumps({'dryRun': True, 'stage1Preserved': True,
                          'stage2Held': required_flags(plan)['BEMINE_FRESH_STAGE2_HOLD'] == '1',
                          'sourceHead': plan['sourceHead']}))
        return
    shutil.copytree(args.package_dir, new)
    for path in [new, *new.rglob('*')]:
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
        cwd=new, timeout=300, preexec_fn=lambda: os.umask(0o022))
    verify_process(plan, old)
    journal_snapshot(plan)
    require(sha(regular(UNIT)) == plan['unitSha256'], 'Unit changed during staging.')
    stopped = False
    try:
        stopped = True
        run(['systemctl', 'stop', SERVICE])
        journal_snapshot(plan)
        require(sha(regular(UNIT)) == plan['unitSha256']
                and sha(regular(DROPINS / '20-stage2-attestation.conf')) == plan['publicDropInSha256'],
                'Service configuration changed before the switch.')
        backup = Path('/root/pinkuang-v4-stage') / (plan['newReleaseId'] + '-backup')
        backup.mkdir(mode=0o700)
        (backup / 'console.service').write_bytes(original)
        with closing(sqlite3.connect(f'file:{DB}?mode=ro', uri=True)) as source, closing(sqlite3.connect(backup / 'journal.sqlite')) as target:
            source.backup(target)
        install_text(UNIT, updated)
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'start', SERVICE])
        for attempt in range(12):
            try:
                status('http://127.0.0.1:4177/', 200, (new / 'dist/index.html').read_bytes())
                break
            except Exception:
                if attempt == 11:
                    raise
                time.sleep(1)
        verify_process(plan, new)
        journal_snapshot(plan)
        status('https://tapeout.cc.cd/pinkuang-deploy-v4/', 401)
        status('https://tapeout.cc.cd/pinkuang-deploy-v4/deployment-artifacts.json', 401)
        status('http://127.0.0.1:4177/api/journal/authority-relay/status', 503)
        status('https://tapeout.cc.cd/bemine-v4/', 404)
        status('https://tapeout.cc.cd/bemine-v2/', 200)
        require(service_state('pinkuang-purchase-v2.service') == v2_before, 'Old sender identity changed.')
        print(json.dumps({'updated': True, 'sourceHead': plan['sourceHead'], 'stage1Preserved': True,
                          'stage2Held': required_flags(plan)['BEMINE_FRESH_STAGE2_HOLD'] == '1',
                          'unitSha256': sha(updated), 'relayEnabled': False}))
    except Exception:
        if stopped:
            subprocess.run(['systemctl', 'stop', SERVICE], capture_output=True, timeout=45)
            current = regular(UNIT)
            require(current in (original, updated), 'Unit changed independently; automatic rollback refused.')
            verify_dropin(plan)
            if current == updated:
                install_text(UNIT, original)
            verify_dropin(plan)
            run(['systemctl', 'daemon-reload'])
            run(['systemctl', 'start', SERVICE])
            verify_process(plan, old)
            require(sha(regular(old / 'public/deployment-artifacts.json')) == plan['artifactSha256'],
                    'Rollback artifact changed.')
            journal_snapshot(plan)
            status('https://tapeout.cc.cd/pinkuang-deploy-v4/', 401)
            require(service_state('pinkuang-purchase-v2.service') == v2_before,
                    'Old sender identity changed during rollback.')
        raise

if __name__ == '__main__':
    main()
