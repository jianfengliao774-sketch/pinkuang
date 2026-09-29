#!/usr/bin/env python3
"""Retire pre-v2 public BEMine routes without touching the active v2/v4 sites.

Run without --apply to inspect the proposed changes.  The apply path keeps
timestamped backups and reloads nginx only after its configuration validates.
"""

import argparse
import difflib
import os
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone


SITE = Path('/etc/nginx/sites-available/bem2075')
V3 = Path('/etc/nginx/snippets/pinkuang-deploy-v3.conf')
UPGRADE = Path('/etc/nginx/snippets/pinkuang-upgrade-v2.conf')


def replace_section(source: str, start: str, end: str, replacement: str) -> str:
    if source.count(start) != 1:
        raise ValueError(f'expected exactly one section start: {start!r}')
    beginning = source.index(start)
    finish = source.find(end, beginning + len(start))
    if finish < 0:
        raise ValueError(f'missing section end: {end!r}')
    return source[:beginning] + replacement + source[finish:]


def retired_site(source: str) -> str:
    if '    # Retired v1 deployment console; v4 remains separate.' in source:
        expected = ('location ^~ /pinkuang-deploy/ { return 410; }',
                    'location ^~ /bemine-test/api/ { return 410; }',
                    'location ^~ /bemine-live-test/api/ { return 410; }',
                    'location ^~ /bemine/api/ { return 410; }')
        if not all(item in source for item in expected):
            raise ValueError('legacy route retirement is only partially present')
        return source
    source = replace_section(
        source,
        '    location = /pinkuang-deploy {',
        '    # Isolated BEMine integration test;',
        '    # Retired v1 deployment console; v4 remains separate.\n'
        '    location = /pinkuang-deploy { return 410; }\n'
        '    location ^~ /pinkuang-deploy/ { return 410; }\n',
    )
    source = replace_section(
        source,
        '    # Isolated BEMine integration test;',
        '    # Separate BEMine real-chain test;',
        '    # Retired test build: send visitors to the supported v2 product.\n'
        '    location = /bemine-test { return 302 /bemine-v2/; }\n'
        '    location ^~ /bemine-test/api/ { return 410; }\n'
        '    location ^~ /bemine-test/ { return 302 /bemine-v2/; }\n',
    )
    source = replace_section(
        source,
        '    # Separate BEMine real-chain test;',
        '    # BEMine product APIs;',
        '    # Retired real-chain test build.\n'
        '    location = /bemine-live-test { return 302 /bemine-v2/; }\n'
        '    location ^~ /bemine-live-test/api/ { return 410; }\n'
        '    location ^~ /bemine-live-test/ { return 302 /bemine-v2/; }\n',
    )
    source = replace_section(
        source,
        '    # BEMine product APIs;',
        '    location / {',
        '    # Retired v1 product; do not route its API into the old journal.\n'
        '    location = /bemine { return 302 /bemine-v2/; }\n'
        '    location ^~ /bemine/api/ { return 410; }\n'
        '    location ^~ /bemine/ { return 302 /bemine-v2/$is_args$args; }\n',
    )
    return source


def retired_v3(source: str) -> str:
    if 'location ^~ /pinkuang-deploy-v3/ { return 410; }' in source:
        return source
    if 'proxy_pass http://127.0.0.1:4175/' not in source:
        raise ValueError('v3 console proxy was already changed')
    return ('# Retired v3 deployment console. The independent v4 console stays available.\n'
            'location = /pinkuang-deploy-v3 { return 410; }\n'
            'location ^~ /pinkuang-deploy-v3/ { return 410; }\n')


def retired_upgrade_rpc(source: str) -> str:
    if 'location = /pinkuang-upgrade-v2/api/rpc { return 410; }' in source:
        return source
    return replace_section(
        source,
        'location = /pinkuang-upgrade-v2/api/rpc {',
        'location ^~ /pinkuang-upgrade-v2/ {',
        'location = /pinkuang-upgrade-v2/api/rpc { return 410; }\n\n',
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    transforms = {SITE: retired_site, V3: retired_v3, UPGRADE: retired_upgrade_rpc}
    changes = {}
    for path, transform in transforms.items():
        before = path.read_text()
        after = transform(before)
        if before == after:
            print(f'Already retired: {path}')
            continue
        changes[path] = (before, after)
        print(''.join(difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile=str(path), tofile=str(path) + '.proposed', n=2)))
    if not args.apply:
        return
    if not changes:
        return

    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backups = {}
    try:
        for path, (_, after) in changes.items():
            backup = path.with_name(path.name + '.bak-' + stamp)
            shutil.copy2(path, backup)
            backups[path] = backup
            temp = path.with_name(path.name + '.new-' + stamp)
            with open(temp, 'w') as handle:
                handle.write(after)
                handle.flush()
                os.fsync(handle.fileno())
            shutil.copymode(path, temp)
            os.replace(temp, path)
        subprocess.run(['nginx', '-t'], check=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    except Exception:
        for path, backup in backups.items():
            shutil.copy2(backup, path)
        subprocess.run(['nginx', '-t'], check=False)
        raise
    print('Backups:', *(str(path) for path in backups.values()))


if __name__ == '__main__':
    main()
