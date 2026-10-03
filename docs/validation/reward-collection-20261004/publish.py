"""Publish a prebuilt frontend-only release on the formal web host.

Run only after review, from the formal web host, with build-summary.json and
static.tgz in RELEASE_INPUT. This script never restarts or changes services.
"""

import argparse
import hashlib
import html.parser
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


RELEASE_INPUT = Path('/root/bemine-reward-collection-release-20261004')
WEB_ROOT = Path('/var/www/bemine-v5')
SITE = 'https://bemine.cc.cd'
GRAPH_URL = 'http://127.0.0.1:4227/api/journal/product-graph'
OLD_DIR = WEB_ROOT / 'releases/formal-duplicate-create-74d38f7808e6'
OLD_FRONTEND_HEAD = '74d38f7808e63088d98b680466dec8f482c618b8'
OLD_CONTENT_SHA256 = 'a0577b048f0492d7994bd377bddcc8355fe44226009901026e5a6d75d2707012'
RUNTIME_HEAD = '23b48e6adb2a19810eb287a67add5f40b4fb94b9'
FACTORY = '0xcfc7d864deb615be04c7f6ac62875c2092c5b1b9'
ARTIFACT = '0xbe37228e94095440e9cde68ae7b5e605b75154a5c7453d58b796ddb2925ec927'
FRONTEND_MANIFEST_SHA256 = 'e0455e6d40c2bc4bd2d471ce4df222e03edfc6be1a0a529c91da6e9433363f97'
CANONICAL_MANIFEST_SHA256 = '0xc1e46426f96b858013c4485461f265021bf5e4c483be8a1591ad7563dcea112d'
UNITS = (
    'pinkuang-index-v5', 'pinkuang-product-v5', 'pinkuang-v5-purchase',
    'pinkuang-v5-mining', 'pinkuang-v5-signer', 'pinkuang-v5-price',
)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def inventory(directory):
    files = sorted(path.relative_to(directory).as_posix() for path in directory.rglob('*')
                   if path.is_file() and path.name != 'fresh-product-release.json')
    require(all(not (directory / name).is_symlink() for name in files), 'Symlink in static tree')
    body = ''.join(name + '\0' + sha256((directory / name).read_bytes()) + '\n' for name in files)
    return files, sha256(body.encode())


def identity(release):
    return {
        'factory': str(release.get('factory', '')).lower(),
        'artifactDigest': release.get('artifactDigest'),
    }


def assert_runtime_identity(payload, origin):
    require(identity(payload) == {'factory': FACTORY, 'artifactDigest': ARTIFACT},
            f'{origin} factory/artifact identity changed')


def processes():
    result = {}
    for unit in UNITS:
        output = subprocess.check_output([
            'systemctl', 'show', unit,
            '--property=ActiveState,SubState,InvocationID,NRestarts',
        ], text=True, timeout=12)
        fields = dict(line.split('=', 1) for line in output.splitlines())
        require(fields.get('ActiveState') == 'active' and fields.get('SubState') == 'running',
                f'{unit} is not running')
        result[unit] = fields
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request(url, expected_status=200):
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'Pragma': 'no-cache'})
    try:
        response = OPENER.open(req, timeout=15)
    except urllib.error.HTTPError as error:
        if error.code != expected_status:
            raise
        response = error
    with response:
        require(response.status == expected_status,
                f'{url}: HTTP {response.status}, expected {expected_status}')
        return response.read(), response.headers


def graph_read():
    body, _ = request(GRAPH_URL)
    graph = json.loads(body)
    assert_runtime_identity(graph, 'product graph')
    require(graph.get('operationalReady') is True and graph.get('userExitReady') is True
            and graph.get('stale') is False, 'Product graph not ready/current')
    return graph


def graph_preflight():
    # A cached GET joins the existing backend refresh; it never forces a proof.
    last = None
    for attempt in range(3):
        try:
            return graph_read()
        except (OSError, ValueError, RuntimeError) as error:
            last = error
            if attempt < 2:
                time.sleep(5)
    raise RuntimeError(f'Product graph unavailable before publication: {last}')


def graph_snapshot(graph):
    return {name: graph.get(name) for name in (
        'factory', 'artifactDigest', 'operationalReady', 'userExitReady', 'stale',
        'sourceHead', 'snapshotAt', 'indexedThroughBlock',
    )}


def validate_archive(archive, pins):
    require(archive.is_file(), 'Archive missing')
    require(archive.stat().st_size == pins['archive']['bytes'], 'Archive byte count mismatch')
    require(sha256(archive.read_bytes()) == pins['archive']['sha256'], 'Archive SHA256 mismatch')
    with tarfile.open(archive, 'r:gz') as bundle:
        names = set()
        for item in bundle.getmembers():
            name = item.name
            path = Path(name)
            require(item.isfile() and name and not path.is_absolute()
                    and path.as_posix() == name and '..' not in path.parts
                    and '\\' not in name and name not in names,
                    f'Unsafe or duplicate archive member: {name}')
            require(not any(part.startswith('._') or part == '__MACOSX' for part in path.parts),
                    f'Mac metadata in archive: {name}')
            names.add(name)
        require(len(names) == pins['packagedFileCount'], 'Packaged file count mismatch')
        require('fresh-product-release.json' in names and 'index.html' in names
                and 'data/frontend-manifest.v5.json' in names, 'Required static files missing')
    return names


class Scripts(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            src = dict(attrs).get('src')
            if src:
                self.urls.append(src)


def verify_public(dest, release_bytes):
    manifest, _ = request(SITE + '/bemine-v5/fresh-product-release.json')
    require(manifest == release_bytes, 'Public release manifest does not match')
    canonical, _ = request(SITE + '/')
    require(canonical == (dest / 'index.html').read_bytes(), 'Canonical root HTML mismatch')
    redirect_body, headers = request(SITE + '/bemine-v5/', expected_status=308)
    require(urllib.parse.urljoin(SITE, headers.get('Location', '')) == SITE + '/',
            'Legacy v5 root redirect changed')
    require(not redirect_body or len(redirect_body) < 4096, 'Unexpected redirect response')
    live, _ = request(SITE + '/live')
    require(live == (dest / 'live.html').read_bytes(), 'Canonical live page HTML mismatch')
    _, live_redirect = request(SITE + '/bemine-v5/live', expected_status=308)
    require(urllib.parse.urljoin(SITE, live_redirect.get('Location', '')) == SITE + '/live',
            'Legacy v5 live page redirect changed')
    frontend_manifest, _ = request(SITE + '/bemine-v5/data/frontend-manifest.v5.json')
    require(frontend_manifest == (dest / 'data/frontend-manifest.v5.json').read_bytes(),
            'Public frontend manifest mismatch')
    parser = Scripts()
    parser.feed(canonical.decode('utf-8'))
    parser.feed(live.decode('utf-8'))
    require(bool(parser.urls), 'No hashed scripts found in canonical root HTML')
    verified_scripts = []
    for url in sorted(set(parser.urls)):
        require(url.startswith('/bemine-v5/_next/static/') and '?' not in url and '#' not in url,
                f'Unexpected script URL: {url}')
        path = dest / url.removeprefix('/bemine-v5/')
        require(path.is_file() and path.resolve().is_relative_to(dest.resolve()),
                f'Hash script missing from release: {url}')
        served, _ = request(SITE + url)
        require(sha256(served) == sha256(path.read_bytes()), f'Hash script mismatch: {url}')
        verified_scripts.append({'url': url, 'sha256': sha256(served)})
    return canonical, live, verified_scripts


def write_json(path, payload):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(payload, indent=2, sort_keys=True) + '\n')
    os.replace(temp, path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--build-summary', type=Path,
                        default=RELEASE_INPUT / 'build-summary.json')
    arguments = parser.parse_args()
    require(os.geteuid() == 0, 'Run on the formal web host as root')
    pins = json.loads(arguments.build_summary.read_text())
    head = pins['frontendSourceHead']
    require(isinstance(head, str) and len(head) == 40
            and all(char in '0123456789abcdef' for char in head)
            and head != OLD_FRONTEND_HEAD, 'Invalid new frontend source head')
    require(pins['runtimeSourceHead'] == RUNTIME_HEAD, 'Runtime source head mismatch')
    archive = RELEASE_INPUT / 'static.tgz'
    archive_names = validate_archive(archive, pins)
    current = WEB_ROOT / 'current'
    old = OLD_DIR.resolve(strict=True)
    require(current.is_symlink() and current.resolve(strict=True) == old,
            'Live current symlink is not the pinned formal duplicate-create release')
    old_release_bytes = (old / 'fresh-product-release.json').read_bytes()
    old_release = json.loads(old_release_bytes)
    require(old_release.get('frontendSourceHead') == OLD_FRONTEND_HEAD
            and old_release.get('runtimeSourceHead') == RUNTIME_HEAD
            and old_release.get('contentSha256') == OLD_CONTENT_SHA256
            and old_release.get('manifestSha256') == CANONICAL_MANIFEST_SHA256,
            'Prior formal release metadata differs from pinned baseline')
    assert_runtime_identity(old_release, 'previous release')
    old_files, old_content = inventory(old)
    require(len(old_files) == old_release['fileCount'] and old_content == OLD_CONTENT_SHA256,
            'Prior formal release files differ from pinned content hash')
    old_manifest_bytes = (old / 'data/frontend-manifest.v5.json').read_bytes()
    require(sha256(old_manifest_bytes) == FRONTEND_MANIFEST_SHA256,
            'Prior frontend manifest bytes changed')
    dest = WEB_ROOT / f'releases/formal-reward-collection-{head[:12]}'
    require(not dest.exists() and not dest.is_symlink(), 'Destination already exists')
    before = processes()
    graph_before = graph_preflight()
    # Before creating the candidate directory, require the public entrypoints to
    # serve the pinned old version. An unavailable edge must never be published over.
    old_public, _ = request(SITE + '/bemine-v5/fresh-product-release.json')
    require(old_public == old_release_bytes, 'Public current release differs from pinned baseline')
    old_home, _ = request(SITE + '/')
    require(old_home == (old / 'index.html').read_bytes(), 'Public root does not serve pinned baseline')
    _, old_redirect = request(SITE + '/bemine-v5/', expected_status=308)
    require(urllib.parse.urljoin(SITE, old_redirect.get('Location', '')) == SITE + '/',
            'Legacy v5 root redirect changed')
    old_live, _ = request(SITE + '/live')
    require(old_live == (old / 'live.html').read_bytes(), 'Public live page does not serve pinned baseline')
    _, old_live_redirect = request(SITE + '/bemine-v5/live', expected_status=308)
    require(urllib.parse.urljoin(SITE, old_live_redirect.get('Location', '')) == SITE + '/live',
            'Legacy v5 live page redirect changed')

    dest.mkdir(mode=0o755)
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        require({item.name for item in members} == archive_names
                and len(members) == len(archive_names), 'Archive changed after preflight')
        for item in members:
            require(item.isfile(), f'Archive member changed type: {item.name}')
            target = dest / item.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.extractfile(item) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
    release_path = dest / 'fresh-product-release.json'
    build_release_bytes = release_path.read_bytes()
    require(sha256(build_release_bytes) == pins['frontendReleaseManifestSha256'],
            'Packaged release manifest SHA256 mismatch')
    release = json.loads(build_release_bytes)
    require(release.get('frontendSourceHead') == head
            and release.get('runtimeSourceHead') == RUNTIME_HEAD
            and release.get('runtimeCutoverRequired') is False,
            'Packaged release has wrong source heads or needs runtime cutover')
    assert_runtime_identity(release, 'packaged release')
    for name in ('chainId', 'basePath', 'productFamily', 'publicOrigin', 'manifestSha256',
                 'portfolioFactory', 'authority', 'gasWallet', 'deployment', 'sourceCommit'):
        require(release.get(name) == old_release.get(name),
                f'Packaged deployment identity changed: {name}')
    files, content = inventory(dest)
    require(len(files) == release.get('fileCount') and content == release.get('contentSha256'),
            'Packaged static content hash mismatch')
    require((dest / 'data/frontend-manifest.v5.json').read_bytes() == old_manifest_bytes,
            'Packaged frontend manifest bytes differ from pinned baseline')
    build_content_sha, build_file_count = content, len(files)
    retained = []
    for name in old_files:
        if not name.startswith('_next/static/'):
            continue
        source, target = old / name, dest / name
        require(not source.is_symlink(), f'Old static chunk is a symlink: {name}')
        if target.exists():
            require(target.is_file() and source.read_bytes() == target.read_bytes(),
                    f'Existing immutable chunk changed: {name}')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            retained.append(name)
    files, content = inventory(dest)
    release.update({
        'fileCount': len(files), 'contentSha256': content,
        'buildContentSha256': build_content_sha, 'buildFileCount': build_file_count,
        'previousFrontendSourceHead': OLD_FRONTEND_HEAD,
        'retainedImmutableChunks': len(retained), 'uiOnlyRelease': True,
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'contentSha256Scope': 'Sorted file path and SHA256 list; excludes fresh-product-release.json',
    })
    release_bytes = (json.dumps(release, indent=2) + '\n').encode()
    release_path.write_bytes(release_bytes)
    for path in dest.rglob('*'):
        require(not path.is_symlink(), f'Symlink in staged release: {path}')
        path.chmod(0o755 if path.is_dir() else 0o644)

    switch = WEB_ROOT / '.current-reward-collection-switch'
    rollback = WEB_ROOT / '.current-reward-collection-rollback'
    require(not switch.exists() and not switch.is_symlink()
            and not rollback.exists() and not rollback.is_symlink(),
            'Previous switch/rollback temporary symlink exists')
    require(current.resolve(strict=True) == old, 'Live frontend changed during staging')
    require(processes() == before, 'A service changed while staging; publication was not started')
    require(identity(graph_read()) == identity(graph_before),
            'Product graph changed while staging; publication was not started')
    switch.symlink_to(dest)
    os.replace(switch, current)
    try:
        home, live, scripts = verify_public(dest, release_bytes)
        graph_after = graph_read()
        after = processes()
        require(after == before, 'A service process changed during static publication')
        require(identity(graph_after) == identity(graph_before), 'Runtime graph identity changed')
    except BaseException as error:
        if current.is_symlink() and current.resolve(strict=True) == dest.resolve(strict=True):
            rollback.symlink_to(old)
            os.replace(rollback, current)
        else:
            raise RuntimeError('Post-publication check failed and current changed externally; '
                               'automatic rollback was refused') from error
        raise

    receipt = {
        'schemaVersion': 1,
        'scope': 'frontend-only single-PoolVault reward collection',
        'publishedAt': datetime.now(timezone.utc).isoformat(),
        'previousFrontend': str(old), 'frontend': str(dest),
        'previousFrontendSourceHead': OLD_FRONTEND_HEAD,
        'frontendSourceHead': head, 'runtimeSourceHead': RUNTIME_HEAD,
        'factory': release['factory'], 'artifactDigest': ARTIFACT,
        'archiveSha256': pins['archive']['sha256'], 'archiveBytes': archive.stat().st_size,
        'buildReleaseManifestSha256': pins['frontendReleaseManifestSha256'],
        'releaseManifestSha256': sha256(release_bytes),
        'contentSha256': content, 'buildContentSha256': build_content_sha,
        'buildFileCount': build_file_count, 'fileCount': len(files) + 1,
        'retainedImmutableChunks': retained,
        'rootHtmlSha256': sha256(home), 'liveHtmlSha256': sha256(live),
        'hashedScripts': scripts,
        'canonicalRootVerified': True, 'canonicalLiveVerified': True,
        'legacyV5RedirectVerified': True,
        'publicManifestVerified': True, 'runtimeRestarted': False,
        'serviceProcessesUnchanged': True, 'processes': after,
        'productGraphBefore': graph_snapshot(graph_before),
        'productGraphAfter': graph_snapshot(graph_after),
    }
    try:
        write_json(RELEASE_INPUT / 'publication.json', receipt)
    except BaseException as error:
        if current.is_symlink() and current.resolve(strict=True) == dest.resolve(strict=True):
            rollback.symlink_to(old)
            os.replace(rollback, current)
        else:
            raise RuntimeError('Publication receipt could not be written and current changed externally; '
                               'automatic rollback was refused') from error
        raise
    print(json.dumps({key: receipt[key] for key in (
        'publishedAt', 'frontend', 'frontendSourceHead', 'runtimeSourceHead',
        'fileCount', 'runtimeRestarted', 'serviceProcessesUnchanged',
        'canonicalRootVerified', 'legacyV5RedirectVerified',
    )} | {'retainedImmutableChunkCount': len(retained),
         'hashedScriptCount': len(scripts)}, separators=(',', ':')))


if __name__ == '__main__':
    main()
