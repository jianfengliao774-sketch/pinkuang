#!/usr/bin/env python3
"""Publish an isolated signing entry; never restart workers or send a transaction."""
import fcntl, hashlib, json, os, pathlib, re, subprocess, sys, tarfile, tempfile, urllib.request

ROOT = pathlib.Path('/srv/pinkuang-portfolio-upgrade')
SNIPPET = pathlib.Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf')
EXPECTED_SNIPPET = '4580aaecbc5f58da30686b315c23d2038ed8f5bdb47923edb9938020a53c0856'
EXPECTED_CORE_ENTRY = '/srv/pinkuang-target-owner-upgrade/releases/6841bf0132f600870b135e728ecb8ff5e882ee98'
EXPECTED_FRONTEND = '/var/www/bemine-v5/releases/audit-fixes-716254c3fc54'
URL = 'https://bemine.cc.cd/pinkuang-portfolio-upgrade/'
ADDITION = b'''\n# Isolated portfolio-dust signing entry; shared read RPC stays read-only.\nlocation = /pinkuang-portfolio-upgrade { return 308 /pinkuang-portfolio-upgrade/; }\nlocation ^~ /pinkuang-portfolio-upgrade/ {\n    alias /srv/pinkuang-portfolio-upgrade/current/;\n    autoindex off;\n    index index.html;\n    add_header Cache-Control "no-store" always;\n    add_header Referrer-Policy "no-referrer" always;\n    add_header X-Content-Type-Options "nosniff" always;\n    limit_except GET HEAD { deny all; }\n}\n'''
sha = lambda b: hashlib.sha256(b).hexdigest()

def need(ok, message):
    if not ok: raise RuntimeError(message)

def run(*args):
    result = subprocess.run(args, check=True, capture_output=True, text=True)
    return result.stdout

def atomic_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.portfolio-stage-')
    try:
        with os.fdopen(fd, 'wb') as output: output.write(data); output.flush(); os.fsync(output.fileno())
        os.chmod(name, 0o644); os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'Cache-Control':'no-cache'}), timeout=30) as response:
        need(response.status == 200 and response.url == url, 'Signing entry redirected or failed')
        return response.read(20_000_000)

def publish(incoming):
    pins = json.loads((incoming/'pins.json').read_text())
    archive = incoming/'static.tgz'
    need(sha(archive.read_bytes()) == pins['archiveSha256'], 'Archive digest differs')
    need(re.fullmatch(r'[a-f0-9]{40}', pins['sourceCommit']), 'Source commit is invalid')
    prior = SNIPPET.read_bytes()
    need(sha(prior) == EXPECTED_SNIPPET, 'Existing routing differs; do not overwrite')
    core = pathlib.Path('/srv/pinkuang-target-owner-upgrade/current')
    frontend = pathlib.Path('/var/www/bemine-v5/current')
    need(str(core.resolve(strict=True)) == EXPECTED_CORE_ENTRY and str(frontend.resolve(strict=True)) == EXPECTED_FRONTEND, 'Current product or original upgrade entry changed')
    core_index_hash = sha((core/'index.html').read_bytes())
    need(not (ROOT/'current').exists() and not (ROOT/'current').is_symlink(), 'Portfolio entry already exists; do not overwrite records')
    release = ROOT/'releases'/pins['sourceCommit']
    need(not release.exists(), 'Release directory already exists')
    files = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            need(member.isfile() and re.fullmatch(r'(index.html|release.json|data/config.json|assets/[a-zA-Z0-9_.-]+\.(js|css))', member.name), 'Unexpected archive member')
            need(member.name not in files and member.size <= 12_000_000, 'Duplicate or oversized archive member')
            files[member.name] = tar.extractfile(member).read()
    need(set(files) == set(pins['files']) and all(sha(value) == pins['files'][name] for name,value in files.items()), 'Static inventory differs')
    need(sha(files['data/config.json']) == pins['configSha256'], 'Signing configuration differs')
    config = json.loads(files['data/config.json'])
    need(config['kind'] == 'portfolio-dust-release-v1' and config['chainId'] == 56, 'Wrong signing scope')
    for name,data in files.items(): atomic_bytes(release/name, data)
    backup = incoming/'original-nginx.conf'
    atomic_bytes(backup, prior); os.chmod(backup, 0o600)
    current = ROOT/'current'
    try:
        os.symlink(release, current)
        atomic_bytes(SNIPPET, prior+ADDITION)
        run('nginx','-t'); run('systemctl','reload','nginx')
        need(sha(fetch(URL)) == pins['files']['index.html'], 'Published HTML differs')
        need(sha(fetch(URL+'data/config.json')) == pins['configSha256'], 'Published config differs')
        for name in files:
            if name.startswith('assets/'): need(sha(fetch(URL+name)) == pins['files'][name], 'Published asset differs')
        need(str(core.resolve(strict=True)) == EXPECTED_CORE_ENTRY and sha((core/'index.html').read_bytes()) == core_index_hash
             and str(frontend.resolve(strict=True)) == EXPECTED_FRONTEND, 'Original entry or formal product changed')
        receipt = {'kind':'portfolio-dust-entry-publication-v1','sourceCommit':pins['sourceCommit'],'url':URL,
                   'configSha256':pins['configSha256'],'archiveSha256':pins['archiveSha256'],
                   'nginxBeforeSha256':sha(prior),'nginxAfterSha256':sha(SNIPPET.read_bytes()),
                   'release':str(release),'originalCoreEntryUnchanged':True,'formalProductUnchanged':True,
                   'chainActionsPerformed':False,'candidateDeployed':False}
        atomic_bytes(incoming/'publication.json',(json.dumps(receipt,indent=2)+'\n').encode())
        print(json.dumps(receipt))
    except BaseException:
        atomic_bytes(SNIPPET, prior)
        if current.is_symlink() and current.resolve() == release: current.unlink()
        run('nginx','-t'); run('systemctl','reload','nginx')
        raise

if __name__ == '__main__':
    need(os.geteuid() == 0, 'Publication requires the server operator')
    with open('/run/pinkuang-portfolio-entry.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
        publish(pathlib.Path(sys.argv[1]).resolve(strict=True))
