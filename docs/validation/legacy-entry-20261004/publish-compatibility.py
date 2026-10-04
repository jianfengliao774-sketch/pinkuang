#!/usr/bin/env python3
"""CAS install fixed-origin exact public v5 aliases on TapeOut, no API proxy.

Only nginx is reloaded after nginx -t. Every business service and every current
product/upgrade byte remains unchanged. --rollback removes this exact overlay.
"""
from datetime import datetime, timezone
import argparse
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import re
import stat
import subprocess
import time
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_base', HERE / 'publish.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
CONFIG = Path('/etc/nginx/sites-available/bem2075')
SNIPPET = Path('/etc/nginx/snippets/bemine-v5-legacy-public-entry.conf')
OLD_CONFIG_SHA = 'f3982df8d56f562c462cf5fd9663431c46e3523891c99c73254cdca97bf81eff'
ANCHOR = b'    include /etc/nginx/snippets/bemine-retired-paused.conf;'
INCLUDE = b'\n    include /etc/nginx/snippets/bemine-v5-legacy-public-entry.conf;'
FORBIDDEN = ['/bemine-v5/api', '/bemine-v5/api/rpc', '/bemine-v5/api/journal/session',
             '/bemine-v5/firsto-api', '/bemine-v5/firsto-api/order',
             '/bemine-v5/share/unknown-poster.html', '/bemine-v5/not-a-real-document']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


def fetch_redirect(path):
    request = urllib.request.Request('https://tapeout.cc.cd' + path, headers={'Cache-Control': 'no-cache'})
    try:
        response = urllib.request.build_opener(NoRedirect()).open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        return {'url': request.full_url, 'status': response.status,
                'location': response.headers.get('Location'), 'sha256': base.sha(body)}


def wait_for_reload(aliases, rollback=False):
    """A successful reload command precedes the new worker accepting traffic."""
    path, destination = aliases[0]
    attempts = []
    for attempt in range(12):
        row = fetch_redirect(path + '?lang=zh&entry=compatibility')
        attempts.append(row)
        expected = row['status'] == 404 and not row['location'] if rollback else (
            row['status'] == 308 and row['location'] == destination + '?lang=zh&entry=compatibility')
        if expected:
            return attempts
        if attempt != 11:
            time.sleep(0.25)
    (HERE / 'compatibility-readiness-failure.json').write_text(json.dumps(attempts, indent=2) + '\n')
    raise RuntimeError('Fixed-origin public redirect proof failed after reload: ' + json.dumps(attempts[-1]))


def identities():
    value = base.invariants()
    root = Path('/var/www/bemine-v5/current')
    value['files']['current-product-all-files'] = {
        'resolved': str(root.resolve()),
        'files': {str(path.relative_to(root)): base.sha(path.read_bytes())
                  for path in sorted(root.rglob('*')) if path.is_file()}}
    value['files']['maintenance-page'] = {'sha256': base.sha(base.TARGET.read_bytes())}
    pid = value['services']['nginx']['MainPID']
    workers = subprocess.check_output(['ps', '--ppid', pid, '-o', 'pid='], text=True).split()
    return value, workers


def exact_aliases(snippet):
    text = snippet.decode('utf-8')
    aliases = re.findall(r'^location = (\S+) \{ return 308 (\S+)\$is_args\$args; \}$', text, re.M)
    if len(aliases) != 60 or any(not target.startswith('https://bemine.cc.cd/') for _, target in aliases):
        raise RuntimeError('Expected 60 fixed-origin exact document aliases')
    if re.search(r'(proxy_pass|rewrite|\$arg_|\$host|\$request_uri)', text):
        raise RuntimeError('No user-controlled domain, general rewrite or API proxy allowed')
    for path, _ in aliases:
        relative = path[len('/bemine-v5'):].strip('/')
        if relative in ['', 'index.html']:
            continue
        file = relative if relative.endswith('.html') else relative + '.html'
        if not (Path('/var/www/bemine-v5/current') / file).is_file():
            raise RuntimeError('Alias does not identify a current public HTML file: ' + path)
        if any(part in path for part in ['/api', '/firsto-api', 'upgrade', 'deploy']):
            raise RuntimeError('Administrative/API routes are outside the public aliases')
    return aliases


def protected_roots(before):
    rows = []
    for url, key in [
        ('https://bemine.cc.cd/', '/var/www/bemine-v5/current/index.html'),
        ('https://bemine.cc.cd/live', '/var/www/bemine-v5/current/live.html'),
        ('https://bemine.cc.cd/pinkuang-target-owner-upgrade/', 'upgrade-directory'),
    ]:
        status, _, body = base.fetch(url)
        expected = before['files'][key]['files']['index.html'] if key == 'upgrade-directory' else before['files'][key]['sha256']
        if status != 200 or base.sha(body) != expected:
            raise RuntimeError('Protected public page changed: ' + url)
        rows.append({'url': url, 'status': status, 'sha256': base.sha(body)})
    spark_status, _, _ = base.fetch('https://tapeout.cc.cd/')
    if spark_status != 200:
        raise RuntimeError('Unrelated TapeOut root is unavailable')
    rows.append({'url': 'https://tapeout.cc.cd/', 'status': spark_status})
    for host in base.HOSTS:
        for path in ['/bemine/?lang=zh', '/bemine-v4/', '/bemine-full-test/']:
            status, headers, body = base.fetch(host + path)
            if status != 503 or base.sha(body) != base.EXPECTED_NEW or 'no-store' not in headers.get('Cache-Control', ''):
                raise RuntimeError('Retired asset site must remain paused: ' + host + path)
            rows.append({'url': host + path, 'status': status, 'sha256': base.sha(body)})
    return rows


def business_unchanged(before, after):
    if before['files'] != after['files']:
        raise RuntimeError('A protected product/deployment file changed')
    for name, state in before['services'].items():
        if name != 'nginx' and state != after['services'][name]:
            raise RuntimeError('Business service identity changed: ' + name)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    snippet = (HERE / 'bemine-v5-legacy-public-entry.conf').read_bytes()
    aliases = exact_aliases(snippet)
    current = CONFIG.read_bytes()
    backup = HERE / 'bem2075.before-public-alias.conf'
    if CONFIG.is_symlink():
        raise RuntimeError('Expected regular canonical nginx configuration file')
    if args.rollback:
        previous = backup.read_bytes()
        desired = previous
        expected_current = base.sha(previous.replace(ANCHOR, ANCHOR + INCLUDE))
        if base.sha(previous) != OLD_CONFIG_SHA or SNIPPET.read_bytes() != snippet:
            raise RuntimeError('Rollback backup/snippet identity mismatch')
    else:
        if SNIPPET.exists() or base.sha(current) != OLD_CONFIG_SHA or current.count(ANCHOR) != 1:
            raise RuntimeError('Nginx exact-byte CAS or unused snippet identity mismatch')
        previous = current
        desired = current.replace(ANCHOR, ANCHOR + INCLUDE)
        expected_current = OLD_CONFIG_SHA
    if base.sha(current) != expected_current:
        raise RuntimeError('Concurrent nginx config edit: CAS refused')
    before, workers_before = identities()
    roots_before = protected_roots(before)
    if not args.rollback:
        if backup.exists() and backup.read_bytes() != current:
            raise RuntimeError('Nginx backup conflicts')
        backup.write_bytes(current); backup.chmod(0o600)
    snapshot, _ = identities()
    business_unchanged(before, snapshot)
    if CONFIG.read_bytes() != current:
        raise RuntimeError('Nginx configuration changed before switch')
    mode = stat.S_IMODE(CONFIG.stat().st_mode)
    if not args.rollback:
        base.atomic_write(SNIPPET, snippet, 0o644)
    base.atomic_write(CONFIG, desired, mode)
    reloaded = False
    try:
        subprocess.run(['nginx', '-t'], check=True, capture_output=True, text=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True, text=True)
        reloaded = True
        readiness = wait_for_reload(aliases, args.rollback)
        with ThreadPoolExecutor(max_workers=4) as pool:
            routes = list(pool.map(fetch_redirect, [path + '?lang=zh&entry=compatibility' for path, _ in aliases]))
            forbidden = list(pool.map(fetch_redirect, FORBIDDEN))
        for row, (_, destination) in zip(routes, aliases):
            if args.rollback:
                if row['status'] != 404 or row['location']:
                    raise RuntimeError('Rollback left a public alias active')
            elif row['status'] != 308 or row['location'] != destination + '?lang=zh&entry=compatibility':
                (HERE / 'compatibility-public-failure.json').write_text(json.dumps(row, indent=2) + '\n')
                raise RuntimeError('Fixed-origin public redirect proof failed: ' + json.dumps(row))
        if any(row['status'] != 404 or row['location'] for row in forbidden):
            raise RuntimeError('API or unknown document gained a public redirect')
        roots_after = protected_roots(before)
        after, workers_after = identities()
        business_unchanged(before, after)
        if args.rollback:
            if SNIPPET.read_bytes() != snippet:
                raise RuntimeError('Snippet changed before rollback cleanup')
            SNIPPET.unlink()
        result = {'publishedAt': datetime.now(timezone.utc).isoformat(), 'rollback': args.rollback,
                  'nginxReloaded': True, 'businessServicesRestarted': False,
                  'allProductAndUpgradeFilesUnchanged': True, 'businessServiceIdentitiesUnchanged': True,
                  'nginxMasterBefore': before['services']['nginx'], 'nginxMasterAfter': after['services']['nginx'],
                  'nginxWorkerPidsBefore': workers_before, 'nginxWorkerPidsAfter': workers_after,
                  'configurationBeforeSha256': base.sha(current), 'configurationAfterSha256': base.sha(desired),
                  'snippetSha256': base.sha(snippet), 'publicAliases': routes, 'apiAndUnknownDocuments': forbidden,
                  'reloadReadinessAttempts': readiness,
                  'protectedPublicBefore': roots_before, 'protectedPublicAfter': roots_after}
        (HERE / ('compatibility-rollback.json' if args.rollback else 'compatibility-publication.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({key: value for key, value in result.items() if key not in ['publicAliases', 'apiAndUnknownDocuments', 'protectedPublicBefore', 'protectedPublicAfter', 'nginxMasterBefore', 'nginxMasterAfter']}))
    except Exception:
        if CONFIG.read_bytes() != desired or SNIPPET.read_bytes() != snippet:
            raise RuntimeError('Concurrent nginx edit: automatic rollback refused')
        base.atomic_write(CONFIG, current, mode)
        if not args.rollback:
            SNIPPET.unlink()
        subprocess.run(['nginx', '-t'], check=True, capture_output=True, text=True)
        if reloaded:
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True, text=True)
        raise


if __name__ == '__main__':
    main()
