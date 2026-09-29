#!/usr/bin/env python3
"""Retire only the public v2 deployment console; keep its shared backend alive.

The v2 product, journal API and purchase keeper still depend on port 4174.
Run without --apply for a read-only preflight and exact nginx diff.
"""

import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
from typing import Optional
from datetime import datetime, timezone


SITE = Path('/etc/nginx/sites-available/bem2075')
SNIPPET = Path('/etc/nginx/snippets/pinkuang-deploy-v2.conf')
JOURNAL = Path('/var/lib/pinkuang-deploy-v2/journal.sqlite')
BACKUPS = Path('/root/pinkuang-v2-console-retirement')
EXPECTED_SNIPPET_SHA256 = '1c6b6d16033ee1f551741a504987147050e89a1b3a2c6f7e2bfcfa879ad0542f'
RETIRED_SNIPPET = (
    '# Retired v2 deployment console. The v2 product and port 4174 remain active.\n'
    'location = /pinkuang-deploy-v2 { return 410; }\n'
    'location ^~ /pinkuang-deploy-v2/ { return 410; }\n'
)
SITE_INCLUDES = (
    'include /etc/nginx/snippets/bemine-v2.conf;',
    'include /etc/nginx/snippets/pinkuang-deploy-v2.conf;',
)
UNITS = ('pinkuang-deploy-v2.service', 'pinkuang-index-v2.service',
         'pinkuang-purchase-v2.service')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def retired_snippet(source: bytes, expected_sha256: str = EXPECTED_SNIPPET_SHA256) -> bytes:
    destination = RETIRED_SNIPPET.encode()
    if source == destination:
        return source
    if digest(source) != expected_sha256:
        raise RuntimeError('v2 console nginx snippet differs from the reviewed bytes')
    text = source.decode('utf-8')
    if (text.count('location = /pinkuang-deploy-v2 { return 308 /pinkuang-deploy-v2/; }') != 1
        or text.count('location ^~ /pinkuang-deploy-v2/ {') != 1
        or text.count('proxy_pass http://127.0.0.1:4174/;') != 1
        or '/bemine-v2/' in text):
        raise RuntimeError('v2 console nginx route is not isolated as reviewed')
    return destination


def review_site(source: str) -> None:
    for include in SITE_INCLUDES:
        if source.count(include) != 1:
            raise RuntimeError(f'expected exactly one nginx include: {include}')
    if source.count('/pinkuang-deploy-v2') != 1:
        raise RuntimeError('an additional v2 console route exists outside its snippet')


def review_journal(path: Path = JOURNAL) -> dict:
    if not path.is_file() or path.is_symlink():
        raise RuntimeError('v2 journal is missing or linked')
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        deployments = db.execute('SELECT record FROM deployment').fetchall()
        for (raw,) in deployments:
            record = json.loads(raw)
            if (record.get('status') != 'complete' or
                any(step.get('status') != 'confirmed' for step in record.get('steps', []))):
                raise RuntimeError('a v2 deployment still needs recovery')
        active_market = db.execute('SELECT COUNT(*) FROM market WHERE record IS NOT NULL').fetchone()[0]
        if active_market:
            raise RuntimeError('a v2 market transaction still needs recovery')
        results = db.execute('SELECT result FROM market_results').fetchall()
        for (raw,) in results:
            result = json.loads(raw)
            if result.get('finalized') is not True or result.get('status') not in (
                'confirmed', 'reverted', 'cancelled', 'replaced'):
                raise RuntimeError('a v2 market result is not finalized')
        return {'completedDeployments': len(deployments), 'activeMarketIntents': active_market,
                'finalizedMarketResults': len(results)}
    finally:
        db.close()


def command(*args: str, timeout_s: float = 15) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT,
                                   timeout=timeout_s).strip()


def probe(path: str, max_time: float = 12) -> int:
    code = command('curl', '--silent', '--show-error', '--noproxy', '*',
                   '--output', '/dev/null', '--write-out', '%{http_code}',
                   '--connect-timeout', '2', '--max-time', str(max_time),
                   '--resolve', 'tapeout.cc.cd:443:127.0.0.1',
                   'https://tapeout.cc.cd' + path, timeout_s=max_time)
    if not code.isdecimal():
        raise RuntimeError('HTTPS probe did not return a status code')
    return int(code)


def remaining_seconds(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RuntimeError('v2 console reload verification timed out')
    return remaining


def bounded_probe(path: str, deadline: float) -> int:
    return probe(path, min(2.5, remaining_seconds(deadline)))


def review_services_and_product(deadline: Optional[float] = None) -> None:
    for unit in UNITS:
        timeout_s = remaining_seconds(deadline) if deadline is not None else 15
        if command('systemctl', 'is-active', unit, timeout_s=timeout_s) != 'active':
            raise RuntimeError(f'v2 service is not active: {unit}')
    expected = {'/bemine-v2/': 200, '/bemine-v2/api/journal/build': 401}
    for path, status in expected.items():
        actual = bounded_probe(path, deadline) if deadline is not None else probe(path)
        if actual != status:
            raise RuntimeError(f'{path} returned {actual}, expected {status}')


def review_runtime(console_status: int) -> None:
    review_services_and_product()
    actual = probe('/pinkuang-deploy-v2/')
    if actual != console_status:
        raise RuntimeError(f'/pinkuang-deploy-v2/ returned {actual}, expected {console_status}')


def wait_for_retired_route(timeout_s: float = 10) -> None:
    """Allow only old-worker 200 during nginx's asynchronous reload window."""
    deadline = time.monotonic() + timeout_s
    review_services_and_product(deadline)
    while True:
        actual = bounded_probe('/pinkuang-deploy-v2/', deadline)
        if actual == 410:
            review_services_and_product(deadline)
            return
        if actual != 200:
            raise RuntimeError(f'/pinkuang-deploy-v2/ returned {actual}, expected 410')
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError('v2 console reload verification timed out')
        time.sleep(min(0.2, remaining))


def apply_update(before: bytes, after: bytes) -> Path:
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    if BACKUPS.stat().st_mode & 0o077:
        raise RuntimeError('backup directory is not private')
    backup = BACKUPS / f'pinkuang-deploy-v2.conf.{stamp}.bak'
    if backup.exists():
        raise RuntimeError('retirement backup already exists')
    shutil.copy2(SNIPPET, backup)
    backup.chmod(0o600)
    temp = SNIPPET.with_name(f'{SNIPPET.name}.new-{stamp}')
    replaced = False
    try:
        if SNIPPET.read_bytes() != before:
            raise RuntimeError('v2 nginx snippet changed after preflight')
        fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(after)
            handle.flush()
            os.fsync(handle.fileno())
        temp.chmod(SNIPPET.stat().st_mode & 0o777)
        os.replace(temp, SNIPPET)
        replaced = True
        command('nginx', '-t')
        command('systemctl', 'reload', 'nginx')
        wait_for_retired_route()
        if SNIPPET.read_bytes() != after:
            raise RuntimeError('v2 nginx snippet changed after reload')
    except Exception:
        if temp.exists():
            temp.unlink()
        if replaced:
            shutil.copy2(backup, SNIPPET)
            command('nginx', '-t')
            command('systemctl', 'reload', 'nginx')
        raise
    return backup


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='change only the pinned v2 console nginx snippet')
    args = parser.parse_args()
    if SITE.is_symlink() or SNIPPET.is_symlink():
        raise RuntimeError('reviewed nginx config paths must be regular files')
    review_site(SITE.read_text())
    before = SNIPPET.read_bytes()
    after = retired_snippet(before)
    state = review_journal()
    review_runtime(410 if before == after else 200)
    print('Read-only preflight:', json.dumps(state, sort_keys=True),
          'v2 services active; product and API healthy')
    if before == after:
        print('Already retired; no changes')
        return
    print(''.join(difflib.unified_diff(
        before.decode().splitlines(keepends=True), after.decode().splitlines(keepends=True),
        fromfile=str(SNIPPET), tofile=str(SNIPPET) + '.proposed')))
    if not args.apply:
        print('Dry run only; no files or services changed')
        return
    backup = apply_update(before, after)
    print('Retired only public /pinkuang-deploy-v2/; backup:', backup)


if __name__ == '__main__':
    main()
