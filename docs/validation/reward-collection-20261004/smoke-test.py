"""Offline static switch/rollback smoke test; no network or server access."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from unittest.mock import patch


source = Path(__file__).with_name('publish.py')
spec = importlib.util.spec_from_file_location('reward_publish', source)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
sha = lambda data: hashlib.sha256(data).hexdigest()


def fixture(root):
    web = root / 'www'
    old = web / 'releases/old'
    old.mkdir(parents=True)
    incoming = root / 'incoming'
    static = incoming / 'static'
    static.mkdir(parents=True)
    stable = dict(chainId=56, basePath='/bemine-v5', productFamily='fresh-v4',
                  publicOrigin=publisher.SITE, manifestSha256='0x' + 'ab' * 32,
                  portfolioFactory='portfolio', authority='authority', gasWallet='wallet',
                  deployment={'block': 1}, sourceCommit='source', factory=publisher.FACTORY,
                  artifactDigest=publisher.ARTIFACT, runtimeSourceHead='b' * 40,
                  runtimeCutoverRequired=False)

    def put(directory, name, data):
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def build(directory, head, chunk):
        html = f'<script src="/bemine-v5/_next/static/{chunk}.js"></script>'.encode()
        for name in ('index.html', 'live.html'):
            put(directory, name, html)
        put(directory, f'_next/static/{chunk}.js', chunk.encode())
        put(directory, 'data/frontend-manifest.v5.json', b'manifest')
        files, digest = publisher.inventory(directory)
        release = dict(stable, frontendSourceHead=head, fileCount=len(files), contentSha256=digest)
        put(directory, 'fresh-product-release.json', (json.dumps(release) + '\n').encode())
        return release

    prior = build(old, 'a' * 40, 'old')
    build(static, 'c' * 40, 'new')
    archive = incoming / 'static.tgz'
    with tarfile.open(archive, 'w:gz') as bundle:
        for path in sorted(static.rglob('*')):
            if path.is_file():
                bundle.add(path, arcname=path.relative_to(static).as_posix())
    summary = dict(frontendSourceHead='c' * 40, runtimeSourceHead='b' * 40,
                   archive=dict(sha256=sha(archive.read_bytes()), bytes=archive.stat().st_size),
                   frontendReleaseManifestSha256=sha((static / 'fresh-product-release.json').read_bytes()),
                   packagedFileCount=5)
    (incoming / 'build-summary.json').write_text(json.dumps(summary))
    current = web / 'current'
    current.symlink_to(old)
    publisher.RELEASE_INPUT = incoming
    publisher.WEB_ROOT = web
    publisher.OLD_DIR = old
    publisher.OLD_FRONTEND_HEAD = 'a' * 40
    publisher.OLD_CONTENT_SHA256 = prior['contentSha256']
    publisher.RUNTIME_HEAD = 'b' * 40
    publisher.FRONTEND_MANIFEST_SHA256 = sha(b'manifest')
    publisher.CANONICAL_MANIFEST_SHA256 = stable['manifestSha256']
    graph = dict(factory=publisher.FACTORY, artifactDigest=publisher.ARTIFACT,
                 operationalReady=True, userExitReady=True, stale=False)
    publisher.graph_read = lambda: graph
    publisher.graph_preflight = lambda: graph
    publisher.processes = lambda: {unit: dict(ActiveState='active', SubState='running',
                                             InvocationID='same', NRestarts='0')
                                   for unit in publisher.UNITS}

    def request(url, expected_status=200):
        path = url.removeprefix(publisher.SITE)
        if path in ('/bemine-v5/', '/bemine-v5/live'):
            assert expected_status == 308
            return b'', {'Location': '/' if path.endswith('/') else '/live'}
        name = {'/': 'index.html', '/live': 'live.html'}.get(path, path.removeprefix('/bemine-v5/'))
        return (current.resolve() / name).read_bytes(), {}

    publisher.request = request
    return current, old, incoming


with tempfile.TemporaryDirectory() as temp:
    current, old, incoming = fixture(Path(temp).resolve())
    with patch.object(publisher.os, 'geteuid', return_value=0), patch.object(sys, 'argv', ['publish.py']):
        publisher.main()
    receipt = json.loads((incoming / 'publication.json').read_text())
    assert current.resolve() != old
    assert len(receipt['retainedImmutableChunks']) == 1
    assert receipt['hashedScripts'][0]['url'] == '/bemine-v5/_next/static/new.js'

with tempfile.TemporaryDirectory() as temp:
    current, old, incoming = fixture(Path(temp).resolve())
    with patch.object(publisher.os, 'geteuid', return_value=0), patch.object(sys, 'argv', ['publish.py']), \
         patch.object(publisher, 'verify_public', side_effect=RuntimeError('public proof failed')):
        try:
            publisher.main()
        except RuntimeError as error:
            assert str(error) == 'public proof failed'
        else:
            raise AssertionError('Post-publication failure did not abort')
    assert current.resolve() == old
    assert not (incoming / 'publication.json').exists()

print('offline switch, retained chunk, and failed-public-proof rollback PASS')
