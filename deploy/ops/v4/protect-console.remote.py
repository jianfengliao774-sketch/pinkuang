#!/usr/bin/env python3
"""Require HTTP Basic authentication for every v4 deployment-console route.

The password file must be provisioned separately by the operator. This script
never accepts or prints a password, and changes only the reviewed v4 snippet.
"""

import argparse
from contextlib import contextmanager
import fcntl
import grp
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time


SNIPPET = Path('/etc/nginx/snippets/pinkuang-deploy-v4.conf')
AUTH_FILE = Path('/etc/nginx/pinkuang-deploy-v4.htpasswd')
BACKUP_DIR = Path('/root/pinkuang-v4-console-access-backup')
LOCK = Path('/run/lock/pinkuang-v4-console-access.lock')
CONSOLE = 'location ^~ /pinkuang-deploy-v4/ {'
API = 'location ^~ /pinkuang-deploy-v4/api/ {'
AUTH = ('    auth_basic "BEMine deployment";\n'
        f'    auth_basic_user_file {AUTH_FILE};\n'
        '    proxy_set_header Authorization "";\n')
PROBE_ATTEMPTS = 8
PROBE_INTERVAL_SECONDS = 1


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def protected_snippet(original):
    """Only modify the exact v4 location blocks; fail closed on an unknown shape."""
    allowed = {CONSOLE, API, 'location = /pinkuang-deploy-v4 {'}
    console_locations = [line.strip() for line in re.findall(r'(?m)^\s*location\s+[^\n{]+\{', original)
                         if '/pinkuang-deploy-v4' in line]
    require(all(location in allowed for location in console_locations)
            and len(console_locations) == len(set(console_locations))
            and 'include ' not in original,
            'The v4 snippet has an unreviewed location or include.')
    require(original.count(CONSOLE) == 1 and original.count(API) <= 1,
            'Unexpected v4 deployment-console locations.')
    require('auth_basic' not in original and 'auth_basic_user_file' not in original,
            'Existing v4 authentication must be reviewed separately.')
    result = original.replace(CONSOLE + '\n', CONSOLE + '\n' + AUTH)
    if API in result:
        result = result.replace(API + '\n', API + '\n' + AUTH)
    require(result != original and result.count(AUTH) == 1 + int(API in original),
            'Could not protect every v4 deployment-console location.')
    return result


def require_credential_file():
    require(AUTH_FILE.is_file() and not AUTH_FILE.is_symlink(),
            'A separately provisioned v4 htpasswd file is required.')
    info = AUTH_FILE.stat()
    require(info.st_uid == 0 and info.st_gid == grp.getgrnam('www-data').gr_gid
            and stat.S_IMODE(info.st_mode) == 0o640,
            'v4 htpasswd must be root:www-data with mode 0640.')
    lines = AUTH_FILE.read_text().splitlines()
    require(len(lines) >= 1 and all(re.fullmatch(r'[A-Za-z0-9_.-]{3,64}:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}', line)
                                    for line in lines),
            'v4 htpasswd file must contain bcrypt account hashes only.')


def atomic_write(path, body, mode):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def command(*args):
    result = subprocess.run(args, capture_output=True, timeout=20)
    require(result.returncode == 0, f'{args[0]} failed with exit {result.returncode}.')


@contextmanager
def secure_lock(path):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                and stat.S_IMODE(info.st_mode) == 0o600,
                'v4 console lock must be a root-owned regular file with mode 0600.')
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(descriptor)


def unauthenticated_status(path):
    result = subprocess.run([
        'curl', '--noproxy', '*', '--silent', '--show-error', '--max-time', '8',
        '--resolve', 'tapeout.cc.cd:443:127.0.0.1', '--output', '/dev/null',
        '--write-out', '%{http_code}', f'https://tapeout.cc.cd{path}',
    ], capture_output=True, text=True, timeout=10)
    require(result.returncode == 0, 'Local HTTPS probe failed.')
    return result.stdout


def require_protected_routes(paths):
    """Allow old nginx workers to drain after reload, then fail closed."""
    for attempt in range(PROBE_ATTEMPTS):
        failures = []
        for path in paths:
            try:
                status = unauthenticated_status(path)
                if status != '401':
                    failures.append(f'{path}: HTTP {status}')
            except RuntimeError as error:
                failures.append(f'{path}: {error}')
        if not failures:
            return
        if attempt + 1 < PROBE_ATTEMPTS:
            time.sleep(PROBE_INTERVAL_SECONDS)
    raise RuntimeError('v4 routes did not consistently require authentication '
                       f'after nginx reload: {", ".join(failures)}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--current-snippet-sha256', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Root is required.')
    require(re.fullmatch(r'[0-9a-f]{64}', args.current_snippet_sha256),
            'Expected snippet SHA256 is malformed.')
    require_credential_file()
    require(SNIPPET.is_file() and not SNIPPET.is_symlink(),
            'Reviewed v4 nginx snippet is absent or linked.')
    with secure_lock(LOCK):
        before = SNIPPET.read_bytes()
        require(sha256(before) == args.current_snippet_sha256,
                'v4 snippet changed since review.')
        after = protected_snippet(before.decode()).encode()
        if args.dry_run:
            print(f'DRY-RUN OK: v4 console and API will require Basic authentication; '
                  f'new_snippet_sha256={sha256(after)}')
            return
        try:
            BACKUP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
            backup = BACKUP_DIR / f'{sha256(before)}.conf'
            require(not backup.exists(), 'Reviewed v4 backup already exists.')
            atomic_write(backup, before, 0o600)
            atomic_write(SNIPPET, after, 0o644)
            command('nginx', '-t')
            command('systemctl', 'reload', 'nginx')
            require_protected_routes((
                '/pinkuang-deploy-v4/',
                '/pinkuang-deploy-v4/deployment-artifacts.json',
                '/pinkuang-deploy-v4/api/journal/product-graph',
            ))
        except Exception:
            # The previous nginx config is public. A failed reload or probe
            # must never restore that config while the deployment app is live.
            command('systemctl', 'stop', 'pinkuang-deploy-v4.service')
            raise
        # An unrelated v2 probe failure does not undo the active access gate.
        require(unauthenticated_status('/bemine-v2/') == '200',
                'Existing v2 product route changed unexpectedly; v4 access gate remains active.')
        print(f'ACTIVE v4 console authentication; snippet_sha256={sha256(after)}')


if __name__ == '__main__':
    main()
