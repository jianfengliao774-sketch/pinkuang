#!/usr/bin/env python3
"""Replace the one retired-page HTML; no nginx reload or business writes.

Run on the existing server beside bemine-paused.html. --rollback restores only
this publisher's exact previous HTML and refuses a concurrently changed page.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timezone

TARGET = Path('/var/www/bemine-maintenance/bemine-paused.html')
EXPECTED_OLD = 'c51a9dc70cac7e0095e5f1e18eff93bc8736567243a7a06e8f40cf9291635a38'
EXPECTED_NEW = '19a332738b5c0365ec128eadf0e55c5e87dd2a7a12eddc62f83fa0e87b9b491a'
PROTECTED = [
    Path('/var/www/bemine-v5/current/index.html'),
    Path('/var/www/bemine-v5/current/live.html'),
    Path('/etc/nginx/snippets/bemine-retired-paused.conf'),
    Path('/etc/nginx/snippets/bemine-v5-product.conf'),
    Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf'),
]
UNITS = [
    'pinkuang-index-v5', 'pinkuang-product-v5', 'pinkuang-v5-mining',
    'pinkuang-v5-purchase', 'pinkuang-v5-signer', 'pinkuang-v5-price',
    'pinkuang-deploy-v5', 'pinkuang-deploy-latest', 'bem2075-site', 'nginx',
]
HOSTS = ['https://tapeout.cc.cd', 'https://bemine.cc.cd']
RETIRED = ['/bemine/?lang=zh', '/bemine-v4/', '/bemine-full-test/',
           '/bemine-sale-test/', '/bemine-test/', '/bemine-live-test/',
           '/bemine-preview/', '/pinkuang-deploy-v4/', '/pinkuang-upgrade-v4/',
           '/bemine/api/chain-index/v1/display/graph']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, mode):
    fd, name = tempfile.mkstemp(prefix='.paused-entry-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name, mode)
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def invariants():
    files = {str(path): {'resolved': str(path.resolve()), 'sha256': sha(path.read_bytes())}
             for path in PROTECTED}
    upgrade = Path('/srv/pinkuang-target-owner-upgrade/current')
    files['upgrade-directory'] = {'resolved': str(upgrade.resolve()),
        'files': {str(path.relative_to(upgrade)): sha(path.read_bytes())
                  for path in sorted(upgrade.rglob('*')) if path.is_file()}}
    units = {}
    for unit in UNITS:
        output = subprocess.check_output(['systemctl', 'show', unit + '.service',
            '--property=ActiveState,SubState,MainPID,InvocationID,ExecMainStartTimestampMonotonic'], text=True)
        values = dict(line.split('=', 1) for line in output.splitlines())
        if values.get('ActiveState') != 'active' or values.get('MainPID') == '0':
            raise RuntimeError('Expected active service: ' + unit)
        units[unit] = values
    return {'files': files, 'services': units}


def fetch(url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'BEMine-legacy-entry-verification'})
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read()


def verify_page(expected, published):
    results = []
    for host in HOSTS:
        for route in RETIRED:
            status, headers, body = fetch(host + route)
            if status != 503 or sha(body) != expected or 'no-store' not in headers.get('Cache-Control', ''):
                raise RuntimeError('Retired route changed or wrong maintenance body: ' + host + route)
            results.append({'url': host + route, 'status': status, 'sha256': sha(body),
                            'cacheControl': headers.get('Cache-Control')})
    if published:
        status, headers, body = fetch('https://bemine.cc.cd/')
        if status != 200 or sha(body) != sha(PROTECTED[0].read_bytes()):
            raise RuntimeError('Formal product root changed')
        status2, _, body2 = fetch('https://bemine.cc.cd/pinkuang-target-owner-upgrade/')
        if status2 != 200 or sha(body2) != sha(Path('/srv/pinkuang-target-owner-upgrade/current/index.html').read_bytes()):
            raise RuntimeError('Upgrade entry changed')
        spark_status, _, _ = fetch('https://tapeout.cc.cd/')
        if spark_status != 200:
            raise RuntimeError('TapeOut root unavailable')
        results.extend([
            {'url': 'https://bemine.cc.cd/', 'status': status, 'sha256': sha(body)},
            {'url': 'https://bemine.cc.cd/pinkuang-target-owner-upgrade/', 'status': status2, 'sha256': sha(body2)},
            {'url': 'https://tapeout.cc.cd/', 'status': spark_status},
        ])
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    backup = root / 'bemine-paused.before.html'
    old_bytes = TARGET.read_bytes()
    if TARGET.is_symlink():
        raise RuntimeError('Maintenance target must be the expected regular file')
    if args.rollback:
        desired = backup.read_bytes()
        expected_current, expected_desired = EXPECTED_NEW, EXPECTED_OLD
    else:
        desired = (root / 'bemine-paused.html').read_bytes()
        expected_current, expected_desired = EXPECTED_OLD, EXPECTED_NEW
    if sha(old_bytes) != expected_current or sha(desired) != expected_desired:
        raise RuntimeError('Exact maintenance-page compare-and-swap mismatch')
    before = invariants()
    if not args.rollback:
        verify_page(EXPECTED_OLD, False)
        if backup.exists() and backup.read_bytes() != old_bytes:
            raise RuntimeError('Backup conflicts with current maintenance bytes')
        backup.write_bytes(old_bytes)
        os.chmod(backup, 0o600)
        (root / 'before.json').write_text(json.dumps(before, indent=2) + '\n')
    if TARGET.read_bytes() != old_bytes:
        raise RuntimeError('Maintenance page changed before switch')
    if invariants() != before:
        raise RuntimeError('Protected product/deployment/service identity changed before switch')
    mode = stat.S_IMODE(TARGET.stat().st_mode)
    atomic_write(TARGET, desired, mode)
    try:
        routes = verify_page(expected_desired, True)
        after = invariants()
        if after != before:
            raise RuntimeError('Protected product/deployment/service identity changed')
        result = {'publishedAt': datetime.now(timezone.utc).isoformat(),
                  'rollback': args.rollback, 'target': str(TARGET),
                  'oldSha256': expected_current, 'newSha256': expected_desired,
                  'serviceProcessesUnchanged': True, 'productAndUpgradeFilesUnchanged': True,
                  'runtimeRestarted': False, 'retiredRoutesRemainClosed': True,
                  'routes': routes, 'protected': after}
        (root / ('rollback.json' if args.rollback else 'publication.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({key: value for key, value in result.items() if key not in ('routes', 'protected')}))
    except Exception:
        if sha(TARGET.read_bytes()) != expected_desired:
            raise RuntimeError('Verification failed, but target changed: automatic rollback refused')
        atomic_write(TARGET, old_bytes, mode)
        if sha(TARGET.read_bytes()) != expected_current:
            raise RuntimeError('Maintenance-only rollback proof failed')
        raise


if __name__ == '__main__':
    main()
