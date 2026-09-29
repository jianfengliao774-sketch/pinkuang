#!/usr/bin/env python3
"""Replace only an unused v4 pre-genesis console with a reviewed release.

The deployment and Authority journals must both be empty. Old products, old
deployment consoles, nginx, the index, and Gas senders are not changed.
"""

import argparse
import hashlib
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import time

ACTIVATE_CONSOLE_SHA256 = '545b5f7198740138d2108967136255e51b86fba3392d6b202966255639e8d11a'


def reviewed_activation_helper():
    helper = Path(__file__).with_name('activate-console.remote.py')
    require_helper = helper.is_file() and not helper.is_symlink()
    if not require_helper or hashlib.sha256(helper.read_bytes()).hexdigest() != ACTIVATE_CONSOLE_SHA256:
        raise RuntimeError('The v4 activation helper differs from the reviewed source.')
    return runpy.run_path(str(helper))


base = reviewed_activation_helper()
digest = base['digest']
require = base['require']
command = base['command']
validate_archive = base['validate_archive']
extract_archive = base['extract_archive']
write_atomic = base['write_atomic']
check_http = base['check_http']
check_https = base['check_https']
require_console_auth_file = base['require_console_auth_file']
SNIPPET = base['SNIPPET']

UNIT = Path('/etc/systemd/system/pinkuang-deploy-v4.service')
RELEASES = Path('/srv/pinkuang-deploy-v4/releases')
DB = Path('/var/lib/pinkuang-deploy-v4/journal.sqlite')
FLAG = 'Environment=BEMINE_FRESH_CONSOLE_PRE_GENESIS=1\n'
STAGE2_HOLD = 'Environment=BEMINE_FRESH_STAGE2_HOLD=1\n'
HOT_KEY_CREDENTIAL = 'LoadCredential=keeper-private-key:/etc/pinkuang/keeper-v4.key\n'
LEGACY_GAS_WALLET_ENV = ('Environment=BEMINE_EXPECTED_GAS_WALLET='
                         '0xA285d1933e32b5990625aC1F5BEa205Cf2606619\n')
BUSINESS_TABLES = ('deployment', 'fresh_activation', 'deployment_archives',
                   'market', 'market_abandoned', 'market_signing', 'market_results',
                   'budget_queues', 'quotes')
ENVIRONMENT = {
    'NODE_ENV': 'production',
    'HOST': '127.0.0.1',
    'PORT': '4177',
    'DEPLOYMENT_JOURNAL_ORIGIN': 'https://tapeout.cc.cd',
    'DEPLOYMENT_JOURNAL_DB': str(DB),
    'BEMINE_INDEX_URL': 'http://127.0.0.1:4184',
    'BEMINE_NOTIFICATIONS_ENABLED': '0',
    'AUTHORITY_RELAY_ENABLED': '0',
}
RPC_ENVIRONMENT = {'DEPLOYMENT_JOURNAL_RPC_URL', 'BEMINE_READ_RPC_URL'}
OPTIONAL_ENVIRONMENT = {'BEMINE_FRESH_CONSOLE_PRE_GENESIS': '1',
                        'BEMINE_FRESH_STAGE2_HOLD': '1'}
UNIT_KEYS = {
    'Unit': {'Description', 'After', 'Wants'},
    'Service': {'Type', 'User', 'Group', 'WorkingDirectory', 'ExecStart',
                'Environment', 'LoadCredential', 'UMask', 'NoNewPrivileges',
                'PrivateTmp', 'ProtectHome', 'ProtectSystem', 'ReadWritePaths',
                'Restart', 'RestartSec', 'TimeoutStopSec'},
    'Install': {'WantedBy'},
}
SYSTEMD_DROPIN_ROOTS = ('/etc/systemd/system', '/run/systemd/system',
                        '/usr/local/lib/systemd/system', '/usr/lib/systemd/system',
                        '/lib/systemd/system')


def require_effective_unit_isolated():
    """Refuse loaded, pending, or on-disk systemd overrides for this service."""
    service = 'pinkuang-deploy-v4.service'
    stem = service.removesuffix('.service')
    dropin_names = {f'{service}.d', 'service.d'}
    dropin_names.update(f'{stem[:index + 1]}.service.d'
                        for index, char in enumerate(stem) if char == '-')
    def setting(name):
        return subprocess.check_output(['systemctl', 'show', f'--property={name}',
                                        '--value', service], text=True).strip()
    require(setting('FragmentPath') == str(UNIT), 'v4 effective unit fragment differs.')
    require(setting('NeedDaemonReload') == 'no', 'v4 systemd configuration needs a reload.')
    require(not setting('DropInPaths'), 'v4 service has an effective drop-in.')
    for directory in SYSTEMD_DROPIN_ROOTS:
        for name in dropin_names:
            dropins = Path(directory) / name
            require(not dropins.exists() or not any(dropins.glob('*.conf')),
                    'v4 service has an on-disk drop-in.')


def review_unit(unit, release, *, expect_credential, require_flags):
    """Accept only the known standalone v4 service shape and public environment."""
    section = None
    directives = {name: {} for name in UNIT_KEYS}
    for line in unit.splitlines():
        if not line:
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            require(section in UNIT_KEYS, 'v4 unit has an unexpected section.')
            continue
        require(section in UNIT_KEYS and line == line.strip() and '=' in line,
                'v4 unit has an unexpected directive.')
        key, value = line.split('=', 1)
        require(key in UNIT_KEYS[section] and value,
                'v4 unit has an unexpected directive.')
        directives[section].setdefault(key, []).append(value)
    service = directives['Service']
    required = {
        'Type': 'simple', 'User': 'pinkuang-v4', 'Group': 'pinkuang-v4',
        'WorkingDirectory': str(release),
        'ExecStart': f'/usr/bin/node {release}/server/index.mjs',
        'UMask': '0077', 'NoNewPrivileges': 'true', 'PrivateTmp': 'true',
        'ProtectHome': 'true', 'ProtectSystem': 'strict',
        'ReadWritePaths': '/var/lib/pinkuang-deploy-v4',
        'Restart': 'on-failure', 'RestartSec': '5', 'TimeoutStopSec': '45',
    }
    require(all(service.get(key) == [value] for key, value in required.items()),
            'v4 unit service configuration differs from the reviewed console.')
    require(directives['Unit'].get('Description') ==
            ['BEMine v4 hardware-wallet deployment console (pre-genesis)']
            and directives['Unit'].get('After') == ['network-online.target']
            and directives['Unit'].get('Wants') == ['network-online.target']
            and directives['Install'].get('WantedBy') == ['multi-user.target'],
            'v4 unit identity or installation differs from the reviewed console.')
    credentials = service.get('LoadCredential', [])
    require(credentials == (['keeper-private-key:/etc/pinkuang/keeper-v4.key']
                            if expect_credential else []),
            'v4 unit credential configuration differs from the reviewed console.')
    values = {}
    for entry in service.get('Environment', []):
        require('=' in entry, 'v4 unit has an invalid environment entry.')
        key, value = entry.split('=', 1)
        require(key not in values, 'v4 unit has duplicate environment entries.')
        values[key] = value
    allowed = set(ENVIRONMENT) | RPC_ENVIRONMENT | set(OPTIONAL_ENVIRONMENT) | {'BEMINE_EXPECTED_GAS_WALLET'}
    require(set(values) <= allowed and set(ENVIRONMENT) | RPC_ENVIRONMENT <= set(values),
            'v4 unit has an unexpected or missing environment entry.')
    require(all(values.get(key) == expected for key, expected in ENVIRONMENT.items()),
            'v4 unit safety environment differs from the reviewed console.')
    if 'BEMINE_EXPECTED_GAS_WALLET' in values:
        require(f'Environment=BEMINE_EXPECTED_GAS_WALLET={values["BEMINE_EXPECTED_GAS_WALLET"]}\n' == LEGACY_GAS_WALLET_ENV,
                'v4 unit has an unreviewed Gas wallet address.')
    if require_flags:
        require('BEMINE_EXPECTED_GAS_WALLET' in values,
                'v4 unit is missing the reviewed Gas wallet public address.')
    require(values['DEPLOYMENT_JOURNAL_RPC_URL'] == values['BEMINE_READ_RPC_URL']
            and values['DEPLOYMENT_JOURNAL_RPC_URL'].startswith('https://')
            and not any(char.isspace() for char in values['DEPLOYMENT_JOURNAL_RPC_URL']),
            'v4 unit read RPC configuration differs from the reviewed console.')
    require(all(key not in values or values[key] == expected
                for key, expected in OPTIONAL_ENVIRONMENT.items()),
            'v4 unit pre-genesis or Stage 2 hold is disabled.')
    if require_flags:
        require(all(values.get(key) == expected for key, expected in OPTIONAL_ENVIRONMENT.items()),
                'v4 unit is missing a pre-genesis safety hold.')


def replacement_unit(original, old, new):
    review_unit(original, old, expect_credential=HOT_KEY_CREDENTIAL.rstrip('\n') in original,
                require_flags=False)
    updated = without_hot_wallet_credential(original)
    updated = updated.replace(f'WorkingDirectory={old}\n', f'WorkingDirectory={new}\n')
    updated = updated.replace(f'ExecStart=/usr/bin/node {old}/server/index.mjs\n',
                              f'ExecStart=/usr/bin/node {new}/server/index.mjs\n')
    if FLAG not in updated or STAGE2_HOLD not in updated or LEGACY_GAS_WALLET_ENV not in updated:
        inserted = ''.join(line for line in (FLAG, STAGE2_HOLD, LEGACY_GAS_WALLET_ENV)
                           if line not in updated)
        updated = updated.replace('UMask=0077\n', inserted + 'UMask=0077\n')
    require(updated != original and updated.count(FLAG) == 1
            and updated.count(STAGE2_HOLD) == 1
            and updated.count(LEGACY_GAS_WALLET_ENV) == 1, 'v4 unit update is ambiguous.')
    review_unit(updated, new, expect_credential=False, require_flags=True)
    return updated


def without_hot_wallet_credential(unit):
    """Remove only the reviewed legacy v4 key injection, refusing other credentials."""
    credential_lines = [line for line in unit.splitlines()
                        if re.match(r'^(?:LoadCredential(?:Encrypted)?|SetCredential(?:Encrypted)?|ImportCredential)=', line)]
    require(credential_lines in ([], [HOT_KEY_CREDENTIAL.rstrip('\n')]),
            'The v4 unit has an unexpected credential configuration.')
    return unit.replace(HOT_KEY_CREDENTIAL, '')


def empty_genesis_journals():
    require(DB.is_file() and not DB.is_symlink(), 'v4 journal database is missing or linked.')
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as db:
        for table in BUSINESS_TABLES:
            count = db.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            require(count == 0, f'v4 {table} journal is not empty; an in-place console update is blocked.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--current-release-id', required=True)
    parser.add_argument('--current-unit-sha256', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Root is required for the v4 console update.')
    require(all(re.fullmatch(r'[0-9a-f]{64}', value) for value in
                (args.archive_sha256, args.current_unit_sha256)), 'Expected SHA256 is malformed.')
    require(all(re.fullmatch(r'v4-[a-z0-9][a-z0-9-]{1,70}', value) for value in
                (args.release_id, args.current_release_id)), 'Invalid release id.')
    require(digest(args.archive) == args.archive_sha256, 'Release archive hash differs.')
    require(UNIT.is_file() and not UNIT.is_symlink()
            and digest(UNIT) == args.current_unit_sha256, 'Running v4 unit differs from reviewed snapshot.')
    require_console_auth_file()
    require(SNIPPET.is_file() and not SNIPPET.is_symlink(),
            'The reviewed v4 deployment-console nginx snippet is missing.')
    snippet = SNIPPET.read_text()
    protected_location = ('    auth_basic "BEMine deployment";\n'
                          '    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;\n')
    required_locations = ['location ^~ /pinkuang-deploy-v4/ {\n']
    if 'location ^~ /pinkuang-deploy-v4/api/ {\n' in snippet:
        required_locations.append('location ^~ /pinkuang-deploy-v4/api/ {\n')
    require(all(snippet.count(location) == 1
                and location + protected_location in snippet for location in required_locations),
            'The v4 deployment console or API is not protected by nginx authentication.')
    original = UNIT.read_text()
    old = RELEASES / args.current_release_id
    new = RELEASES / args.release_id
    require(old.is_dir() and not new.exists(), 'Reviewed old or new release state differs.')
    require_effective_unit_isolated()
    updated = replacement_unit(original, old, new)
    require(subprocess.check_output(['systemctl', 'is-active', 'pinkuang-deploy-v4.service'],
                                    text=True).strip() == 'active', 'v4 service is not active.')
    empty_genesis_journals()
    validate_archive(args.archive)
    if args.dry_run:
        print('DRY-RUN OK: empty v4 journals, pinned unit and isolated replacement release.')
        return

    extract_archive(args.archive, new)
    command(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
            timeout=300, cwd=new)
    # Mark the transition before asking systemd to stop. A stop command can
    # report an error after the process has already exited; in that case the
    # original service still needs to be started by the rollback path.
    transition_attempted = False
    try:
        empty_genesis_journals()
        require_effective_unit_isolated()
        require(digest(UNIT) == args.current_unit_sha256,
                'v4 unit changed while the replacement release was staged.')
        transition_attempted = True
        command(['systemctl', 'stop', 'pinkuang-deploy-v4.service'])
        # The active console could commit a wallet journal after the first read.
        empty_genesis_journals()
        require_effective_unit_isolated()
        require(digest(UNIT) == args.current_unit_sha256,
                'v4 unit changed before the service stopped.')
        write_atomic(UNIT, updated, 0o600)
        command(['systemctl', 'daemon-reload'])
        require_effective_unit_isolated()
        command(['systemctl', 'start', 'pinkuang-deploy-v4.service'])
        require_effective_unit_isolated()
        require(UNIT.read_text() == updated, 'v4 unit changed after the service started.')
        for attempt in range(10):
            try:
                check_http('http://127.0.0.1:4177/', 200, (new / 'dist/index.html').read_bytes())
                check_http('http://127.0.0.1:4177/deployment-artifacts.json', 200,
                           (new / 'dist/deployment-artifacts.json').read_bytes())
                check_http('http://127.0.0.1:4177/api/journal/build', 401)
                check_http('http://127.0.0.1:4177/api/journal/product-graph', 503)
                check_http('http://127.0.0.1:4177/api/journal/authority-relay/status', 503)
                break
            except Exception:
                if attempt == 9:
                    raise
                time.sleep(1)
        pid = int(subprocess.check_output(['systemctl', 'show', '--property=MainPID',
                                           '--value', 'pinkuang-deploy-v4.service'], text=True).strip())
        require(pid > 0, 'v4 service has no running process.')
        variables = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        require(not any(item.startswith(b'CREDENTIALS_DIRECTORY=') or item.startswith(b'KEEPER_PRIVATE_KEY=')
                        for item in variables), 'The public v4 process received a Gas credential.')
        check_https('/pinkuang-deploy-v4/', 401)
        check_https('/pinkuang-deploy-v4/deployment-artifacts.json', 401)
        check_https('/pinkuang-deploy-v4/upgrade.html', 401)
        check_https('/bemine-v4/', 404)
        check_https('/bemine-v2/', 200)
        print(f'ACTIVE v4 console release={args.release_id} archive_sha256={args.archive_sha256}')
        print(f'unit_sha256={digest(UNIT)} artifact_sha256={digest(new / "dist/deployment-artifacts.json")}')
    except Exception:
        if transition_attempted:
            # A failed first stop does not prove the service is still running.
            # Retry the stop, but do not let its status suppress restoration.
            try:
                command(['systemctl', 'stop', 'pinkuang-deploy-v4.service'])
            except RuntimeError:
                pass
            if UNIT.read_text() == updated:
                write_atomic(UNIT, original, 0o600)
            require(UNIT.read_text() == original, 'v4 unit changed unexpectedly during rollback.')
            command(['systemctl', 'daemon-reload'])
            command(['systemctl', 'start', 'pinkuang-deploy-v4.service'])
        raise


if __name__ == '__main__':
    main()
