"""Publish an ABI-compatible test Authority change after a read-only reuse proof.

Only the isolated test journal, roles, releases and units are changed. Existing
bootstrap receipts are preserved; this program never sends chain transactions.
"""
from pathlib import Path
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request

CONFIG = Path('/etc/bemine-full-test')
STATE = Path('/var/lib/bemine-full-test')
ROOTS = [Path('/srv/bemine-full-test/current'), Path('/var/www/bemine-full-test/current')]
ADMIN = '0x6F4d78fB59eC938cBAF65b9fc822aD04d00c155E'
GAS = '0x0C14b1008cFFe78711d65b13C8Ce5ca9B944252C'
UNITS = ['bemine-full-test-' + name + '.service' for name in
         ['api', 'signer', 'index', 'purchase', 'mining', 'activate']]


def call(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def write(path, data):
    mode = path.stat().st_mode & 0o777
    temp = path.with_name(path.name + '.single-admin.tmp')
    with open(temp, 'xb') as f:
        os.chmod(temp, mode)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def link(root, release):
    temp = root.with_name('current.single-admin.tmp')
    temp.symlink_to(release)
    os.replace(temp, root)


def main():
    assert os.geteuid() == 0
    runtime, site, candidate_path = map(Path, sys.argv[1:4])
    assert runtime.parent == Path('/srv/bemine-full-test/releases')
    assert site.parent == Path('/var/www/bemine-full-test/releases')
    evidence = json.loads(candidate_path.read_text())
    profile = json.loads((runtime / 'public/runtime-profile.json').read_text())
    roles = profile['roles']
    assert all(roles[name] == ADMIN for name in ['deployer', 'administratorOne', 'administratorTwo'])
    assert roles['gasWallet'] == GAS
    assert profile['artifactDigest'] == evidence['proof']['artifactDigest']
    assert evidence['proof']['preservedRuntimeCount'] == 20
    assert evidence['proof']['changedRuntime'] == 'PlatformAuthority'
    old_roots = [p.resolve() for p in ROOTS]
    paths = [CONFIG / 'public-roles.json', CONFIG / 'public.env', CONFIG / 'attest.env']
    paths += [Path('/etc/systemd/system') / name for name in UNITS]
    originals = {p: p.read_bytes() for p in paths}
    backup = CONFIG / ('single-admin-backup-' + runtime.name)
    backup.mkdir(mode=0o700)
    for i, (path, data) in enumerate(originals.items()):
        target = backup / str(i)
        target.write_bytes(data)
        target.chmod(0o600)
    (backup / 'paths.json').write_text(json.dumps([str(p) for p in paths]))
    call('systemctl', 'stop', UNITS[0], UNITS[1])
    db = sqlite3.connect(STATE / 'journal.sqlite')
    changed = False
    try:
        assert not (STATE / 'activation-ready.json').exists()
        assert db.execute('select count(*) from fresh_activation').fetchone()[0] == 0
        row = db.execute('select revision,record from deployment where account=?', (evidence['account'],)).fetchone()
        assert row and row[0] == evidence['revision'] and json.loads(row[1]) == evidence['previousRecord']
        assert db.execute('select count(*) from deployment').fetchone()[0] == 1
        before, after = evidence['previousRecord'], evidence['record']
        assert {k: v for k, v in before.items() if k not in ['artifactDigest', 'sourceCommit']} == {
            k: v for k, v in after.items() if k not in ['artifactDigest', 'sourceCommit']}
        snapshot = sqlite3.connect(backup / 'journal.sqlite')
        db.backup(snapshot)
        snapshot.close()
        (backup / 'journal.sqlite').chmod(0o600)
        with db:
            result = db.execute('update deployment set record=?,revision=revision+1 where account=? and revision=?',
                (json.dumps(after, separators=(',', ':')), evidence['account'], evidence['revision']))
            assert result.rowcount == 1
        changed = True
        current_roles = json.loads(originals[CONFIG / 'public-roles.json'])
        assert current_roles['gasWallet'] == GAS and current_roles['administratorOne'] == ADMIN
        current_roles['administratorTwo'] = ADMIN
        write(CONFIG / 'public-roles.json', (json.dumps(current_roles, indent=2) + '\n').encode())
        for path in paths[1:]:
            data = originals[path].replace(str(old_roots[0]).encode(), str(runtime).encode())
            data = data.replace(before['artifactDigest'].encode(), after['artifactDigest'].encode())
            data = data.replace(before['sourceCommit'].encode(), after['sourceCommit'].encode())
            write(path, data)
        link(ROOTS[0], runtime)
        link(ROOTS[1], site)
        call('systemctl', 'daemon-reload')
        call('systemctl', 'start', UNITS[1], UNITS[0])
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:4207/api/full-test/config', timeout=3) as response:
                    config = json.load(response)
                assert config['roles'] == roles and config['artifactDigest'] == profile['artifactDigest']
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError('Single-admin test API did not become ready')
        print(json.dumps({'status': 'published', 'administrator': ADMIN, 'gasWallet': GAS,
            'bootstrapTransactionsPreserved': 16, 'chainTransactionsSent': 0,
            'artifactDigest': profile['artifactDigest']}))
    except Exception:
        call('systemctl', 'stop', UNITS[0], UNITS[1])
        if changed:
            with db:
                db.execute('update deployment set record=?,revision=? where account=?',
                    (row[1], row[0], evidence['account']))
        for path, data in originals.items():
            write(path, data)
        for root, release in zip(ROOTS, old_roots):
            link(root, release)
        call('systemctl', 'daemon-reload')
        call('systemctl', 'start', UNITS[1], UNITS[0])
        raise
    finally:
        db.close()


if __name__ == '__main__':
    main()
