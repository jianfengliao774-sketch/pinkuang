"""Replace only the standalone upgrade UI; preserve candidates and services."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
from datetime import datetime, timezone

ROOT = Path('/srv/pinkuang-target-owner-upgrade')
INPUT = Path('/root/bemine-upgrade-legacy-resume-20261004')
OLD_HEAD = '3b09f155789c83859de384e3d3d243dc2a561b4d'
OLD_MANIFEST_HASH = '08e42edcefb0350b644f072fee1d5b1716c4d4be6ce221aed2c0697bbf19587e'
BASE = 'https://bemine.cc.cd/pinkuang-target-owner-upgrade/'
UNITS = ['pinkuang-index-v5', 'pinkuang-product-v5', 'pinkuang-v5-purchase',
         'pinkuang-v5-mining', 'pinkuang-v5-signer', 'pinkuang-v5-price', 'pinkuang-deploy-latest', 'pinkuang-deploy-v5', 'nginx']


def need(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def get(url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        need(response.status == 200, 'Public resource unavailable: ' + url)
        return response.read()


def services():
    result = {}
    for unit in UNITS:
        body = subprocess.check_output(['systemctl', 'show', unit,
            '--property=ActiveState,SubState,InvocationID,NRestarts'], text=True, timeout=12)
        item = dict(line.split('=', 1) for line in body.splitlines())
        need(item.get('ActiveState') == 'active' and item.get('SubState') == 'running',
             'Service is not running: ' + unit)
        result[unit] = item
    return result


def nginx_hash():
    # Keep the configuration private; record only its fingerprint.
    return sha(subprocess.check_output(['nginx', '-T'], stderr=subprocess.DEVNULL, timeout=15))


def check_files(directory, manifest):
    for name, expected in manifest['files'].items():
        path = directory / name
        need(path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(directory.resolve()),
             'Missing or unsafe static input: ' + name)
        data = path.read_bytes()
        need(len(data) == expected['bytes'] and sha(data) == expected['sha256'],
             'Static file differs from manifest: ' + name)


def main():
    need(os.geteuid() == 0, 'Run on the formal web host')
    pins = json.loads((INPUT / 'publication-pins.json').read_text())
    head = pins['sourceCommit']
    need(isinstance(head, str) and len(head) == 40 and all(c in '0123456789abcdef' for c in head)
         and head != OLD_HEAD, 'Invalid new source commit')
    archive = (INPUT / 'static.tgz').read_bytes()
    need(len(archive) == pins['archiveBytes'] and sha(archive) == pins['archiveSha256'], 'Archive differs')
    current = ROOT / 'current'
    old = (ROOT / 'releases' / OLD_HEAD).resolve(strict=True)
    need(current.is_symlink() and current.resolve(strict=True) == old, 'Current upgrade page changed')
    old_bytes = (old / 'static-release-manifest.json').read_bytes()
    need(sha(old_bytes) == OLD_MANIFEST_HASH, 'Previous manifest changed')
    prior = json.loads(old_bytes)
    check_files(old, prior)
    need(get(BASE + 'static-release-manifest.json') == old_bytes and get(BASE) == (old / 'index.html').read_bytes(),
         'Public upgrade page differs from pinned baseline')
    before = services()
    config_before = nginx_hash()
    product_before = get('https://bemine.cc.cd/')
    dest = ROOT / 'releases' / head
    need(not dest.exists() and not dest.is_symlink(), 'Candidate directory exists')
    with tarfile.open(INPUT / 'static.tgz', 'r:gz') as bundle:
        entries = bundle.getmembers()
        names = set()
        for entry in entries:
            path = Path(entry.name)
            need(entry.isfile() and not path.is_absolute() and '..' not in path.parts
                 and path.as_posix() == entry.name and '\\' not in entry.name
                 and entry.name not in names, 'Unsafe archive member')
            names.add(entry.name)
        need('static-release-manifest.json' in names, 'Manifest missing')
        manifest_bytes = bundle.extractfile('static-release-manifest.json').read()
        need(sha(manifest_bytes) == pins['manifestSha256'], 'Candidate manifest differs')
        manifest = json.loads(manifest_bytes)
        need(manifest['kind'] == 'target-owner-upgrade-static-package-v1'
             and manifest['sourceCommit'] == head and manifest['chainActionsPerformed'] is False
             and manifest['deployedOrActivated'] is False and manifest['legacyOwnerMigrationIncluded'] is False,
             'Wrong UI-only package identity')
        for field in ['pins', 'gasEvidenceDigest', 'liveReviewEvidenceDigest', 'liveReviewAnchor', 'entryPath']:
            need(manifest.get(field) == prior.get(field), 'Reviewed identity changed: ' + field)
        need(names == set(manifest['files']) | {'static-release-manifest.json'}, 'Unexpected archive files')
        need(set(manifest['files']) == {name for name in names if name != 'static-release-manifest.json'}
             and 'index.html' in manifest['files'], 'Missing UI files')
        for name in names:
            need(name in ['index.html', 'static-release-manifest.json']
                 or name.startswith('assets/') and name.count('/') == 1 and name.endswith(('.js', '.css'))
                 or name in prior['files'] and name.startswith('data/'), 'Unexpected public path: ' + name)
        for name in prior['files']:
            if name.startswith('data/'):
                need(manifest['files'].get(name) == prior['files'][name], 'Reviewed JSON changed: ' + name)
        dest.mkdir(mode=0o755)
        for entry in entries:
            target = dest / entry.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(entry) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
    check_files(dest, manifest)
    retained = []
    for source in (old / 'assets').iterdir():
        need(source.is_file() and not source.is_symlink() and source.suffix in ['.js', '.css'], 'Unexpected old asset')
        name = 'assets/' + source.name
        target = dest / name
        if target.exists():
            need(target.read_bytes() == source.read_bytes(), 'Immutable asset changed')
        else:
            shutil.copyfile(source, target)
            retained.append(name)
    for path in dest.rglob('*'):
        need(not path.is_symlink(), 'Symlink in candidate')
        path.chmod(0o755 if path.is_dir() else 0o644)
    need(current.resolve(strict=True) == old and services() == before and nginx_hash() == config_before,
         'Public state changed during staging')
    switch, rollback = ROOT / '.hash-recovery-upgrade-switch', ROOT / '.hash-recovery-upgrade-rollback'
    need(not switch.exists() and not switch.is_symlink() and not rollback.exists() and not rollback.is_symlink(),
         'A previous switch exists')
    switch.symlink_to(dest)
    os.replace(switch, current)
    try:
        need(get(BASE) == (dest / 'index.html').read_bytes(), 'Public HTML differs')
        need(get(BASE + 'static-release-manifest.json') == manifest_bytes, 'Public manifest differs')
        verified = []
        for name, expected in manifest['files'].items():
            data = get(BASE + name)
            need(len(data) == expected['bytes'] and sha(data) == expected['sha256'], 'Public file differs: ' + name)
            verified.append(name)
        req = urllib.request.Request(BASE + 'api/rpc',
            data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []}).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=20) as response:
            rpc = json.loads(response.read())
        need(rpc.get('id') == 1 and int(rpc.get('result', '0'), 16) == 56, 'Read-only RPC unavailable')
        need(services() == before and nginx_hash() == config_before
             and get('https://bemine.cc.cd/') == product_before, 'Business site or services changed')
        receipt = {'schemaVersion': 1, 'scope': 'standalone upgrade explicit legacy deployment recovery',
            'publishedAt': datetime.now(timezone.utc).isoformat(), 'url': BASE,
            'sourceCommit': head, 'previousSourceCommit': OLD_HEAD, 'releaseDirectory': str(dest),
            'pins': manifest['pins'], 'archiveSha256': pins['archiveSha256'],
            'manifestSha256': sha(manifest_bytes), 'verifiedFiles': verified,
            'retainedImmutableAssets': retained, 'servicesUnchanged': True,
            'productUnchanged': True, 'nginxUnchanged': True, 'readOnlyRpcChainId': 56,
            'chainActionsPerformed': False, 'codeUpgradeComplete': False}
        output = INPUT / 'publication.json'
        temporary = output.with_suffix('.json.tmp')
        temporary.write_text(json.dumps(receipt, indent=2) + '\n')
        os.replace(temporary, output)
    except BaseException:
        need(current.is_symlink() and current.resolve(strict=True) == dest,
             'Public check failed and another publisher changed current; automatic rollback refused')
        rollback.symlink_to(old)
        os.replace(rollback, current)
        raise
    print(json.dumps(receipt, separators=(',', ':')))


if __name__ == '__main__':
    main()
