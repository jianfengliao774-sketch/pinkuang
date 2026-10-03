#!/usr/bin/env python3
"""Publish an isolated fresh console; never sign or alter a product graph.

Input: upload directory containing runtime.tgz and manifest.json. The manifest
pins the archive, every packaged file, and the immutable dependency release.
Existing deployment journals, Gas signer and product workers are untouched.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tarfile
import time
from urllib.request import urlopen
from urllib.error import URLError


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


upload = Path(sys.argv[1]).resolve()
manifest = json.loads((upload / 'manifest.json').read_text())
source = manifest['sourceHead']
assert len(source) == 40 and all(c in '0123456789abcdef' for c in source)
release = Path('/srv/pinkuang-deploy-latest/releases') / source[:12]
current = Path('/srv/pinkuang-deploy-latest/current')
db_dir = Path('/var/lib/pinkuang-deploy-latest')
unit = Path('/etc/systemd/system/pinkuang-deploy-latest.service')
snippet = Path('/etc/nginx/snippets/pinkuang-deploy-latest.conf')
site = Path('/etc/nginx/sites-enabled/bem2075').resolve()
dependencies = Path(manifest['dependencyRelease']).resolve()
assert os.getuid() == 0
assert not current.exists() and not current.is_symlink(), 'Inspect any existing release before updating'
assert not release.exists() and not unit.exists() and not snippet.exists()
assert not db_dir.exists(), 'Never replace a deployment journal'
assert str(dependencies).startswith('/srv/pinkuang-deploy-v5/releases/')
assert (dependencies / 'node_modules').is_dir()
assert digest(upload / 'runtime.tgz') == manifest['archiveSha256']
before = site.read_bytes()
anchor = b'    include /etc/nginx/snippets/pinkuang-deploy-v5.conf;\n'
assert before.count(anchor) == 1
backup = site.with_name(site.name + '.before-latest-' + source[:12])
assert not backup.exists()
assert all(
    line.split()[3].rsplit(':', 1)[-1] != '4237'
    for line in run('ss', '-lntH', capture_output=True, text=True).stdout.splitlines())

release.mkdir(parents=True)
with tarfile.open(upload / 'runtime.tgz', 'r:gz') as archive:
    for entry in archive.getmembers():
        assert not entry.name.startswith('/') and '..' not in Path(entry.name).parts
        assert entry.isfile() or entry.isdir(), 'Archive links and devices are forbidden'
    archive.extractall(release)
for name, expected in manifest['files'].items():
    assert digest(release / name) == expected, name
assert digest(release / 'package-lock.json') == digest(dependencies / 'package-lock.json')
for path in [release, *release.rglob('*')]:
    os.chmod(path, 0o755 if path.is_dir() else 0o644)
(release / 'node_modules').symlink_to(dependencies / 'node_modules', target_is_directory=True)
run('/usr/bin/node', '--input-type=module', '-e',
    "import {servedArtifactDigest} from './server/artifact-digest.mjs'; "
    "if(servedArtifactDigest('./dist/deployment-artifacts.json')!==process.argv[1]) "
    "throw new Error('Artifact digest mismatch'); "
    "await import('./server/index.mjs'); console.log('Runtime import and artifact digest verified')",
    manifest['artifactDigest'], cwd=release)
account = pwd.getpwnam('pinkuang-v4')
db_dir.mkdir(mode=0o700)
os.chown(db_dir, account.pw_uid, account.pw_gid)
current.symlink_to(release, target_is_directory=True)
shutil.copyfile(release / 'ops/v5/pinkuang-deploy-latest.service', unit)
shutil.copyfile(release / 'ops/v5/pinkuang-deploy-latest.conf', snippet)
backup.write_bytes(before)
try:
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', 'pinkuang-deploy-latest.service')
    run('systemctl', 'is-active', '--quiet', 'pinkuang-deploy-latest.service')
    # Type=simple reports active before Node has imported its modules/listened.
    deadline = time.monotonic() + 15
    while True:
        try:
            with urlopen('http://127.0.0.1:4237/deployment-artifacts.json', timeout=5) as response:
                assert hashlib.sha256(response.read()).hexdigest() == manifest['files']['dist/deployment-artifacts.json']
            break
        except URLError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.25)
    site.write_bytes(before.replace(anchor, anchor + b'    include /etc/nginx/snippets/pinkuang-deploy-latest.conf;\n'))
    run('nginx', '-t')
    run('systemctl', 'reload', 'nginx')
    run('systemctl', 'enable', 'pinkuang-deploy-latest.service')
except BaseException:
    try:
        site.write_bytes(before)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    finally:
        run('systemctl', 'stop', 'pinkuang-deploy-latest.service')
    raise
evidence = {**manifest, 'url': 'https://tapeout.cc.cd/pinkuang-deploy-latest/',
            'runtime': str(release), 'journal': str(db_dir / 'journal.sqlite'),
            'nginxBackup': str(backup), 'chainTransactionsSent': False,
            'existingProductChanged': False}
(release.parent.parent / 'publication.json').write_text(json.dumps(evidence, indent=2) + '\n')
print(json.dumps({k: evidence[k] for k in ['url', 'runtime', 'artifactDigest',
      'chainTransactionsSent', 'existingProductChanged']}))
