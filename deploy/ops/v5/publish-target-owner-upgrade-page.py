#!/usr/bin/env python3
"""Publish one separately pinned upgrade entry; preserve the product and workers.

Run on the existing host with a reviewed input directory containing static.tgz,
publication-pins.json and pinkuang-target-owner-upgrade.conf. No chain writes.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ENTRY = '/pinkuang-target-owner-upgrade/'
SITE = 'https://bemine.cc.cd'
ROOT = Path('/srv/pinkuang-target-owner-upgrade')
CONFIG = Path('/etc/nginx/sites-available/bemine-v4-domain')
CONFIG_SHA = 'c7c8ca884a8b1be3136e7c8f3351e2aea0fee9e86664195c5f10f201613a19ec'
SNIPPET = Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf')
PRODUCT = Path('/var/www/bemine-v5/current')
PRODUCT_RELEASE = Path('/var/www/bemine-v5/releases/formal-funding-linkage-7dcee3c37a75')
PINNED_ROOTS = {
    'trustedGenesisRecordDigest': '0x4aeef3a06351f9dc6b18a85c4a8e34899792bebb38886e0d050bbf3695e41d00',
    'trustedGenesisManifestDigest': '0x3870f0f8c06092b6418c2bd2ab522414ee4091bb937215b6ea97f4283bd25196',
    'trustedGenesisArtifactDigest': '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927',
    'trustedUpgradeArtifactDigest': '0xc9be5208ec97a0513d29c5f1d35a9e89f54c998b5994d2a291c09e5e496881e5',
    'trustedReviewCatalogDigest': '0x01ff90f9a074a6faeb71c452bd8ad36fc0989b143f68fe5240c4d6ece0c538ba',
}
UNITS = ('pinkuang-index-v5', 'pinkuang-product-v5', 'pinkuang-v5-purchase',
         'pinkuang-v5-mining', 'pinkuang-v5-signer', 'pinkuang-v5-price')

def need(condition, message):
    if not condition:
        raise RuntimeError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def command(*args):
    return subprocess.check_output(args, text=True, timeout=20)

def processes():
    result = {}
    for unit in UNITS:
        fields = dict(line.split('=', 1) for line in command('systemctl', 'show', unit,
                      '--property=ActiveState,SubState,InvocationID,NRestarts').splitlines())
        need(fields.get('ActiveState') == 'active' and fields.get('SubState') == 'running', f'{unit} not running')
        result[unit] = fields
    return result

def public(path, data=None):
    headers = {'Cache-Control': 'no-cache'}
    if data is not None:
        headers.update({'Content-Type': 'application/json', 'Origin': SITE})
    with urllib.request.urlopen(urllib.request.Request(SITE + path, data=data, headers=headers), timeout=30) as response:
        need(response.status == 200, f'Public response failed: {path}')
        return response.read()

def wait_entry(expected):
    # nginx reload acknowledges the signal before new workers have loaded it.
    deadline = time.monotonic() + 15
    while True:
        try:
            need(sha(public(ENTRY)) == expected, 'Public entry hash differs')
            return
        except urllib.error.HTTPError as error:
            if error.code not in (404, 503) or time.monotonic() >= deadline:
                raise
            time.sleep(0.3)

def validate_archive(source, pins):
    archive = source / 'static.tgz'
    need(archive.stat().st_size == pins['archiveBytes'] and sha(archive.read_bytes()) == pins['archiveSha256'], 'Archive pin differs')
    with tarfile.open(archive, 'r:gz') as tar:
        members = tar.getmembers()
        need(8 <= len(members) <= 20, 'Unexpected archive member count')
        names = set()
        total = 0
        for member in members:
            name = member.name
            need(member.isfile() and not member.issym() and not member.islnk(), 'Archive must contain only files')
            need(not PurePosixPath(name).is_absolute() and '..' not in PurePosixPath(name).parts
                 and name not in names, 'Unsafe or duplicate archive path')
            need(name in ('index.html', 'static-release-manifest.json') or re.fullmatch(r'assets/[\w.-]+\.(js|css)', name)
                 or re.fullmatch(r'data/(genesisRecord|genesisBundle|trustedGenesisManifest|upgradeBundle|reviewCatalog|gasEvidence|liveReview)\.json', name), 'Unexpected public file')
            names.add(name); total += member.size
        need(total <= 16_000_000, 'Public package exceeds reviewed bound')
        raw = tar.extractfile('static-release-manifest.json').read()
        need(sha(raw) == pins['manifestSha256'], 'Manifest pin differs')
        manifest = json.loads(raw)
        need(manifest['kind'] == 'target-owner-upgrade-static-package-v1' and manifest['entryPath'] == ENTRY
             and manifest['pins'] == PINNED_ROOTS and manifest['sourceCommit'] == pins['sourceCommit']
             and manifest['chainActionsPerformed'] is False and manifest['deployedOrActivated'] is False, 'Package identity differs')
        need(names == set(manifest['files']) | {'static-release-manifest.json'}, 'Inventory differs')
        for name, expected in manifest['files'].items():
            body = tar.extractfile(name).read()
            need(len(body) == expected['bytes'] and sha(body) == expected['sha256'], f'File pin differs: {name}')
    return manifest

def main():
    need(len(sys.argv) == 2, 'Usage: publisher /absolute/reviewed-input')
    source = Path(sys.argv[1]).resolve(strict=True)
    pins = json.loads((source / 'publication-pins.json').read_text())
    need(re.fullmatch(r'[0-9a-f]{40}', pins['sourceCommit']) is not None, 'Source commit missing')
    manifest = validate_archive(source, pins)
    conf = (source / SNIPPET.name).read_bytes()
    need(sha(conf) == pins['nginxSnippetSha256'], 'Snippet pin differs')
    old_config = CONFIG.read_bytes()
    need(sha(old_config) == CONFIG_SHA and not SNIPPET.exists()
         and not (ROOT / 'current').exists() and not (ROOT / 'current').is_symlink(), 'Entry or nginx baseline changed')
    need(PRODUCT.is_symlink() and PRODUCT.resolve(strict=True) == PRODUCT_RELEASE, 'Product release changed')
    product_html = public('/')
    before = processes()
    backup = source / 'bemine-domain-before.conf'
    if backup.exists():
        need(backup.read_bytes() == old_config, 'Backup differs from pinned baseline')
    else:
        backup.write_bytes(old_config)
    new_config = old_config.replace(b'    include /etc/nginx/snippets/pinkuang-upgrade-v5.conf;\n',
        b'    include /etc/nginx/snippets/pinkuang-upgrade-v5.conf;\n    include /etc/nginx/snippets/pinkuang-target-owner-upgrade.conf;\n')
    need(new_config != old_config and new_config.count(b'include /etc/nginx/snippets/pinkuang-target-owner-upgrade.conf;') == 1, 'Unique HTTPS include missing')
    dest = ROOT / 'releases' / pins['sourceCommit']
    if dest.exists():
        # An unsuccessful publication leaves a recoverable, immutable stage.
        need(not dest.is_symlink(), 'Release is a symlink')
        found = {str(path.relative_to(dest)) for path in dest.rglob('*') if path.is_file()}
        need(found == set(manifest['files']) | {'static-release-manifest.json'}, 'Recovered stage inventory differs')
        for name, expected in manifest['files'].items():
            path = dest / name
            need(not path.is_symlink() and sha(path.read_bytes()) == expected['sha256'], 'Recovered stage content differs')
        need(sha((dest / 'static-release-manifest.json').read_bytes()) == pins['manifestSha256'], 'Recovered manifest differs')
    else:
        dest.mkdir(parents=True)
        with tarfile.open(source / 'static.tgz', 'r:gz') as tar:
            tar.extractall(dest, filter='data')
    for path in [dest, *dest.rglob('*')]:
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
    current = ROOT / 'current'
    current.symlink_to(dest)
    changed = False
    try:
        SNIPPET.write_bytes(conf)
        CONFIG.write_bytes(new_config); changed = True
        command('nginx', '-t')
        command('systemctl', 'reload', 'nginx')
        wait_entry(manifest['files']['index.html']['sha256'])
        for name, expected in manifest['files'].items():
            served = public(ENTRY + ('' if name == 'index.html' else name))
            need(sha(served) == expected['sha256'], f'Public hash differs: {name}')
        need(public(ENTRY + 'static-release-manifest.json') == (dest / 'static-release-manifest.json').read_bytes(), 'Public manifest differs')
        rpc = json.loads(public(ENTRY + 'api/rpc', json.dumps({'jsonrpc':'2.0','id':1,'method':'eth_chainId','params':[]}).encode()))
        need(rpc.get('result') == '0x38' and 'error' not in rpc, 'Read-only RPC chain differs')
        need(public('/') == product_html and PRODUCT.resolve(strict=True) == PRODUCT_RELEASE, 'Product changed')
        need(processes() == before, 'Worker process identity changed')
    except Exception:
        if changed:
            CONFIG.write_bytes(old_config)
        if SNIPPET.exists() and SNIPPET.read_bytes() == conf:
            SNIPPET.unlink()
        command('nginx', '-t'); command('systemctl', 'reload', 'nginx')
        if current.is_symlink() and current.resolve() == dest:
            current.unlink()
        raise
    receipt = {'schemaVersion':1, 'publishedAt':datetime.now(timezone.utc).isoformat(), 'url':SITE+ENTRY,
               'releaseDirectory':str(dest), 'sourceCommit':pins['sourceCommit'], 'pins':PINNED_ROOTS,
               'fileCount':len(manifest['files']), 'manifestSha256':pins['manifestSha256'],
               'nginxConfigBeforeSha256':sha(old_config), 'nginxConfigAfterSha256':sha(new_config),
               'productHtmlSha256':sha(product_html), 'productUnchanged':True, 'workersUnchanged':True,
               'rpcChainId':56, 'chainActionsPerformed':False, 'codeUpgradeComplete':False}
    (source / 'publication.json').write_text(json.dumps(receipt, indent=2)+'\n')
    print(json.dumps(receipt))

if __name__ == '__main__':
    main()
