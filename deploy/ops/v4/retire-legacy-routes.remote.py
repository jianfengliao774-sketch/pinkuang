#!/usr/bin/env python3
"""Retire pre-v2 public BEMine routes without touching the active v2/v4 sites.

Run without --apply to inspect the proposed changes. An apply requires SHA-256
pins for all three independently reviewed preimages.
"""

import argparse
import difflib
import fcntl
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import time
from datetime import datetime, timezone


SITE = Path('/etc/nginx/sites-available/bem2075')
V3 = Path('/etc/nginx/snippets/pinkuang-deploy-v3.conf')
UPGRADE = Path('/etc/nginx/snippets/pinkuang-upgrade-v2.conf')
BACKUPS = Path('/root/pinkuang-legacy-route-retirement')
LOCK = Path('/run/lock/pinkuang-retire-legacy-routes.lock')
PATHS = (SITE, V3, UPGRADE)
RETIRED_V3 = (
    '# Retired v3 deployment console. The independent v4 console stays available.\n'
    'location = /pinkuang-deploy-v3 { return 410; }\n'
    'location ^~ /pinkuang-deploy-v3/ { return 410; }\n'
)
RETIRED_UPGRADE_PAGE = (
    '# Retired v2 upgrade page; the active v2 product and v4 deployment console are separate.\n'
    'location = /pinkuang-upgrade-v2 { return 410; }\n'
    'location ^~ /pinkuang-upgrade-v2/ { return 410; }\n'
)
RETIRED_ROUTES = {
    '/pinkuang-deploy/': 410,
    '/pinkuang-deploy-v3/': 410,
    '/bemine/api/rpc': 410,
    '/bemine-test/api/rpc': 410,
    '/bemine-live-test/api/rpc': 410,
    '/pinkuang-upgrade-v2/api/rpc': 410,
    '/bemine/': 302,
    '/bemine-test/': 302,
    '/bemine-live-test/': 302,
}
ACTIVE_ROUTES = {'/bemine-v2/': 200, '/pinkuang-deploy-v4/': 401}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def regular_bytes(path: Path) -> bytes:
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode):
        raise RuntimeError(f'nginx config is not a regular file: {path}')
    return path.read_bytes()


def command(*args: str) -> None:
    subprocess.run(args, check=True, timeout=30)


def probe(path: str) -> int:
    result = subprocess.run(
        ['curl', '--silent', '--show-error', '--noproxy', '*', '--max-redirs', '0',
         '--max-time', '3', '--resolve', 'tapeout.cc.cd:443:127.0.0.1',
         '--output', '/dev/null', '--write-out', '%{http_code}',
         'https://tapeout.cc.cd' + path],
        check=False, capture_output=True, text=True, timeout=5,
    )
    if result.returncode not in (0, 47) or not result.stdout.isdecimal():
        raise RuntimeError(f'local HTTPS probe failed for {path}: {result.stderr.strip()}')
    return int(result.stdout)


def active_routes() -> None:
    for path, expected in ACTIVE_ROUTES.items():
        actual = probe(path)
        if actual != expected:
            raise RuntimeError(f'{path} returned {actual}, expected {expected}')


def previous_routes() -> dict[str, int]:
    active_routes()
    observed = {path: probe(path) for path in RETIRED_ROUTES}
    if any(status == 0 or status >= 500 for status in observed.values()):
        raise RuntimeError('a legacy route is unavailable before the nginx change')
    return observed


def verify_retired_routes(previous: dict[str, int]) -> None:
    deadline = time.monotonic() + 10
    while True:
        # Active product/console failures are never treated as reload lag.
        active_routes()
        observed = {path: probe(path) for path in RETIRED_ROUTES}
        if observed == RETIRED_ROUTES:
            return
        for path, actual in observed.items():
            if actual not in (RETIRED_ROUTES[path], previous[path]):
                raise RuntimeError(f'{path} returned unexpected status {actual}')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('nginx did not retire all legacy routes within 10 seconds')
        time.sleep(min(0.25, remaining))


def write_new(path: Path, data: bytes, mode: int) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        path.unlink(missing_ok=True)
        raise


def write_atomically(path: Path, data: bytes, mode: int, stamp: str) -> None:
    temp = path.with_name(path.name + '.new-' + stamp)
    created = False
    try:
        write_new(temp, data, 0o600)
        created = True
        temp.chmod(mode)
        os.replace(temp, path)
    finally:
        if created:
            temp.unlink(missing_ok=True)


def private_backups() -> None:
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    metadata = BACKUPS.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError('backup directory must be root-owned with mode 0700')


def apply_changes(changes: dict[Path, tuple[bytes, bytes]], before: dict[Path, bytes]) -> list[Path]:
    previous = previous_routes()
    private_backups()
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backups: dict[Path, Path] = {}
    modes: dict[Path, int] = {}
    for path in changes:
        if regular_bytes(path) != before[path]:
            raise RuntimeError(f'nginx config changed after preflight: {path}')
        modes[path] = stat.S_IMODE(path.stat().st_mode)
        backup = BACKUPS / f'{path.name}.bak-{stamp}'
        write_new(backup, before[path], 0o600)
        backups[path] = backup
    replaced = []
    try:
        for path, (original, after) in changes.items():
            if regular_bytes(path) != original:
                raise RuntimeError(f'nginx config changed before replacement: {path}')
            write_atomically(path, after, modes[path], stamp)
            replaced.append(path)
        command('nginx', '-t')
        command('systemctl', 'reload', 'nginx')
        verify_retired_routes(previous)
        for path, (_, after) in changes.items():
            if regular_bytes(path) != after:
                raise RuntimeError(f'nginx config changed after reload: {path}')
    except Exception as error:
        rollback_errors = []
        for path in reversed(replaced):
            try:
                write_atomically(path, backups[path].read_bytes(), modes[path], stamp + '-rollback')
            except Exception as failed:
                rollback_errors.append(f'{path}: {failed}')
        if replaced:
            # A failed reload can still have applied candidate bytes. Always
            # reload the restored configuration, then check active routes.
            try:
                command('nginx', '-t')
                command('systemctl', 'reload', 'nginx')
                active_routes()
            except Exception as failed:
                rollback_errors.append(f'nginx rollback reload: {failed}')
        if rollback_errors:
            raise RuntimeError('retirement failed; rollback unverified: ' + '; '.join(rollback_errors)) from error
        raise
    return list(backups.values())


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
        if not all(source.count(item) == 1 for item in expected):
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
    if source == RETIRED_V3:
        return source
    if 'proxy_pass http://127.0.0.1:4175/' not in source:
        raise ValueError('v3 console proxy was already changed')
    return RETIRED_V3


def retired_upgrade_rpc(source: str) -> str:
    if source == RETIRED_UPGRADE_PAGE:
        return source
    if 'location = /pinkuang-upgrade-v2/api/rpc { return 410; }' in source:
        if source.count('location = /pinkuang-upgrade-v2/api/rpc { return 410; }') != 1 or source.count(
            'location ^~ /pinkuang-upgrade-v2/ {'
        ) != 1:
            raise ValueError('upgrade RPC retirement is only partially present')
        return source
    return replace_section(
        source,
        'location = /pinkuang-upgrade-v2/api/rpc {',
        'location ^~ /pinkuang-upgrade-v2/ {',
        'location = /pinkuang-upgrade-v2/api/rpc { return 410; }\n\n',
    )


def run(args: argparse.Namespace) -> None:
    transforms = {SITE: retired_site, V3: retired_v3, UPGRADE: retired_upgrade_rpc}
    before = {path: regular_bytes(path) for path in PATHS}
    changes: dict[Path, tuple[bytes, bytes]] = {}
    for path, transform in transforms.items():
        old = before[path].decode('utf-8')
        after = transform(old)
        print(f'{path} SHA-256 before: {digest(before[path])}')
        if old == after:
            print(f'Already retired: {path}')
            continue
        changes[path] = (before[path], after.encode('utf-8'))
        print(''.join(difflib.unified_diff(
            old.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile=str(path), tofile=str(path) + '.proposed', n=2)))
    if not args.apply:
        return
    if not changes:
        return
    expected = {SITE: args.expected_site_sha256, V3: args.expected_v3_sha256,
                UPGRADE: args.expected_upgrade_sha256}
    if any(value is None for value in expected.values()):
        raise RuntimeError('apply requires reviewed SHA-256 pins for all three nginx preimages')
    for path in PATHS:
        if digest(before[path]) != expected[path]:
            raise RuntimeError(f'nginx preimage differs from the reviewed SHA-256: {path}')
    backups = apply_changes(changes, before)
    print('Backups:', *(str(path) for path in backups))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    for name in ('site', 'v3', 'upgrade'):
        parser.add_argument(f'--expected-{name}-sha256',
                            type=lambda value: value if re.fullmatch(r'[0-9a-f]{64}', value) else parser.error(
                                'expected SHA-256 must be 64 lowercase hexadecimal characters'))
    args = parser.parse_args()
    if not args.apply:
        run(args)
        return
    if os.geteuid() != 0:
        raise RuntimeError('--apply requires root')
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(fd)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != 0
                or stat.S_IMODE(metadata.st_mode) & 0o077 or metadata.st_nlink != 1):
            raise RuntimeError('retirement lock must be a private root-owned regular file')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('another route retirement holds the lock') from error
        run(args)
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
