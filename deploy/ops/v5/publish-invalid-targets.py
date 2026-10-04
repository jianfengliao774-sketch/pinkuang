"""Publish the reviewed V5 invalid-listing display fix, without wallet actions.

Commands: backend|frontend INCOMING --source-head <reviewed 40-char git SHA>.
The two phases share source/inventory pins and locks. Existing databases,
contract manifests, signer/public/purchase/mining services and nginx are not
changed. A failed phase restores only its own index dropin or static symlink.
See input_format() for the exact build-summary.json contract.
"""

import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import html.parser
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request


INDEX_UNIT = 'pinkuang-index-v5'
INDEX_BASE = Path('/srv/pinkuang-v5/releases/v5-target-availability-07041f708b4a')
INDEX_DROPIN = Path('/etc/systemd/system/pinkuang-index-v5.service.d/target-availability.conf')
INDEX_DROPIN_BYTES = ('[Service]\nWorkingDirectory=' + str(INDEX_BASE) + '\n').encode()
WEB_ROOT = Path('/var/www/bemine-v5')
FRONT_BASE = WEB_ROOT / 'releases/operator-speed-ea3b647ac715'
FRONT_HEAD = 'ea3b647ac715618855cdba68491bd22ec58ed581'
FRONT_CONTENT = '6e454784823ae8d8b9474bbf1ea7148a1c920202534fc543dab26035064237f9'
FRONT_RELEASE_SHA = 'e7100d0cf6e92054268c31d990638d168ed86aa2d95f9a079d7209d08fe88d3a'
FRONT_MANIFEST_SHA = 'e0455e6d40c2bc4bd2d471ce4df222e03edfc6be1a0a529c91da6e9433363f97'
SITE = 'https://bemine.cc.cd'
FACTORY = '0xcfc7d864deb615be04c7f6ac62875c2092c5b1b9'
ARTIFACT = '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927'
MANIFEST = '0xc1e46426f96b858013c4485461f265021bf5e4c483be8a1591ad7563dcea112d'
BACKEND_FILES = (
    'server/chain-index/server.mjs',
    'server/chain-index/pool-display-cache.mjs',
    'server/chain-index/target-availability.mjs',
    'server/chain-index/target-listing-evidence.mjs',
    'server/chain-index/overview-stats.mjs',
)
BASE_HASHES = {
    BACKEND_FILES[0]: 'dfe8684a6ee241e38fe27328be19df0709543890928539de6c3eb90e9daece3e',
    BACKEND_FILES[1]: '9bf8d0239e21dd0f2b3290fcc552c2617d646a7f1373fefbeb9de89e672d0e84',
    BACKEND_FILES[2]: '5abb2fcb84df23467dd4cb5ad8f420ff38ccaf3b12c2595df9fc094f5ec76a55',
    BACKEND_FILES[3]: None,
    BACKEND_FILES[4]: '6cbaa4dc73084d58c9f20195fe286e58cfeaf633b489c0c439dd1a3e8c1a44da',
}
MANIFEST_FILES = {
    'public/fresh-product-manifest.json': '7d638c5802a2867f1ca3a3d0ecdbd7281c56d588ae9a65b3f2910e3cf3547338',
    'public/deployment-artifacts.json': '47667cc5be2a649562e04d3915b471ef0b6b210426794dcfa0e34c1cb2bdb2ba',
}
OTHER_UNITS = (
    'pinkuang-product-v5', 'pinkuang-v5-purchase', 'pinkuang-v5-mining',
    'pinkuang-v5-signer', 'pinkuang-v5-price', 'pinkuang-deploy-latest',
    'pinkuang-deploy-v5', 'pinkuang-target-owner-read',
)
KNOWN_TARGETS = {'14281', '14277'}
RELEASE_NAME = 'fresh-product-release.json'
MAX_STATIC_BYTES = 350_000_000


def require(value, message):
    if not value:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def valid_head(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) is not None


def stamp():
    return datetime.now(timezone.utc).isoformat()


def input_format():
    """Return documentation rather than permitting caller-supplied base pins."""
    return {
        'schemaVersion': 1, 'sourceHead': '<reviewed git HEAD, 40 lowercase hex>',
        'backend': {'files': {name: '<sha256>' for name in BACKEND_FILES}},
        'frontend': {
            'archive': {'name': 'candidate.tar.gz', 'sha256': '<sha256>', 'bytes': '<integer>'},
            'files': {'<every regular tar member path, including release metadata>': '<sha256>'},
            'releaseManifestSha256': '<sha256 of fresh-product-release.json>',
            'frontendManifestSha256': FRONT_MANIFEST_SHA,
        },
    }


def regular(path, max_bytes=MAX_STATIC_BYTES):
    path = Path(path)
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), f'Not a regular file: {path.name}')
    require(0 <= info.st_size <= max_bytes, f'File too large: {path.name}')
    return path.read_bytes()


def under(root, name):
    """Require exact safe relative spelling and no symlinked parents."""
    require(isinstance(name, str) and name != '' and '\\' not in name and '\0' not in name,
            'Invalid payload path')
    rel = PurePosixPath(name)
    require(not rel.is_absolute() and rel.as_posix() == name and '..' not in rel.parts
            and '.' not in rel.parts and not any(p.startswith('._') or p == '__MACOSX' for p in rel.parts),
            'Unsafe payload path')
    path = root
    for part in rel.parts:
        path = path / part
        require(not path.is_symlink(), 'Payload symlink is forbidden')
    return path


def load_summary(incoming, head, phase):
    require(valid_head(head), 'Invalid reviewed source HEAD')
    require(incoming.is_absolute() and incoming.is_dir() and not incoming.is_symlink(),
            'Incoming must be an absolute regular directory')
    raw = regular(incoming / 'build-summary.json', 5_000_000)
    summary = json.loads(raw)
    require(isinstance(summary, dict) and summary.get('schemaVersion') == 1
            and summary.get('sourceHead') == head, 'Summary does not bind the reviewed source HEAD')
    backend = summary.get('backend')
    require(isinstance(backend, dict) and isinstance(backend.get('files'), dict)
            and set(backend['files']) == set(BACKEND_FILES)
            and all(valid_sha(value) for value in backend['files'].values()),
            'Backend payload must contain exactly the five reviewed overlay files')
    if phase == 'frontend':
        front = summary.get('frontend')
        require(isinstance(front, dict) and isinstance(front.get('archive'), dict), 'Frontend pins missing')
        archive = front['archive']
        require(archive.get('name') == 'candidate.tar.gz' and valid_sha(archive.get('sha256'))
                and type(archive.get('bytes')) is int and 0 < archive['bytes'] <= MAX_STATIC_BYTES,
                'Invalid frontend archive pin')
        require(isinstance(front.get('files'), dict) and 0 < len(front['files']) <= 20_000
                and all(valid_sha(value) for value in front['files'].values()), 'Invalid frontend file inventory')
        for name in front['files']:
            under(incoming, name)
        require(front.get('releaseManifestSha256') == front['files'].get(RELEASE_NAME)
                and front.get('frontendManifestSha256') == FRONT_MANIFEST_SHA
                and front['files'].get('data/frontend-manifest.v5.json') == FRONT_MANIFEST_SHA,
                'Frontend metadata pins differ from the formal contract manifest')
    return summary, sha(raw)


def inventory(root, exclude=(), allow_links=False):
    result = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name in exclude or name == 'node_modules' or name.startswith('node_modules/'):
            continue
        if path.is_symlink():
            require(allow_links, f'Symlink in static release: {name}')
            result[name] = 'symlink:' + os.readlink(path)
        elif path.is_file():
            result[name] = sha(path.read_bytes())
        else:
            require(path.is_dir(), f'Unsupported release file: {name}')
    if allow_links:
        deps = root / 'node_modules'
        require(deps.is_symlink(), 'Runtime dependency tree must remain the pinned symlink')
        result['node_modules'] = 'symlink:' + os.readlink(deps)
    return result


def content_digest(files):
    return sha(''.join(name + '\0' + value + '\n' for name, value in sorted(files.items())).encode())


def atomic_write(path, data, mode=0o600):
    tmp = path.with_name('.' + path.name + '.invalid-targets-' + str(os.getpid()))
    require(not tmp.exists() and not tmp.is_symlink(), 'Atomic write temporary path already exists')
    descriptor = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def save(incoming, name, payload):
    atomic_write(incoming / name, (json.dumps(payload, indent=2, sort_keys=True) + '\n').encode())


def unit(name):
    value = subprocess.check_output([
        'systemctl', 'show', name,
        '--property=ActiveState,SubState,WorkingDirectory,InvocationID,MainPID,ExecMainStartTimestamp,FragmentPath,DropInPaths',
    ], text=True, timeout=15)
    fields = dict(line.split('=', 1) for line in value.splitlines())
    require(fields.get('ActiveState') == 'active' and fields.get('SubState') == 'running', name + ' is unavailable')
    return fields


def others():
    return {name: unit(name) for name in OTHER_UNITS}


def protected(exclude=()):
    paths = set(Path('/etc/nginx').rglob('*'))
    paths.update(Path('/etc/systemd/system').glob('pinkuang*.service'))
    paths.update(Path('/etc/systemd/system').glob('pinkuang*.service.d/*'))
    paths.update([Path('/etc/pinkuang-v5/trusted-product-deployment.json'),
                  Path('/etc/pinkuang-v5/fresh-activation.json')])
    return {str(path): sha(path.read_bytes()) for path in sorted(paths)
            if path.is_file() and path not in exclude}


def upgrade_entry():
    root = Path('/srv/pinkuang-target-owner-upgrade/current').resolve(strict=True)
    return {'path': str(root), 'files': inventory(root)}


@contextmanager
def locks():
    # Existing website publishers and runtime activators already use these paths.
    # Same order as the last formal static publisher prevents lock inversion.
    paths = [WEB_ROOT / '.mobile-ui-release.lock', Path('/run/pinkuang-v5-activation.lock')]
    with ExitStack() as stack:
        for path in paths:
            descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            stream = stack.enter_context(os.fdopen(descriptor, 'a+'))
            require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'Invalid publisher lock path')
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _response, _code, _message, _headers, _new_url):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, expected=200):
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    try:
        response = OPENER.open(req, timeout=8)
    except urllib.error.HTTPError as error:
        if error.code != expected:
            raise
        response = error
    with response:
        require(response.status == expected, 'Public HTTP status mismatch')
        body = response.read(20_000_001)
        require(len(body) <= 20_000_000, 'Public verification response too large')
        return body, response.headers


def pool_proof(payload, now=None):
    now = time.time() if now is None else now
    require(isinstance(payload, dict) and payload.get('source', {}).get('factory', '').lower() == FACTORY,
            'Public Factory identity changed')
    require(payload['source'].get('complete') is True, 'Index is not complete')
    data = payload.get('data', {})
    rows = data.get('items')
    require(isinstance(rows, list) and rows and data.get('nextCursor') is None,
            'Publication proof requires the complete current project page')
    found = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('targetAvailability'), dict),
                'Target display cache not seeded')
        facts = row['targetAvailability']
        require(facts.get('status') in ['available', 'unavailable', 'not_applicable', 'unknown'],
                'Invalid target availability state')
        token = row.get('params', {}).get('circuitId', {})
        token_id = token.get('$bemineBigInt') if isinstance(token, dict) else str(token)
        if token_id not in KNOWN_TARGETS:
            continue
        require(facts.get('purchaseMode') == 'fixed' and facts.get('status') == 'unavailable'
                and facts.get('reason') == 'target_listing_unavailable',
                'Known unavailable fixed target is not delisted')
        evidence = facts.get('listingEvidence', {})
        require(evidence.get('official') == 'absent' and evidence.get('firsto') == 'absent',
                'Known target needs absence evidence from both sources')
        try:
            observed = datetime.fromisoformat(evidence['observedAt'].replace('Z', '+00:00')).timestamp()
            valid_until = datetime.fromisoformat(evidence['validUntil'].replace('Z', '+00:00')).timestamp()
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise RuntimeError('Known target listing evidence has no valid freshness window') from error
        require(observed <= now + 30 and 0 <= now - observed <= 120
                and now < valid_until <= now + 150, 'Known target listing evidence is expired')
        require(token_id not in found, 'Duplicate known target in display proof')
        found[token_id] = {'pool': row.get('pool'), 'targetAvailability': facts}
    require(set(found) == KNOWN_TARGETS, 'Known target project records disappeared')
    return {'source': payload['source'], 'rowCount': len(rows), 'targets': found,
            'statusCounts': {status: sum(row['targetAvailability']['status'] == status for row in rows)
                             for status in ['available', 'unavailable', 'not_applicable', 'unknown']}}


def display_proof(url):
    body, _ = request(url)
    return pool_proof(json.loads(body))


def pinned_frontend():
    current = WEB_ROOT / 'current'
    require(current.is_symlink() and current.resolve(strict=True) == FRONT_BASE,
            'Live frontend no longer matches the reviewed baseline')
    release_raw = regular(FRONT_BASE / RELEASE_NAME)
    require(sha(release_raw) == FRONT_RELEASE_SHA, 'Baseline frontend metadata changed')
    meta = json.loads(release_raw)
    require(meta.get('frontendSourceHead') == FRONT_HEAD and meta.get('runtimeSourceHead') == FRONT_HEAD
            and meta.get('signerSourceHead') == FRONT_HEAD and meta.get('manifestSha256') == MANIFEST
            and meta.get('factory', '').lower() == FACTORY and meta.get('artifactDigest') == ARTIFACT,
            'Baseline frontend contract/runtime binding changed')
    files = inventory(FRONT_BASE, exclude=(RELEASE_NAME,))
    require(content_digest(files) == FRONT_CONTENT and len(files) == meta.get('fileCount'),
            'Baseline frontend content inventory changed')
    require(sha(regular(FRONT_BASE / 'data/frontend-manifest.v5.json')) == FRONT_MANIFEST_SHA,
            'Baseline frontend manifest changed')
    return current, meta, files


def verify_index_files(root, hashes):
    for name, expected in hashes.items():
        path = under(root, name)
        if expected is None:
            require(not path.exists(), 'New listing evidence file already exists in baseline')
        else:
            require(sha(regular(path, 5_000_000)) == expected, 'Index overlay file hash differs: ' + name)


def reload_index():
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
    subprocess.run(['systemctl', 'restart', INDEX_UNIT], check=True, timeout=45)


def restore_index(previous_bytes, destination, restart_attempted):
    expected = ('[Service]\nWorkingDirectory=' + str(destination) + '\n').encode()
    require(regular(INDEX_DROPIN) == expected,
            'Index dropin changed externally; automatic rollback refused')
    atomic_write(INDEX_DROPIN, previous_bytes, 0o644)
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
    if restart_attempted:
        subprocess.run(['systemctl', 'restart', INDEX_UNIT], check=True, timeout=45)
        require(unit(INDEX_UNIT)['WorkingDirectory'] == str(INDEX_BASE), 'Index rollback did not restore baseline')


def publish_backend(incoming, summary, summary_sha):
    head = summary['sourceHead']
    dest = INDEX_BASE.parent / ('v5-invalid-target-' + head[:12])
    require(not dest.exists() and not dest.is_symlink(), 'Index destination already exists; inspect previous attempt')
    require(not (incoming / 'backend-publication.json').exists() and not (incoming / 'backend-before.json').exists(),
            'Backend attempt already recorded; inspect it instead of restarting')
    current, _front_meta, front_files = pinned_frontend()
    before_unit = unit(INDEX_UNIT)
    require(before_unit['WorkingDirectory'] == str(INDEX_BASE), 'Index working directory changed')
    previous_dropin = regular(INDEX_DROPIN)
    require(previous_dropin == INDEX_DROPIN_BYTES, 'Existing target availability dropin differs')
    verify_index_files(INDEX_BASE, BASE_HASHES)
    verify_index_files(INDEX_BASE, MANIFEST_FILES)
    verify_index_files(incoming, summary['backend']['files'])
    prior_inventory = inventory(INDEX_BASE, allow_links=True)
    stable = {'units': others(), 'protected': protected(exclude=(INDEX_DROPIN,)),
              'nginx': unit('nginx'), 'upgrade': upgrade_entry()}
    save(incoming, 'backend-before.json', {'sourceHead': head, 'summarySha256': summary_sha,
         'index': before_unit, 'previousDropin': previous_dropin.decode(), 'indexInventory': prior_inventory,
         'frontend': str(current.resolve()), 'frontendInventory': front_files, 'stable': stable, 'savedAt': stamp()})
    shutil.copytree(INDEX_BASE, dest, symlinks=True)
    for name in BACKEND_FILES:
        target = under(dest, name)
        require(target.parent.is_dir(), 'Overlay parent is missing')
        target.write_bytes(regular(under(incoming, name), 5_000_000))
        target.chmod(0o644)
        subprocess.run(['/usr/bin/node', '--check', str(target)], check=True, timeout=15)
    verify_index_files(dest, summary['backend']['files'])
    verify_index_files(dest, MANIFEST_FILES)
    candidate_inventory = inventory(dest, allow_links=True)
    require({name: value for name, value in candidate_inventory.items() if name not in BACKEND_FILES}
            == {name: value for name, value in prior_inventory.items() if name not in BACKEND_FILES},
            'A nonoverlay runtime file changed')
    # Stage and syntax validation cannot change the live runtime. Recheck before cutover.
    require(regular(incoming / 'build-summary.json', 5_000_000) is not None, 'Summary missing')
    require(sha(regular(incoming / 'build-summary.json', 5_000_000)) == summary_sha, 'Reviewed summary changed')
    require(unit(INDEX_UNIT) == before_unit and regular(INDEX_DROPIN) == previous_dropin,
            'Index baseline changed while staging')
    require(others() == stable['units'] and protected(exclude=(INDEX_DROPIN,)) == stable['protected']
            and unit('nginx') == stable['nginx'] and upgrade_entry() == stable['upgrade'],
            'Another service or protected deployment changed while staging')
    require(current.resolve(strict=True) == FRONT_BASE
            and inventory(FRONT_BASE, exclude=(RELEASE_NAME,)) == front_files,
            'Live frontend changed while staging')
    dropin_written = False
    restart_attempted = False
    try:
        atomic_write(INDEX_DROPIN, ('[Service]\nWorkingDirectory=' + str(dest) + '\n').encode(), 0o644)
        dropin_written = True
        subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
        restart_attempted = True
        subprocess.run(['systemctl', 'restart', INDEX_UNIT], check=True, timeout=45)
        print(json.dumps({'stage': 'index-restarted', 'sourceHead': head}), flush=True)
        deadline = time.monotonic() + 180
        local_proof = None
        while time.monotonic() < deadline:
            try:
                local_proof = display_proof('http://127.0.0.1:4224/v1/display/pools?cursor=0&limit=20')
                break
            except (OSError, ValueError, RuntimeError):
                time.sleep(3)
        require(local_proof is not None, 'New absence evidence did not become fresh within the bounded materialization window')
        public_proof = display_proof(SITE + '/bemine-v5/api/chain-index/v1/display/pools?cursor=0&limit=20')
        after = unit(INDEX_UNIT)
        require(after['WorkingDirectory'] == str(dest), 'Candidate index is not active')
        require(others() == stable['units'] and protected(exclude=(INDEX_DROPIN,)) == stable['protected']
                and unit('nginx') == stable['nginx'] and upgrade_entry() == stable['upgrade'],
                'Another service or protected deployment changed during index cutover')
        require(inventory(INDEX_BASE, allow_links=True) == prior_inventory
                and inventory(dest, allow_links=True) == candidate_inventory,
                'Reviewed runtime files changed during cutover')
        require(current.resolve(strict=True) == FRONT_BASE
                and inventory(FRONT_BASE, exclude=(RELEASE_NAME,)) == front_files,
                'Static frontend changed during index cutover')
        receipt = {'published': True, 'phase': 'backend', 'sourceHead': head,
                   'summarySha256': summary_sha, 'overlayFiles': summary['backend']['files'],
                   'previousIndex': before_unit, 'index': after, 'directory': str(dest),
                   'publishedAt': stamp(), 'stable': stable, 'localProof': local_proof,
                   'publicProof': public_proof, 'contractUpgradeApplied': False,
                   'onlyIndexRestarted': True, 'databasePreserved': True}
        save(incoming, 'backend-publication.json', receipt)
        print(json.dumps({'published': True, 'phase': 'backend', 'sourceHead': head,
                          'directory': str(dest), 'contractUpgradeApplied': False}), flush=True)
    except BaseException:
        if dropin_written:
            restore_index(previous_dropin, dest, restart_attempted)
            save(incoming, 'backend-rollback.json', {'restored': str(INDEX_BASE), 'sourceHead': head, 'at': stamp()})
        raise


def validate_archive(archive, pins):
    data = regular(archive)
    require(len(data) == pins['archive']['bytes'] and sha(data) == pins['archive']['sha256'],
            'Frontend archive size/hash differs from reviewed pins')
    checked = {}
    total = 0
    with tarfile.open(archive, 'r:gz') as entries:
        for member in entries.getmembers():
            require(member.isfile() and member.name not in checked and 0 <= member.size <= 20_000_000,
                    'Archive contains an unsafe, duplicate or oversized member')
            under(Path('/payload-validation-only'), member.name)
            total += member.size
            require(total <= MAX_STATIC_BYTES, 'Expanded static archive too large')
            stream = entries.extractfile(member)
            require(stream is not None, 'Archive member is unreadable')
            with stream:
                body = stream.read(member.size + 1)
            require(len(body) == member.size, 'Archive member size mismatch')
            checked[member.name] = sha(body)
    require(checked == pins['files'], 'Frontend archive inventory differs from reviewed pins')
    require({'index.html', 'live.html', RELEASE_NAME, 'data/frontend-manifest.v5.json'} <= set(checked),
            'Required frontend entrypoints are missing')
    return checked


def extract_archive(archive, destination, expected):
    destination.mkdir(mode=0o755)
    extracted = {}
    with tarfile.open(archive, 'r:gz') as entries:
        for member in entries.getmembers():
            require(member.isfile() and member.name not in extracted and member.name in expected,
                    'Archive member changed after preflight')
            target = under(destination, member.name)
            require(not target.exists(), 'Archive entry collision')
            target.parent.mkdir(parents=True, exist_ok=True)
            with entries.extractfile(member) as source:
                body = source.read(member.size + 1)
            require(len(body) == member.size and sha(body) == expected[member.name],
                    'Archive member changed after preflight')
            target.write_bytes(body)
            extracted[member.name] = sha(body)
    require(extracted == expected and inventory(destination) == expected, 'Extracted static inventory mismatch')


class Scripts(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('src'):
            self.urls.append(dict(attrs)['src'])


def verify_static(dest, metadata):
    manifest, _ = request(SITE + '/bemine-v5/' + RELEASE_NAME)
    require(manifest == metadata, 'Public release metadata differs')
    parser = Scripts()
    checked = {}
    for route, name in [('/', 'index.html'), ('/live', 'live.html')]:
        body, _ = request(SITE + route)
        require(body == regular(dest / name), 'Canonical page bytes differ: ' + route)
        parser.feed(body.decode('utf-8'))
        checked[route] = sha(body)
    for route, expected in [('/bemine-v5/', '/'), ('/bemine-v5/live', '/live')]:
        _, headers = request(SITE + route, 308)
        require(urllib.parse.urljoin(SITE, headers.get('Location', '')) == SITE + expected,
                'Legacy canonical redirect changed')
    served_manifest, _ = request(SITE + '/bemine-v5/data/frontend-manifest.v5.json')
    require(sha(served_manifest) == FRONT_MANIFEST_SHA
            and served_manifest == regular(dest / 'data/frontend-manifest.v5.json'),
            'Public frontend manifest differs')
    require(parser.urls, 'Canonical pages contain no hashed scripts')
    scripts = []
    for url in sorted(set(parser.urls)):
        require(url.startswith('/bemine-v5/_next/static/') and '?' not in url and '#' not in url,
                'Unexpected frontend script URL')
        path = under(dest, url.removeprefix('/bemine-v5/'))
        body, _ = request(SITE + url)
        require(sha(body) == sha(regular(path)), 'Public hashed script differs')
        scripts.append({'url': url, 'sha256': sha(body)})
    return {'pages': checked, 'hashedScripts': scripts, 'canonicalRedirects': True,
            'frontendManifestPreserved': True}


def switch_static(current, destination, temporary):
    require(not temporary.exists() and not temporary.is_symlink(), 'Static switch path exists')
    temporary.symlink_to(destination, target_is_directory=True)
    os.replace(temporary, current)


def restore_static(current, destination, previous, temporary):
    require(current.is_symlink() and current.resolve(strict=True) == destination,
            'Static current changed externally; automatic rollback refused')
    switch_static(current, previous, temporary)


def publish_frontend(incoming, summary, summary_sha):
    head = summary['sourceHead']
    index_dest = INDEX_BASE.parent / ('v5-invalid-target-' + head[:12])
    receipt = json.loads(regular(incoming / 'backend-publication.json', 5_000_000))
    require(receipt.get('published') is True and receipt.get('sourceHead') == head
            and receipt.get('overlayFiles') == summary['backend']['files']
            and receipt.get('directory') == str(index_dest), 'This frontend requires its successful reviewed index overlay')
    require(unit(INDEX_UNIT)['WorkingDirectory'] == str(index_dest), 'Reviewed index overlay is no longer active')
    verify_index_files(index_dest, summary['backend']['files'])
    verify_index_files(index_dest, MANIFEST_FILES)
    require(not (incoming / 'frontend-before.json').exists() and not (incoming / 'frontend-publication.json').exists(),
            'Frontend attempt already recorded; inspect it instead of publishing again')
    current, previous_meta, old_files = pinned_frontend()
    pins = summary['frontend']
    archive = under(incoming, pins['archive']['name'])
    archived = validate_archive(archive, pins)
    dest = WEB_ROOT / ('releases/invalid-target-' + head[:12])
    require(not dest.exists() and not dest.is_symlink(), 'Static destination already exists')
    before_units = {INDEX_UNIT: unit(INDEX_UNIT), **others()}
    before_protected = protected()
    before_upgrade = upgrade_entry()
    before_nginx = unit('nginx')
    save(incoming, 'frontend-before.json', {'sourceHead': head, 'summarySha256': summary_sha,
         'previous': str(FRONT_BASE), 'previousMetadata': previous_meta, 'files': old_files,
         'units': before_units, 'protected': before_protected, 'upgrade': before_upgrade,
         'nginx': before_nginx, 'savedAt': stamp()})
    extract_archive(archive, dest, archived)
    built_meta = json.loads(regular(dest / RELEASE_NAME))
    require(built_meta.get('frontendSourceHead') == head, 'Static candidate does not bind reviewed HEAD')
    for key in ['chainId', 'basePath', 'productFamily', 'publicOrigin', 'manifestSha256', 'artifactDigest',
                'factory', 'portfolioFactory', 'authority', 'gasWallet', 'deployment']:
        require(built_meta.get(key) == previous_meta.get(key), 'Static candidate contract binding changed: ' + key)
    built_files = inventory(dest, exclude=(RELEASE_NAME,))
    require(content_digest(built_files) == built_meta.get('contentSha256')
            and len(built_files) == built_meta.get('fileCount'), 'Candidate metadata does not bind static content')
    require(regular(dest / 'data/frontend-manifest.v5.json')
            == regular(FRONT_BASE / 'data/frontend-manifest.v5.json'), 'Frontend manifest raw bytes changed')
    retained = []
    for name in old_files:
        if not name.startswith('_next/static/'):
            continue
        target = under(dest, name)
        if target.exists():
            require(sha(regular(target)) == old_files[name], 'Immutable static chunk collision')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(under(FRONT_BASE, name), target)
            retained.append(name)
    final_files = inventory(dest, exclude=(RELEASE_NAME,))
    # Keep runtime/signing/machine provenance honest: only the index was changed.
    meta = dict(previous_meta)
    runtime_dirs = dict(previous_meta.get('runtimeServiceDirectories', {}))
    require(runtime_dirs.get(INDEX_UNIT) == str(INDEX_BASE), 'Previous metadata index binding changed')
    runtime_dirs[INDEX_UNIT] = str(index_dest)
    for name, directory in runtime_dirs.items():
        require(name in before_units and before_units[name]['WorkingDirectory'] == directory,
                'Runtime service directory differs from frontend metadata: ' + name)
    meta.update({'sourceCommit': head, 'frontendSourceHead': head, 'previousFrontendSourceHead': FRONT_HEAD,
                 'runtimeServiceDirectories': runtime_dirs, 'indexOverlaySourceHead': head,
                 'indexOverlayDirectory': str(index_dest), 'uiOnlyRelease': False,
                 'runtimeCutoverRequired': False, 'generatedAt': stamp(),
                 'updateScope': 'Hide fixed fundraising targets when both markets confirm no valid sell order; retain participant exit paths',
                 'buildContentSha256': content_digest(built_files), 'buildFileCount': len(built_files),
                 'retainedImmutableChunks': len(retained), 'contentSha256': content_digest(final_files),
                 'fileCount': len(final_files),
                 'contentSha256Scope': 'Sorted file path and SHA256 list; excludes fresh-product-release.json'})
    require(meta['runtimeSourceHead'] == previous_meta['runtimeSourceHead']
            and meta['signerSourceHead'] == previous_meta['signerSourceHead']
            and meta['machineSourceHead'] == previous_meta['machineSourceHead'], 'Unchanged runtime source provenance changed')
    metadata = (json.dumps(meta, indent=2) + '\n').encode()
    (dest / RELEASE_NAME).write_bytes(metadata)
    for path in [dest, *dest.rglob('*')]:
        require(not path.is_symlink(), 'Static release contains a symlink')
        path.chmod(0o755 if path.is_dir() else 0o644)
    require(sha(regular(incoming / 'build-summary.json', 5_000_000)) == summary_sha, 'Reviewed summary changed')
    require(current.resolve(strict=True) == FRONT_BASE and inventory(FRONT_BASE, exclude=(RELEASE_NAME,)) == old_files,
            'Frontend baseline changed while staging')
    require({INDEX_UNIT: unit(INDEX_UNIT), **others()} == before_units and protected() == before_protected
            and upgrade_entry() == before_upgrade and unit('nginx') == before_nginx,
            'A service or protected deployment changed while staging')
    switched = False
    try:
        switch_static(current, dest, WEB_ROOT / ('.invalid-target-switch-' + head[:12]))
        switched = True
        proof = verify_static(dest, metadata)
        target_proof = display_proof(SITE + '/bemine-v5/api/chain-index/v1/display/pools?cursor=0&limit=20')
        require({INDEX_UNIT: unit(INDEX_UNIT), **others()} == before_units and protected() == before_protected
                and upgrade_entry() == before_upgrade and unit('nginx') == before_nginx,
                'A service or protected deployment changed during static cutover')
        require(inventory(FRONT_BASE, exclude=(RELEASE_NAME,)) == old_files
                and inventory(dest, exclude=(RELEASE_NAME,)) == final_files
                and regular(dest / RELEASE_NAME) == metadata, 'Reviewed static files changed during cutover')
        result = {'published': True, 'phase': 'frontend', 'sourceHead': head, 'publishedAt': stamp(),
                  'summarySha256': summary_sha, 'previous': str(FRONT_BASE), 'directory': str(dest),
                  'frontendSourceHead': head, 'runtimeSourceHead': meta['runtimeSourceHead'],
                  'signerSourceHead': meta['signerSourceHead'], 'indexOverlaySourceHead': head,
                  'contractUpgradeApplied': False, 'runtimeRestarted': False, 'nginxChanged': False,
                  'retainedImmutableChunks': retained, 'contentSha256': meta['contentSha256'],
                  'releaseMetadataSha256': sha(metadata), 'proof': proof, 'targetProof': target_proof,
                  'stableUnits': before_units}
        save(incoming, 'frontend-publication.json', result)
        print(json.dumps({key: result[key] for key in ['published', 'phase', 'sourceHead', 'directory',
                         'runtimeRestarted', 'contractUpgradeApplied']}), flush=True)
    except BaseException:
        if switched:
            restore_static(current, dest, FRONT_BASE, WEB_ROOT / ('.invalid-target-rollback-' + head[:12]))
            save(incoming, 'frontend-rollback.json', {'restored': str(FRONT_BASE), 'sourceHead': head, 'at': stamp()})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['backend', 'frontend', 'input-format'])
    parser.add_argument('incoming', nargs='?', type=Path)
    parser.add_argument('--source-head')
    arguments = parser.parse_args()
    if arguments.phase == 'input-format':
        print(json.dumps(input_format(), indent=2))
        return
    require(os.geteuid() == 0, 'Publish only as root on the formal host')
    require(arguments.incoming is not None, 'Incoming directory is required')
    summary, summary_sha = load_summary(arguments.incoming, arguments.source_head, arguments.phase)
    with locks():
        if arguments.phase == 'backend':
            publish_backend(arguments.incoming, summary, summary_sha)
        else:
            publish_frontend(arguments.incoming, summary, summary_sha)


if __name__ == '__main__':
    main()
