#!/usr/bin/env python3
"""Install only the independent pre-genesis v4 deployment console.

The fresh product, index, Gas relay and old runtimes remain untouched.
The public HTTP process receives only the configured Gas wallet address. No Gas
private key is copied or loaded. Expected hashes come from a reviewed host snapshot.
"""

import argparse
import grp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import stat
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

SITE = Path('/etc/nginx/sites-available/bem2075')
RPC_SOURCE_UNIT = Path('/etc/systemd/system/pinkuang-deploy-v3.service')
V4_UNIT = Path('/etc/systemd/system/pinkuang-deploy-v4.service')
SNIPPET = Path('/etc/nginx/snippets/pinkuang-deploy-v4.conf')
AUTH_FILE = Path('/etc/nginx/pinkuang-deploy-v4.htpasswd')
RELEASES = Path('/srv/pinkuang-deploy-v4/releases')
DB_DIR = Path('/var/lib/pinkuang-deploy-v4')
ANCHOR = '    include /etc/nginx/snippets/pinkuang-deploy-v3.conf;\n'
INCLUDE = '    include /etc/nginx/snippets/pinkuang-deploy-v4.conf;\n'
ALLOWED = {'dist', 'public', 'server', 'shared', 'scripts', 'src', 'package.json', 'package-lock.json'}
REQUIRED = {'dist/index.html', 'dist/deployment-artifacts.json',
            'public/deployment-artifacts.json', 'public/fresh-release-manifest.json',
            'server/index.mjs', 'server/authority-ipc.mjs',
            'server/authority-role.mjs',
            'shared/gas-signer-attestation.mjs',
            'package.json', 'package-lock.json'}


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def require_console_auth_file():
    require(AUTH_FILE.is_file() and not AUTH_FILE.is_symlink(),
            'Provision the v4 deployment-console htpasswd file before activation.')
    info = AUTH_FILE.stat()
    require(info.st_uid == 0 and info.st_gid == grp.getgrnam('www-data').gr_gid
            and stat.S_IMODE(info.st_mode) == 0o640,
            'v4 htpasswd must be root:www-data with mode 0640.')
    lines = AUTH_FILE.read_text().splitlines()
    require(len(lines) >= 1
            and all(re.fullmatch(r'[A-Za-z0-9_.-]{3,64}:\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}', line)
                    for line in lines), 'v4 htpasswd must contain bcrypt account hashes only.')


def command(args, timeout=90, cwd=None):
    result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, cwd=cwd)
    if result.returncode:
        # Command output can include an RPC URL or environment; report only the command name.
        raise RuntimeError(f'{args[0]} failed with exit {result.returncode}')


def reviewed_rpc():
    # Existing unit is the reviewed source of a working RPC origin. Never print it.
    lines = RPC_SOURCE_UNIT.read_text().splitlines()
    values = [line[len('Environment=DEPLOYMENT_JOURNAL_RPC_URL='):]
              for line in lines if line.startswith('Environment=DEPLOYMENT_JOURNAL_RPC_URL=')]
    require(len(values) == 1 and values[0].startswith('https://')
            and '\n' not in values[0] and '%' not in values[0],
            'Reviewed RPC source environment is not a single safe HTTPS value.')
    return values[0]


def validate_archive(path):
    names, files = set(), {}
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            name = PurePosixPath(item.name)
            require(not name.is_absolute() and name.parts and '..' not in name.parts
                    and name.parts[0] in ALLOWED and (item.isfile() or item.isdir())
                    and not any(part.startswith('.') for part in name.parts),
                    'Release archive contains an unsafe entry.')
            require(not (name.parts[0] == 'dist'
                         and any('upgrade' in part.lower() for part in name.parts[1:])),
                    'Fresh console archive exposes an upgrade page or asset.')
            require(str(name) not in names, 'Release archive contains a duplicate entry.')
            names.add(str(name))
            if item.isfile():
                h = hashlib.sha256()
                size = 0
                with archive.extractfile(item) as stream:
                    while block := stream.read(1024 * 1024):
                        h.update(block)
                        size += len(block)
                files[str(name)] = {'sha256': h.hexdigest(), 'bytes': size}
        require(REQUIRED.issubset(files), 'Release archive lacks a required runtime file.')
        with archive.extractfile(archive.getmember('public/fresh-release-manifest.json')) as stream:
            manifest = json.load(stream)
    require(manifest.get('kind') == 'fresh-console-pre-genesis'
            and manifest.get('chainId') == 56
            and manifest.get('entrypoint') == 'node server/index.mjs',
            'Release manifest is not a fresh pre-genesis console.')
    expected = manifest.get('files')
    require(isinstance(expected, dict) and set(files) == set(expected) | {'public/fresh-release-manifest.json'},
            'Release archive differs from the reviewed manifest file list.')
    require(all(files[name] == record for name, record in expected.items()),
            'Release archive file checksum differs from the reviewed manifest.')
    require(manifest.get('artifactSha256') == files['public/deployment-artifacts.json']['sha256']
            and files['dist/deployment-artifacts.json'] == files['public/deployment-artifacts.json'],
            'Fresh browser artifact differs from the pinned release artifact.')


def extract_archive(path, destination):
    destination.mkdir(mode=0o755, parents=True)
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            target = destination.joinpath(*PurePosixPath(item.name).parts)
            if item.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
            else:
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                with archive.extractfile(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)
    require((destination / 'dist/deployment-artifacts.json').read_bytes()
            == (destination / 'public/deployment-artifacts.json').read_bytes(),
            'Browser and server deployment artifacts differ.')


def write_atomic(path, content, mode=0o644):
    fd, temp = tempfile.mkstemp(prefix=f'.{path.name}.', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def check_http(url, expected_status, expected_body=None):
    request = urllib.request.Request(url, headers={'Host': 'tapeout.cc.cd'})
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            status, body = response.status, response.read(8 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read(8192)
    require(status == expected_status, f'HTTP health status differs for {url}.')
    if expected_body is not None:
        require(body == expected_body, f'HTTP health content differs for {url}.')


def check_https(path, expected_status, expected_body=None):
    with tempfile.NamedTemporaryFile() as body_file:
        result = subprocess.run([
            'curl', '--noproxy', '*', '--silent', '--show-error', '--max-time', '8',
            '--resolve', 'tapeout.cc.cd:443:127.0.0.1', '--output', body_file.name,
            '--write-out', '%{http_code}', f'https://tapeout.cc.cd{path}',
        ], capture_output=True, text=True, timeout=10)
        require(result.returncode == 0 and result.stdout == str(expected_status),
                f'HTTPS health status differs for {path}.')
        if expected_body is not None:
            require(Path(body_file.name).read_bytes() == expected_body,
                    f'HTTPS health content differs for {path}.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--release-id', required=True)
    parser.add_argument('--site-sha256', required=True)
    parser.add_argument('--rpc-unit-sha256', required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Root is required for an isolated service install.')
    require(re.fullmatch(r'v4-[a-z0-9][a-z0-9-]{1,70}', args.release_id), 'Invalid release id.')
    require(all(re.fullmatch(r'[0-9a-f]{64}', value) for value in
                (args.archive_sha256, args.site_sha256, args.rpc_unit_sha256)),
            'Expected SHA256 is malformed.')
    require(digest(args.archive) == args.archive_sha256, 'Release archive hash differs.')
    require(digest(SITE) == args.site_sha256 and digest(RPC_SOURCE_UNIT) == args.rpc_unit_sha256,
            'Current nginx or RPC source unit differs from the reviewed read-only snapshot.')
    require_console_auth_file()
    require(not V4_UNIT.exists() and not SNIPPET.exists()
            and not (RELEASES / args.release_id).exists(), 'v4 console is already installed.')
    with socket.socket() as listener_check:
        listener_check.settimeout(1)
        require(listener_check.connect_ex(('127.0.0.1', 4177)) != 0,
                'Independent v4 loopback port 4177 is already in use.')
    original_site = SITE.read_text()
    require(original_site.count(ANCHOR) == 1 and INCLUDE not in original_site,
            'The HTTPS nginx include anchor changed.')
    rpc = reviewed_rpc()
    validate_archive(args.archive)
    if args.dry_run:
        print('DRY-RUN OK: reviewed archive, RPC source snapshot and isolated v4 paths.')
        return

    release = RELEASES / args.release_id
    site_changed = service_attempted = False
    try:
        extract_archive(args.archive, release)
        command(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                timeout=300, cwd=release)
    except Exception:
        # A failed package install is not retried against an unreviewed release.
        raise

    try:
        try:
            user = pwd.getpwnam('pinkuang-v4')
        except KeyError:
            command(['useradd', '--system', '--user-group', '--home-dir', str(DB_DIR),
                     '--shell', '/usr/sbin/nologin', 'pinkuang-v4'])
            user = pwd.getpwnam('pinkuang-v4')
        DB_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
        DB_DIR.chmod(0o700)
        os.chown(DB_DIR, user.pw_uid, user.pw_gid)
        env = {
            'NODE_ENV': 'production', 'HOST': '127.0.0.1', 'PORT': '4177',
            'DEPLOYMENT_JOURNAL_ORIGIN': 'https://tapeout.cc.cd',
            'DEPLOYMENT_JOURNAL_DB': str(DB_DIR / 'journal.sqlite'),
            'DEPLOYMENT_JOURNAL_RPC_URL': rpc, 'BEMINE_READ_RPC_URL': rpc,
            'BEMINE_INDEX_URL': 'http://127.0.0.1:4184',
            'BEMINE_NOTIFICATIONS_ENABLED': '0',
            'BEMINE_FRESH_CONSOLE_PRE_GENESIS': '1',
            'BEMINE_FRESH_STAGE2_HOLD': '1',
            'AUTHORITY_RELAY_ENABLED': '0',
        }
        unit = ('[Unit]\nDescription=BEMine v4 hardware-wallet deployment console (pre-genesis)\n'
                'After=network-online.target\nWants=network-online.target\n\n[Service]\n'
                'Type=simple\nUser=pinkuang-v4\nGroup=pinkuang-v4\n'
                f'WorkingDirectory={release}\nExecStart=/usr/bin/node {release}/server/index.mjs\n'
                + ''.join(f'Environment={key}={value}\n' for key, value in env.items())
                + 'UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n'
                'ProtectHome=true\nProtectSystem=strict\n'
                f'ReadWritePaths={DB_DIR}\nRestart=on-failure\nRestartSec=5\n'
                'TimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n')
        snippet = ('location = /pinkuang-deploy-v4 { return 308 /pinkuang-deploy-v4/; }\n'
                   'location ^~ /pinkuang-deploy-v4/ {\n'
                   '    auth_basic "BEMine deployment";\n'
                   f'    auth_basic_user_file {AUTH_FILE};\n'
                   '    proxy_set_header Authorization "";\n'
                   '    proxy_pass http://127.0.0.1:4177/;\n'
                   '    proxy_http_version 1.1;\n'
                   '    proxy_set_header Host $host;\n'
                   '    proxy_set_header Origin $http_origin;\n'
                   '    proxy_set_header X-Real-IP $remote_addr;\n'
                   '    proxy_set_header X-Forwarded-For "";\n'
                   '    proxy_set_header X-Forwarded-Host "";\n'
                   '    proxy_set_header X-Forwarded-Proto "";\n'
                   '    proxy_set_header Connection "";\n'
                   '    proxy_cookie_path /api/journal /pinkuang-deploy-v4/api/journal;\n'
                   '    proxy_connect_timeout 5s;\n    proxy_read_timeout 30s;\n}\n')
        V4_UNIT.write_text(unit)
        SNIPPET.write_text(snippet)
        command(['systemctl', 'daemon-reload'])
        service_attempted = True
        command(['systemctl', 'start', 'pinkuang-deploy-v4.service'])
        for _ in range(10):
            try:
                check_http('http://127.0.0.1:4177/', 200,
                           (release / 'dist/index.html').read_bytes())
                check_http('http://127.0.0.1:4177/deployment-artifacts.json', 200,
                           (release / 'dist/deployment-artifacts.json').read_bytes())
                check_http('http://127.0.0.1:4177/api/journal/build', 401)
                check_http('http://127.0.0.1:4177/api/journal/product-graph', 503)
                check_http('http://127.0.0.1:4177/api/journal/authority-relay/status', 503)
                check_http('http://127.0.0.1:4177/upgrade.html', 404)
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('v4 loopback health checks failed.')
        pid = int(subprocess.check_output(['systemctl', 'show', '--property=MainPID',
                                           '--value', 'pinkuang-deploy-v4.service'], text=True).strip())
        require(pid > 0, 'v4 service has no running process.')
        variables = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        require(not any(item.startswith(b'CREDENTIALS_DIRECTORY=') or item.startswith(b'KEEPER_PRIVATE_KEY=')
                        for item in variables), 'The public v4 process received a Gas credential.')
        require(digest(SITE) == args.site_sha256, 'Site config changed during staging.')
        candidate_site = original_site.replace(ANCHOR, ANCHOR + INCLUDE)
        write_atomic(SITE, candidate_site)
        site_changed = True
        command(['nginx', '-t'])
        command(['systemctl', 'reload', 'nginx'])
        for _ in range(10):
            try:
                check_https('/pinkuang-deploy-v4/', 401)
                check_https('/pinkuang-deploy-v4/deployment-artifacts.json', 401)
                check_https('/pinkuang-deploy-v4/api/journal/build', 401)
                check_https('/pinkuang-deploy-v4/upgrade.html', 401)
                check_https('/bemine-v4/', 404)
                check_https('/bemine-v2/', 200)
                break
            except Exception:
                time.sleep(1)
        else:
            raise RuntimeError('v4 HTTPS, legacy-site or dark-product health checks failed.')
        command(['systemctl', 'enable', 'pinkuang-deploy-v4.service'])
        # Real local TLS/SNI and the preserved v2 route passed above.
        print(f'ACTIVE v4 console release={args.release_id} archive_sha256={args.archive_sha256}')
        print(f'index_sha256={digest(release / "dist/index.html")} artifact_sha256={digest(release / "dist/deployment-artifacts.json")}')
        print(f'unit_sha256={digest(V4_UNIT)} site_sha256={digest(SITE)}')
    except Exception:
        if site_changed and SITE.read_text() == candidate_site:
            write_atomic(SITE, original_site)
            command(['nginx', '-t'])
            command(['systemctl', 'reload', 'nginx'])
        if service_attempted:
            subprocess.run(['systemctl', 'stop', 'pinkuang-deploy-v4.service'],
                           capture_output=True, timeout=30)
            subprocess.run(['systemctl', 'disable', 'pinkuang-deploy-v4.service'],
                           capture_output=True, timeout=30)
        if 'unit' in locals() and V4_UNIT.exists() and V4_UNIT.read_text() == unit:
            V4_UNIT.unlink()
        if 'snippet' in locals() and SNIPPET.exists() and SNIPPET.read_text() == snippet:
            SNIPPET.unlink()
        subprocess.run(['systemctl', 'daemon-reload'], capture_output=True, timeout=30)
        raise


if __name__ == '__main__':
    main()
