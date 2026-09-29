#!/usr/bin/env python3
"""Retire the frozen v2 upgrade page without changing either product runtime.

The previously retired RPC route and the static page must still match the
reviewed nginx snippet byte for byte. Run without --apply for a read-only diff.
"""

import argparse
import difflib
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
from datetime import datetime, timezone
import stat
import time


SITE = Path('/etc/nginx/sites-available/bem2075')
SNIPPET = Path('/etc/nginx/snippets/pinkuang-upgrade-v2.conf')
BACKUPS = Path('/root/pinkuang-upgrade-v2-backups')
REVIEWED_SHA256 = '6a9a84f69df8b662a3f15270d23c89409faafaa3744aa6fc3d1948886ab2af87'
RETIRED = (
    b'# Retired v2 upgrade page; the active v2 product and v4 deployment console are separate.\n'
    b'location = /pinkuang-upgrade-v2 { return 410; }\n'
    b'location ^~ /pinkuang-upgrade-v2/ { return 410; }\n'
)
SITE_INCLUDES = (
    'include /etc/nginx/snippets/pinkuang-upgrade-v2.conf;',
    'include /etc/nginx/snippets/bemine-v2.conf;',
    'include /etc/nginx/snippets/pinkuang-deploy-v4.conf;',
)


def planned_bytes(current: bytes) -> bytes:
    if current == RETIRED:
        return current
    if hashlib.sha256(current).hexdigest() != REVIEWED_SHA256:
        raise RuntimeError('v2 upgrade nginx snippet differs from the reviewed version')
    if (current.count(b'location = /pinkuang-upgrade-v2/api/rpc { return 410; }') != 1
            or current.count(b'location ^~ /pinkuang-upgrade-v2/ {') != 1):
        raise RuntimeError('the old RPC retirement or static page boundary changed')
    return RETIRED


def review_site(source: str) -> None:
    for include in SITE_INCLUDES:
        if source.count(include) != 1:
            raise RuntimeError(f'unexpected nginx site include: {include}')


def command(*args: str) -> None:
    subprocess.run(args, check=True, timeout=30)


def probe(path: str) -> int:
    result = subprocess.run(
        ['curl', '--silent', '--show-error', '--noproxy', '*', '--max-redirs', '0',
         '--max-time', '2', '--resolve', 'tapeout.cc.cd:443:127.0.0.1',
         '--output', '/dev/null', '--write-out', '%{http_code}',
         'https://tapeout.cc.cd' + path],
        check=False, capture_output=True, text=True, timeout=4,
    )
    if result.returncode not in (0, 47) or not result.stdout.isdigit():
        raise RuntimeError(f'local HTTPS probe failed for {path}: {result.stderr.strip()}')
    return int(result.stdout)


def verify_active_routes() -> None:
    expected = {
        '/pinkuang-upgrade-v2/api/rpc': 410,
        '/bemine-v2/': 200,
        '/pinkuang-deploy-v4/': 401,
    }
    for path, status in expected.items():
        actual = probe(path)
        if actual != status:
            raise RuntimeError(f'{path} returned {actual}, expected {status}')


def verify_routes(upgrade_status: int) -> None:
    deadline = time.monotonic() + 10 if upgrade_status == 410 else None
    while True:
        # Product and active console failures are never retried. nginx can
        # briefly keep serving the old static page after an asynchronous reload.
        verify_active_routes()
        actual = probe('/pinkuang-upgrade-v2/')
        if actual == upgrade_status:
            return
        if upgrade_status != 410 or actual != 200:
            raise RuntimeError(f'/pinkuang-upgrade-v2/ returned {actual}, expected {upgrade_status}')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('nginx did not retire /pinkuang-upgrade-v2/ within 10 seconds')
        time.sleep(min(0.25, remaining))


def write_atomically(path: Path, contents: bytes, stamp: str) -> None:
    temp = path.with_name(path.name + '.new-' + stamp)
    try:
        with open(temp, 'xb') as handle:
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        shutil.copymode(path, temp)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    review_site(SITE.read_text())
    before = SNIPPET.read_bytes()
    after = planned_bytes(before)
    if before == after:
        print('Already retired:', SNIPPET)
        return
    print(''.join(difflib.unified_diff(
        before.decode().splitlines(keepends=True), after.decode().splitlines(keepends=True),
        fromfile=str(SNIPPET), tofile=str(SNIPPET) + '.proposed', n=2)))
    if not args.apply:
        return

    verify_routes(200)
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    metadata = BACKUPS.stat()
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise RuntimeError('backup directory must belong to the operator with mode 0700')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = BACKUPS / f'{SNIPPET.name}.bak-{stamp}'
    if SNIPPET.read_bytes() != before:
        raise RuntimeError('nginx snippet changed after review')
    shutil.copy2(SNIPPET, backup)
    try:
        write_atomically(SNIPPET, after, stamp)
        command('nginx', '-t')
        command('systemctl', 'reload', 'nginx')
        verify_routes(410)
    except Exception:
        write_atomically(SNIPPET, backup.read_bytes(), stamp + '-rollback')
        command('nginx', '-t')
        command('systemctl', 'reload', 'nginx')
        verify_routes(200)
        raise
    print('Retired only /pinkuang-upgrade-v2/. Backup:', backup)


if __name__ == '__main__':
    main()
