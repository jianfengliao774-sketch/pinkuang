#!/usr/bin/env python3
"""Publish the installed v5 release only after its live read surfaces are ready."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
import subprocess
import time
import urllib.request

SOURCE = 'dea3a78b51352df45771ce6d54043b874e70383e'
RELEASE = 'v5-product-' + SOURCE[:12]
UPLOAD = Path('/root/bemine-v5-upload')
STATIC = Path('/var/www/bemine-v5/releases') / RELEASE
CURRENT = Path('/var/www/bemine-v5/current')
CONFIG = Path('/etc/nginx/sites-available/bemine-v4-domain')
SNIPPET = Path('/etc/nginx/snippets/bemine-v5-product.conf')
FACTORY = '0x4a866e14816d8339a530c6c82300dbbb6544b37c'
UNITS = ['pinkuang-index-v5', 'pinkuang-product-v5', 'pinkuang-v5-purchase',
         'pinkuang-v5-mining', 'pinkuang-v5-signer', 'pinkuang-v5-price']

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def read_json(port, path, timeout=45):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=timeout) as response:
        assert response.status == 200
        return json.load(response)

def local_http(host, path):
    result = run('curl', '--silent', '--show-error', '--connect-timeout', '5',
                 '--max-time', '45', '--resolve', f'{host}:443:127.0.0.1',
                 '-w', '\n%{http_code}', f'https://{host}{path}')
    body, status = result.rsplit('\n', 1)
    return int(status), body

assert os.getuid() == 0
assert not CURRENT.exists() and not CURRENT.is_symlink(), 'Already published; use the update procedure.'
assert not SNIPPET.exists(), 'Existing snippet must not be overwritten.'
manifest = json.loads((STATIC / 'fresh-product-release.json').read_text())
assert manifest['frontendSourceHead'] == SOURCE and manifest['basePath'] == '/bemine-v5'
assert manifest['factory'].lower() == FACTORY
for unit in UNITS:
    assert run('systemctl', 'is-active', unit).strip() == 'active', unit

index = read_json(4224, '/health')['source']
assert index['complete'] and not index.get('unknownReason'), 'Index is not caught up.'
assert index['factory'].lower() == FACTORY and index['chainId'] == 56
assert index['indexedThrough'] == index['observedSafeHead']
assert 0 <= time.time() - index['indexedTimestamp'] < 90
stats = read_json(4224, '/v1/display/stats')
pools = read_json(4224, '/v1/display/pools')
assert stats.get('data') is not None and pools.get('data') is not None
graph = read_json(4227, '/api/journal/product-graph')
assert graph['factory'].lower() == FACTORY and graph['stage'] == 'fresh-active'
assert graph['freshFactoryVerified'] and graph['operationalReady'] and not graph.get('stale')

before = CONFIG.read_text()
old_root = 'location = / { return 308 /bemine-v4/; }'
assert before.count(old_root) == 1
anchor = 'include /etc/nginx/snippets/bemine-retired-paused.conf;'
assert before.count(anchor) == 1
after = before.replace(old_root, 'location = / { return 308 /bemine-v5/; }').replace(
    anchor, anchor + '\n    include /etc/nginx/snippets/bemine-v5-product.conf;')
stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/root/bemine-v5-publish-' + stamp)
backup.mkdir(mode=0o700)
shutil.copyfile(CONFIG, backup / 'nginx-before.conf')
published = False
try:
    shutil.copyfile(UPLOAD / 'runtime/nginx.conf', SNIPPET)
    SNIPPET.chmod(0o644)
    CURRENT.symlink_to(STATIC, target_is_directory=True)
    CONFIG.write_text(after)
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')
    checks = {}
    for host, path, expected in [
        ('bemine.cc.cd', '/bemine-v5/', 200),
        ('bemine.cc.cd', '/bemine-v5/fresh-product-release.json', 200),
        ('bemine.cc.cd', '/bemine-v5/api/chain-index/v1/display/stats', 200),
        ('bemine.cc.cd', '/bemine-v5/data/bem-price.json', 200),
        ('bemine.cc.cd', '/bemine-v4/', 503),
        ('tapeout.cc.cd', '/bemine-full-test/', 503),
        ('tapeout.cc.cd', '/pinkuang-deploy-v5/', 200),
    ]:
        # A graceful nginx reload returns before the new workers accept requests.
        # Allow that bounded transition, while retaining rollback on a real failure.
        for attempt in range(15):
            status, body = local_http(host, path)
            if status == expected:
                break
            time.sleep(1)
        checks[host + path] = status
        assert status == expected, (host, path, status)
        if path.endswith('/fresh-product-release.json'):
            assert json.loads(body)['frontendSourceHead'] == SOURCE
    published = True
    receipt = {
        'schemaVersion': 1, 'status': 'published', 'checkedAt': datetime.now(timezone.utc).isoformat(),
        'websitePublished': True, 'servicesInstalled': True,
        'publicUrl': 'https://bemine.cc.cd/bemine-v5/', 'runtimeSourceHead': SOURCE,
        'factory': graph['factory'], 'authority': graph['freshAuthority']['address'],
        'artifactDigest': graph['artifactDigest'], 'operationalReady': True,
        'index': index, 'httpChecks': checks, 'units': UNITS,
        'nginxBeforeSha256': hashlib.sha256(before.encode()).hexdigest(),
        'nginxAfterSha256': hashlib.sha256(after.encode()).hexdigest(),
    }
    (UPLOAD / 'publication-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
finally:
    if not published:
        CONFIG.write_text(before)
        if CURRENT.is_symlink() and CURRENT.resolve() == STATIC:
            CURRENT.unlink()
        if SNIPPET.exists():
            SNIPPET.unlink()
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
