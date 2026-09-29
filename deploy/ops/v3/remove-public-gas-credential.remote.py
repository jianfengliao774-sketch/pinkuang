#!/usr/bin/env python3
"""One-time, v3-only removal of public-console Gas credentials.

Copy this reviewed script to the host and run ``--dry-run`` first. This is not
a deployment or a chain transaction. It never stops or edits v2, never reads
the private-key contents, and does not enable any v3 sender. The currently
running v3 journal code rejects a new Stage 2 signing intent without its
systemd credential; this script verifies that gate before removing the mount.
"""

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time
from urllib.request import urlopen


EXPECTED_UNIT_SHA256 = '53e081b8da9584417b0b2082f5f47d9385ff249c40205e1bed75d0906959a4dd'
EXPECTED_V4_UNIT_SHA256 = 'cfa8845ca00633a59b4d72bde9f3081282a94f71eb8a7021434d78c7ee3be312'
EXPECTED_JOURNAL_API_SHA256 = 'be04717fa20e01ab759ad046142a10f34ca9ee7253564d1f746d9aacdad952fe'
EXPECTED_CREDENTIAL_READER_SHA256 = '7d56a12d623ecefd1a0e7c02a21a0b495a53b701bd644b7fba761fbd85a75d0d'
SERVICE = 'pinkuang-deploy-v3.service'
V2_SERVICES = ('pinkuang-deploy-v2.service', 'pinkuang-purchase-v2.service')
UNIT = Path('/etc/systemd/system/pinkuang-deploy-v3.service')
V4_UNIT = Path('/etc/systemd/system/pinkuang-deploy-v4.service')
V2_KEY = Path('/etc/pinkuang/keeper.key')
V3_KEY = Path('/etc/pinkuang/keeper-v3.key')
V4_KEY = Path('/etc/pinkuang/keeper-v4.key')
DB = Path('/var/lib/pinkuang-deploy-v3/journal.sqlite')
KEY_LINE = b'LoadCredential=keeper-private-key:/etc/pinkuang/keeper-v3.key\n'
ACTIVATION_STEPS = ('deployAuthority', 'coreOperator', 'coreTreasury',
                    'budgetOperator', 'budgetTreasury', 'coreOwner', 'budgetOwner')
DROPIN_ROOTS = ('/etc/systemd/system', '/run/systemd/system',
                '/usr/local/lib/systemd/system', '/usr/lib/systemd/system',
                '/lib/systemd/system')


class Refuse(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refuse(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path, *, mode=None, owner=None, allow_hardlinks=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        raise Refuse(f'Required file is missing: {path.name}') from None
    require(stat.S_ISREG(info.st_mode) and (allow_hardlinks or info.st_nlink == 1),
            f'File is linked or not regular: {path.name}')
    if mode is not None:
        require(stat.S_IMODE(info.st_mode) == mode, f'Unexpected file mode: {path.name}')
    if owner is not None:
        require((info.st_uid, info.st_gid) == owner, f'Unexpected file owner: {path.name}')
    return info


def fingerprint(path):
    s = regular(path)
    return (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_mode, s.st_uid, s.st_gid)


def directive(text, name):
    values = [line.split('=', 1)[1] for line in text.splitlines()
              if line.startswith(name + '=')]
    require(len(values) == 1, f'Unit requires exactly one {name} directive.')
    return values[0]


def changed_unit(original):
    """The pinned v3 unit may lose exactly its one reviewed credential line."""
    require(sha(original) == EXPECTED_UNIT_SHA256, 'v3 unit SHA256 differs from the reviewed live unit.')
    require(original.count(KEY_LINE) == 1, 'v3 unit Gas credential line differs.')
    text = original.decode('utf-8')
    credential_lines = [line for line in text.splitlines() if re.match(
        r'^(?:LoadCredential(?:Encrypted)?|SetCredential(?:Encrypted)?|ImportCredential)=', line)]
    require(credential_lines == [KEY_LINE.decode().rstrip('\n')],
            'v3 unit contains another credential directive.')
    require('KEEPER_PRIVATE_KEY' not in text and 'CREDENTIALS_DIRECTORY' not in text,
            'v3 unit has a second private-key source.')
    require(directive(text, 'User') == 'pinkuang-v3'
            and directive(text, 'Group') == 'pinkuang-v3',
            'v3 service identity differs.')
    require('Environment=PORT=4175\n' in text
            and 'Environment=DEPLOYMENT_JOURNAL_DB=/var/lib/pinkuang-deploy-v3/journal.sqlite\n' in text
            and 'Environment=AUTHORITY_RELAY_ENABLED=0\n' in text,
            'v3 port, database, or disabled relay differs.')
    release = directive(text, 'WorkingDirectory')
    require(re.fullmatch(r'/srv/pinkuang-deploy-v3/releases/[A-Za-z0-9._-]+', release),
            'v3 release path differs.')
    require(directive(text, 'ExecStart') == f'/usr/bin/node {release}/server/index.mjs',
            'v3 server command differs.')
    updated = original.replace(KEY_LINE, b'')
    require(updated != original and b'LoadCredential=' not in updated,
            'v3 unit credential removal is ambiguous.')
    return updated, Path(release)


def check_stage2_gate(release):
    api = release / 'server/journal-api.mjs'
    reader = release / 'scripts/keeper-credential.mjs'
    regular(api)
    # The reviewed v3 release uses a hard-linked, immutable source file here.
    # Pin its exact bytes; never permit a symlink or apply this exception to keys.
    regular(reader, allow_hardlinks=True)
    require(sha(api.read_bytes()) == EXPECTED_JOURNAL_API_SHA256
            and sha(reader.read_bytes()) == EXPECTED_CREDENTIAL_READER_SHA256,
            'v3 Stage 2 runtime differs from the reviewed release.')
    api_text = api.read_text(encoding='utf-8')
    reader_text = reader.read_text(encoding='utf-8')
    require('gasWalletAddressReader = readKeeperPublicAddress' in api_text
            and 'if (!credential.credentialVerified && (!previous || newSigningIntent))' in api_text,
            'v3 runtime no longer has the reviewed Stage 2 credential gate.')
    require('if (!env.CREDENTIALS_DIRECTORY || env.KEEPER_PRIVATE_KEY)' in reader_text,
            'v3 runtime no longer requires a systemd credential for Stage 2.')


def journal_snapshot(db_path):
    regular(db_path)
    # Read-only connection includes current WAL commits. No journal row is changed.
    with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=5) as db:
        db.execute('PRAGMA query_only=ON')
        deployment = db.execute('SELECT account,record FROM deployment WHERE record IS NOT NULL').fetchall()
        activation = db.execute('SELECT account,record FROM fresh_activation WHERE record IS NOT NULL').fetchall()
    require(len(deployment) == len(activation) == 1,
            'v3 deployment and Stage 2 journals must each contain one active record.')
    require(deployment[0][0].lower() == activation[0][0].lower(),
            'v3 deployment and Stage 2 journals belong to different wallets.')
    try:
        first = json.loads(deployment[0][1])
        second = json.loads(activation[0][1])
    except (TypeError, ValueError):
        raise Refuse('v3 journal contains invalid JSON.') from None
    require(first.get('status') == 'complete' and len(first.get('steps', [])) == 16
            and all(step.get('status') == 'confirmed' for step in first['steps']),
            'v3 genesis journal no longer has 16 confirmed transactions.')
    steps = second.get('steps', [])
    require(second.get('status') == 'paused' and len(steps) == 7
            and tuple(step.get('id') for step in steps) == ACTIVATION_STEPS
            and tuple(step.get('status') for step in steps)
            == ('confirmed', 'rejected', 'waiting', 'waiting', 'waiting', 'waiting', 'waiting')
            and second.get('deploymentId') == first.get('id'),
            'v3 Stage 2 journal differs from the reviewed paused state.')
    return (sha(deployment[0][1].encode()), sha(activation[0][1].encode()))


def run(*args):
    try:
        return subprocess.check_output(args, text=True, stderr=subprocess.DEVNULL, timeout=30).strip()
    except (subprocess.SubprocessError, OSError):
        raise Refuse('A systemd command failed; no secret values were printed.') from None


def command(*args):
    try:
        subprocess.run(args, check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=70)
    except (subprocess.SubprocessError, OSError):
        raise Refuse('A v3-only systemd action failed; inspect the service locally.') from None


def show(service, prop):
    return run('systemctl', 'show', f'--property={prop}', '--value', service)


def active(service):
    return show(service, 'ActiveState') == 'active'


def isolated_unit(service, path):
    require(show(service, 'FragmentPath') == str(path)
            and show(service, 'NeedDaemonReload') == 'no'
            and show(service, 'DropInPaths') == '',
            f'{service} has an unexpected effective unit or drop-in.')
    stem = service.removesuffix('.service')
    names = {f'{service}.d', 'service.d'}
    names.update(f'{stem[:i + 1]}.service.d' for i, char in enumerate(stem) if char == '-')
    for root in DROPIN_ROOTS:
        for name in names:
            directory = Path(root) / name
            require(not directory.exists() or not any(directory.glob('*.conf')),
                    f'{service} has an on-disk drop-in.')


def no_other_v3_sender():
    listing = run('systemctl', 'list-units', '--all', '--type=service',
                  '--plain', '--no-legend', '--no-pager')
    for line in listing.splitlines():
        fields = line.lstrip('● ').split()
        if len(fields) >= 4 and fields[0] != SERVICE \
                and fields[0].startswith(('pinkuang-', 'bemine-')) \
                and 'v3' in fields[0] and fields[3] == 'running' \
                and any(tag in fields[0] for tag in ('purchase', 'relay', 'keeper', 'sender', 'gas')):
            raise Refuse('A v3 Gas sender is running; sender isolation cannot be proved.')


def process_without_key(service):
    pid_text = show(service, 'MainPID')
    require(pid_text.isdigit() and int(pid_text) > 1, f'{service} has no main process.')
    proc = Path('/proc') / pid_text
    try:
        entries = (proc / 'environ').read_bytes().split(b'\0')
    except OSError:
        raise Refuse(f'Cannot inspect {service} process environment.') from None
    names = {entry.split(b'=', 1)[0] for entry in entries if b'=' in entry}
    require(b'CREDENTIALS_DIRECTORY' not in names and b'KEEPER_PRIVATE_KEY' not in names,
            f'{service} process still has a private-key source.')
    # systemd 255 renders the LoadCredential D-Bus array as [unprintable]
    # even for a credential-free unit. The pinned fragment, no-drop-in check,
    # and live process environment provide the effective proof here.


def copied_key_equals_original(copy):
    """Compare bytes without exposing either file content or its hash."""
    try:
        result = subprocess.run(('cmp', '-s', str(V2_KEY), str(copy)),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                timeout=10, check=False)
    except (subprocess.SubprocessError, OSError):
        raise Refuse('A Gas credential comparison failed.') from None
    require(result.returncode == 0, 'A copied Gas credential differs from the v2 original.')


def no_other_unit_references():
    """Prevent deletion while any installed service or drop-in uses either copy."""
    targets = (b'/etc/pinkuang/keeper-v3.key', b'/etc/pinkuang/keeper-v4.key')
    checked = set()
    own = UNIT.stat()
    own_identity = (own.st_dev, own.st_ino)
    for root in DROPIN_ROOTS:
        directory = Path(root)
        if not directory.exists():
            continue
        for path in directory.rglob('*'):
            if path.suffix not in ('.service', '.conf') or path == UNIT or not path.is_file():
                continue
            try:
                info = path.stat()
                identity = (info.st_dev, info.st_ino)
                if identity == own_identity:  # e.g. multi-user.target.wants symlink
                    continue
                if identity in checked:
                    continue
                checked.add(identity)
                content = path.read_bytes()
            except OSError:
                raise Refuse('Cannot inspect all installed systemd units.') from None
            require(not any(target in content for target in targets),
                    'Another installed systemd unit references a copied Gas credential.')


@dataclass(frozen=True)
class Plan:
    original: bytes
    updated: bytes
    journal: tuple
    original_key: tuple
    v3_key: tuple
    v4_key: tuple


def preflight():
    require(os.geteuid() == 0, 'Run as root on the reviewed host.')
    regular(UNIT, owner=(0, 0))
    regular(V4_UNIT, owner=(0, 0))
    original = UNIT.read_bytes()
    updated, release = changed_unit(original)
    check_stage2_gate(release)
    isolated_unit(SERVICE, UNIT)
    isolated_unit('pinkuang-deploy-v4.service', V4_UNIT)
    require(active(SERVICE), 'v3 console is not active.')
    require(all(active(service) for service in V2_SERVICES), 'A v2 service is not active.')
    no_other_v3_sender()
    v4_text = V4_UNIT.read_text(encoding='utf-8')
    require(sha(V4_UNIT.read_bytes()) == EXPECTED_V4_UNIT_SHA256,
            'v4 unit differs from the reviewed credential-free unit.')
    require(not re.search(r'^(?:LoadCredential(?:Encrypted)?|SetCredential(?:Encrypted)?|ImportCredential)=',
                          v4_text, re.M)
            and 'KEEPER_PRIVATE_KEY' not in v4_text
            and 'CREDENTIALS_DIRECTORY' not in v4_text,
            'v4 console still loads a credential.')
    require('Environment=BEMINE_FRESH_STAGE2_HOLD=1\n' in v4_text,
            'v4 Stage 2 hold is not enabled.')
    require(active('pinkuang-deploy-v4.service'), 'v4 console is not active.')
    process_without_key('pinkuang-deploy-v4.service')
    no_other_unit_references()
    original_key = fingerprint(V2_KEY)
    v3_key = fingerprint(V3_KEY)
    v4_key = fingerprint(V4_KEY)
    for key in (V2_KEY, V3_KEY, V4_KEY):
        regular(key, mode=0o600, owner=(0, 0))
    require(len({(info[0], info[1]) for info in (original_key, v3_key, v4_key)}) == 3,
            'Gas credential files are hard-linked.')
    copied_key_equals_original(V3_KEY)
    copied_key_equals_original(V4_KEY)
    return Plan(original, updated, journal_snapshot(DB), original_key, v3_key, v4_key)


def atomic_unit_write(path, data):
    fd, temporary = tempfile.mkstemp(prefix='.v3-credential-unit-', dir=path.parent)
    try:
        os.fchmod(fd, 0o644)
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def wait_http():
    for _ in range(15):
        try:
            with urlopen('http://127.0.0.1:4175/deployment-artifacts.json', timeout=2) as response:
                if response.status == 200 and response.read(1):
                    return
        except OSError:
            pass
        time.sleep(1)
    raise Refuse('v3 static deployment console did not become ready.')


def postcheck(plan):
    require(active(SERVICE) and active('pinkuang-deploy-v4.service')
            and all(active(s) for s in V2_SERVICES),
            'v3, v4, or a v2 service is not active after restart.')
    require(UNIT.read_bytes() == plan.updated and fingerprint(V2_KEY) == plan.original_key,
            'v3 unit or untouched v2 credential changed unexpectedly.')
    require(not V3_KEY.exists() and not V4_KEY.exists(), 'A copied Gas credential remains public.')
    require(journal_snapshot(DB) == plan.journal, 'v3 journals changed during cleanup.')
    isolated_unit(SERVICE, UNIT)
    process_without_key(SERVICE)
    process_without_key('pinkuang-deploy-v4.service')
    wait_http()


def apply(plan):
    """Roll back all pre-commit failures; never touch the v2 key or services."""
    backup = Path(tempfile.mkdtemp(prefix='.pinkuang-v3-credential-', dir='/root'))
    os.chmod(backup, 0o700)
    unit_backup = backup / 'unit.before'
    key_backups = ((V3_KEY, backup / 'keeper-v3.key'),
                   (V4_KEY, backup / 'keeper-v4.key'))
    changed = False
    committed = False
    try:
        unit_backup.write_bytes(plan.original)
        os.chmod(unit_backup, 0o600)
        require(UNIT.read_bytes() == plan.original and fingerprint(V2_KEY) == plan.original_key
                and fingerprint(V3_KEY) == plan.v3_key and fingerprint(V4_KEY) == plan.v4_key,
                'A file changed since preflight.')
        changed = True
        command('systemctl', 'stop', SERVICE)
        require(not active(SERVICE) and all(active(s) for s in V2_SERVICES)
                and journal_snapshot(DB) == plan.journal,
                'State changed while stopping v3; rollback required.')
        copied_key_equals_original(V3_KEY)
        copied_key_equals_original(V4_KEY)
        process_without_key('pinkuang-deploy-v4.service')
        no_other_unit_references()
        for source, destination in key_backups:
            os.replace(source, destination)
        atomic_unit_write(UNIT, plan.updated)
        command('systemctl', 'daemon-reload')
        command('systemctl', 'start', SERVICE)
        postcheck(plan)
        committed = True
    except BaseException:
        if changed and not committed:
            try:
                subprocess.run(['systemctl', 'stop', SERVICE], check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=70)
                require(not active(SERVICE), 'v3 service could not be stopped for rollback.')
                atomic_unit_write(UNIT, plan.original)
                for source, destination in key_backups:
                    if destination.exists():
                        os.replace(destination, source)
                command('systemctl', 'daemon-reload')
                command('systemctl', 'start', SERVICE)
                require(active(SERVICE) and UNIT.read_bytes() == plan.original
                        and fingerprint(V3_KEY) == plan.v3_key
                        and fingerprint(V4_KEY) == plan.v4_key
                        and fingerprint(V2_KEY) == plan.original_key,
                        'Rollback verification failed; inspect v3 before any further action.')
            except BaseException:
                raise Refuse('Rollback failed; inspect protected backup and v3 service manually.') from None
        raise
    finally:
        # After commit, the protected directory still contains both copied
        # credentials. Delete it before reporting success. On a cleanup error
        # keep v3 without a credential and report the protected residual path.
        if committed:
            try:
                shutil.rmtree(backup)
            except OSError:
                raise Refuse(f'v3 is credential-free, but protected backup cleanup failed: {backup}') from None
        elif not changed:
            shutil.rmtree(backup, ignore_errors=True)
        elif V3_KEY.exists() and V4_KEY.exists() and UNIT.read_bytes() == plan.original:
            shutil.rmtree(backup, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Preflight only; do not stop or edit services.')
    args = parser.parse_args()
    try:
        plan = preflight()
        if args.dry_run:
            print('PRECHECK OK: reviewed v3 unit and paused Stage 2 match; v2 is active.')
            print('WOULD: stop/restart v3 only, remove its credential mount and two copied keys.')
            return 0
        apply(plan)
        print('DONE: v3 console is active without Gas credential; Stage 2 is disabled.')
        print('V2 deploy/purchase services and original Gas credential remain untouched.')
        return 0
    except Refuse as error:
        print(f'REFUSED: {error}')
        return 2
    except BaseException:
        print('FAILED: v3-only action failed; rollback was attempted without exposing secrets.')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
