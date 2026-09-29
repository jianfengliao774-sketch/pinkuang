#!/usr/bin/env python3
"""Replace only an unused v4 pre-genesis console with a reviewed release.

The deployment and Authority journals must both be empty. Old products, old
deployment consoles, nginx, the index, and Gas senders are not changed.
"""

import argparse
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import time

base = runpy.run_path(str(Path(__file__).with_name('activate-console.remote.py')))
digest = base['digest']
require = base['require']
command = base['command']
validate_archive = base['validate_archive']
extract_archive = base['extract_archive']
write_atomic = base['write_atomic']
check_http = base['check_http']
check_https = base['check_https']

UNIT = Path('/etc/systemd/system/pinkuang-deploy-v4.service')
RELEASES = Path('/srv/pinkuang-deploy-v4/releases')
DB = Path('/var/lib/pinkuang-deploy-v4/journal.sqlite')
FLAG = 'Environment=BEMINE_FRESH_CONSOLE_PRE_GENESIS=1\n'
STAGE2_HOLD = 'Environment=BEMINE_FRESH_STAGE2_HOLD=1\n'


def empty_genesis_journals():
    require(DB.is_file() and not DB.is_symlink(), 'v4 journal database is missing or linked.')
    with sqlite3.connect(f'file:{DB}?mode=ro', uri=True) as db:
        for table in ('deployment', 'fresh_activation', 'deployment_archives', 'market', 'quotes'):
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
    original = UNIT.read_text()
    old = RELEASES / args.current_release_id
    new = RELEASES / args.release_id
    require(old.is_dir() and not new.exists(), 'Reviewed old or new release state differs.')
    require(original.count(f'WorkingDirectory={old}\n') == 1
            and original.count(f'ExecStart=/usr/bin/node {old}/server/index.mjs\n') == 1
            and 'Environment=AUTHORITY_RELAY_ENABLED=0\n' in original
            and 'Environment=BEMINE_NOTIFICATIONS_ENABLED=0\n' in original,
            'v4 unit is not the reviewed pre-genesis console.')
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
    updated = original.replace(f'WorkingDirectory={old}\n', f'WorkingDirectory={new}\n')
    updated = updated.replace(f'ExecStart=/usr/bin/node {old}/server/index.mjs\n',
                              f'ExecStart=/usr/bin/node {new}/server/index.mjs\n')
    if FLAG not in updated or STAGE2_HOLD not in updated:
        require('UMask=0077\n' in updated, 'v4 unit insertion anchor changed.')
        inserted = ''.join(line for line in (FLAG, STAGE2_HOLD) if line not in updated)
        updated = updated.replace('UMask=0077\n', inserted + 'UMask=0077\n')
    require(updated != original and updated.count(FLAG) == 1
            and updated.count(STAGE2_HOLD) == 1, 'v4 unit update is ambiguous.')
    stopped = False
    try:
        empty_genesis_journals()
        command(['systemctl', 'stop', 'pinkuang-deploy-v4.service'])
        stopped = True
        write_atomic(UNIT, updated, 0o600)
        command(['systemctl', 'daemon-reload'])
        command(['systemctl', 'start', 'pinkuang-deploy-v4.service'])
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
        check_https('/pinkuang-deploy-v4/', 200, (new / 'dist/index.html').read_bytes())
        check_https('/pinkuang-deploy-v4/upgrade.html', 404)
        check_https('/bemine-v4/', 404)
        check_https('/bemine-v2/', 200)
        print(f'ACTIVE v4 console release={args.release_id} archive_sha256={args.archive_sha256}')
        print(f'unit_sha256={digest(UNIT)} artifact_sha256={digest(new / "dist/deployment-artifacts.json")}')
    except Exception:
        if stopped:
            command(['systemctl', 'stop', 'pinkuang-deploy-v4.service'])
            if UNIT.read_text() == updated:
                write_atomic(UNIT, original, 0o600)
            require(UNIT.read_text() == original, 'v4 unit changed unexpectedly during rollback.')
            command(['systemctl', 'daemon-reload'])
            command(['systemctl', 'start', 'pinkuang-deploy-v4.service'])
        raise


if __name__ == '__main__':
    main()
