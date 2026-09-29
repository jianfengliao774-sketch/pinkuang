#!/usr/bin/env python3
"""Add a dedicated per-IP nginx limit to the isolated v4 console API only."""

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.request


SNIPPET = Path('/etc/nginx/snippets/pinkuang-deploy-v4.conf')
ZONE = Path('/etc/nginx/conf.d/pinkuang-v4-api-limits.conf')
BACKUP = Path('/root/pinkuang-v4-backup-580ee6b-0929/nginx-snippet.before-api-limit.conf')
LOCATION = 'location ^~ /pinkuang-deploy-v4/ {\n'
ZONE_TEXT = 'limit_req_zone $binary_remote_addr zone=pinkuang_v4_api_ip:10m rate=30r/s;\n'
API_LOCATION = '''location ^~ /pinkuang-deploy-v4/api/ {
    auth_basic "BEMine deployment";
    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;
    proxy_set_header Authorization "";
    limit_req zone=pinkuang_v4_api_ip burst=60 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:4177/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For "";
    proxy_set_header X-Forwarded-Host "";
    proxy_set_header X-Forwarded-Proto "";
    proxy_set_header Connection "";
    proxy_cookie_path /api/journal /pinkuang-deploy-v4/api/journal;
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
}
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(args):
    result = subprocess.run(args, text=True, capture_output=True, timeout=15)
    require(result.returncode == 0, f'{args[0]} failed with exit {result.returncode}.')


def write_atomic(path, body):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f'.{path.name}.')
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def status(path):
    request = urllib.request.Request('https://tapeout.cc.cd' + path,
                                     headers={'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--current-snippet-sha256', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Root is required.')
    require(re.fullmatch(r'[0-9a-f]{64}', args.current_snippet_sha256), 'Invalid SHA256.')
    require(SNIPPET.is_file() and not SNIPPET.is_symlink()
            and not ZONE.exists() and not ZONE.is_symlink(),
            'v4 nginx files differ from the reviewed state.')
    original = SNIPPET.read_bytes()
    require(digest(original) == args.current_snippet_sha256, 'v4 nginx snippet changed.')
    text = original.decode()
    require(text.count(LOCATION) == 1 and 'pinkuang_v4_api_ip' not in text
            and LOCATION + '    auth_basic "BEMine deployment";\n'
            '    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;\n' in text,
            'v4 nginx location changed or is not access controlled.')
    require(subprocess.check_output(['systemctl', 'is-active', 'pinkuang-deploy-v4.service'],
                                    text=True).strip() == 'active', 'v4 console is not active.')
    updated = text.replace(LOCATION, API_LOCATION + LOCATION)
    require(updated != text, 'v4 nginx update is empty.')
    if args.dry_run:
        print('DRY-RUN OK: dedicated v4 API location and rate zone are ready.')
        return

    BACKUP.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not BACKUP.exists(), 'A v4 nginx backup already exists.')
    BACKUP.write_bytes(original)
    BACKUP.chmod(0o600)
    try:
        write_atomic(ZONE, ZONE_TEXT)
        write_atomic(SNIPPET, updated)
        command(['nginx', '-t'])
        command(['systemctl', 'reload', 'nginx.service'])
        require(status('/pinkuang-deploy-v4/') == 401
                and status('/pinkuang-deploy-v4/api/journal/build') == 401
                and status('/pinkuang-deploy-v4/api/journal/product-graph') == 401
                and status('/bemine-v2/') == 200,
                'The v4 API limit changed a public route unexpectedly.')
    except Exception:
        write_atomic(SNIPPET, text)
        if ZONE.exists() and ZONE.read_text() == ZONE_TEXT:
            ZONE.unlink()
        command(['nginx', '-t'])
        command(['systemctl', 'reload', 'nginx.service'])
        raise
    print(f'ACTIVE v4 API rate limit snippet_sha256={digest(SNIPPET.read_bytes())}')


if __name__ == '__main__':
    main()
