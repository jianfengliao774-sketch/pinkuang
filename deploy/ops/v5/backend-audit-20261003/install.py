#!/usr/bin/env python3
"""Apply the reviewed API-only patch; preserve contracts, workers and private state."""
from pathlib import Path
import hashlib, json, os, shutil, subprocess, time, urllib.request
from datetime import datetime, timezone
SOURCE = '788cd0d705ba053615b5f5a8c319a6eeb752a1a7'
BASE = 'dea3a78b51352df45771ce6d54043b874e70383e'
BASE_DIR = Path('/srv/pinkuang-v5/releases/v5-product-' + BASE[:12])
RELEASE = Path('/srv/pinkuang-v5/releases/v5-backend-' + SOURCE[:12])
ROOT = Path('/root/bemine-v5-upload/backend-audit-20261003')
PATCH = ROOT / 'source/deploy'
DROPIN = Path('/etc/systemd/system/pinkuang-product-v5.service.d/40-backend-audit.conf')
NGINX = Path('/etc/nginx/snippets/bemine-v5-product.conf')
LIMITS = Path('/etc/nginx/conf.d/bemine-v5-read-limits.conf')
READ_ENV = Path('/etc/pinkuang-v5/public-api-read.env')
FILES = ['server/firsto-ask-publisher-store.mjs', 'server/firsto-ask-publisher.mjs',
         'server/journal-store.mjs', 'server/journal-api.mjs']
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def run(*args): return subprocess.run(args, check=True, capture_output=True, text=True).stdout
assert os.getuid() == 0
assert not DROPIN.exists() and not LIMITS.exists() and not READ_ENV.exists(), 'Already activated: inspect the existing patch, do not overwrite it.'
assert run('systemctl', 'show', 'pinkuang-product-v5', '-p', 'WorkingDirectory', '--value').strip() == str(BASE_DIR)
assert digest(NGINX) == '0299bc407f4fb28f9863a211902963d6dcd8c836f739768877ca228ea6441a2a', 'Nginx changed since review.'
for name in ['backend-tests.tap', 'display-tests.tap']:
    result = (ROOT / name).read_text()
    assert 'fail 0' in result and 'skipped 0' in result, 'Node 24 regression tests must pass.'
metadata = json.loads((BASE_DIR / 'public/fresh-release-manifest.json').read_text())
assert metadata['sourceHead'] == BASE
for name, row in metadata['files'].items(): assert digest(BASE_DIR / name) == row['sha256'], name
if RELEASE.exists():
    retained = json.loads((RELEASE / 'public/fresh-release-manifest.json').read_text())
    assert retained['sourceHead'] == SOURCE and retained['baseSourceHead'] == BASE
    for name, row in retained['files'].items(): assert digest(RELEASE / name) == row['sha256'], name
else:
    shutil.copytree(BASE_DIR, RELEASE, symlinks=True)
for name in FILES:
    shutil.copyfile(PATCH / name, RELEASE / name)
    os.chmod(RELEASE / name, 0o644)
    metadata['files'][name] = {'sha256': digest(RELEASE / name), 'bytes': (RELEASE / name).stat().st_size}
# Every runtime source module must still match the committed candidate.
for name in metadata['runtimeModules']: assert digest(RELEASE / name) == digest(PATCH / name), name
metadata.update(sourceHead=SOURCE, baseSourceHead=BASE, patchFiles=FILES,
    activation='API-only backend audit patch. Existing workers and their pinned release remain unchanged.')
(RELEASE / 'public/fresh-release-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
os.chmod(RELEASE / 'public/fresh-release-manifest.json', 0o644)
shutil.copyfile(NGINX, ROOT / 'nginx-before.conf')
old_nginx = NGINX.read_bytes()
DROPIN.parent.mkdir(parents=True, exist_ok=True)
READ_ENV.write_text('DEPLOYMENT_JOURNAL_RPC_URL=https://bsc-dataseed.bnbchain.org\n')
os.chmod(READ_ENV, 0o600)
DROPIN.write_text('[Service]\nWorkingDirectory=' + str(RELEASE) + '\nExecStart=\nExecStart=/usr/bin/node ' + str(RELEASE / 'server/index.mjs') + '\nEnvironment=BEMINE_FRESH_MACHINE_SOURCE_HEAD=' + BASE + '\nEnvironmentFile=' + str(READ_ENV) + '\n')
os.chmod(DROPIN, 0o644)
activated = False
try:
    shutil.copyfile(PATCH / 'ops/v5/runtime/nginx.conf', NGINX)
    shutil.copyfile(PATCH / 'ops/v5/runtime/nginx-http-limits.conf', LIMITS)
    os.chmod(NGINX, 0o644); os.chmod(LIMITS, 0o644)
    run('nginx', '-t')
    run('systemctl', 'daemon-reload')
    run('systemctl', 'restart', 'pinkuang-product-v5')
    graph = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen('http://127.0.0.1:4227/api/journal/product-graph', timeout=45) as res: graph = json.load(res)
            assert graph['factory'].lower() == '0x4a866e14816d8339a530c6c82300dbbb6544b37c'
            assert graph['stage'] == 'fresh-active' and graph['freshFactoryVerified']
            assert not graph.get('stale')
            break
        except Exception:
            if attempt == 3: raise
            time.sleep(2)
    run('systemctl', 'reload', 'nginx')
    activated = True
    evidence = {'schemaVersion': 1, 'installedAt': datetime.now(timezone.utc).isoformat(),
       'sourceHead': SOURCE, 'baseSourceHead': BASE, 'runtime': str(RELEASE),
       'contractArtifactDigest': graph['artifactDigest'], 'verifiedBlockNumber': graph['verifiedBlockNumber'],
       'operationalReady': graph['operationalReady'], 'changedModules': {name:digest(RELEASE/name) for name in FILES},
       'nginxSha256':digest(NGINX), 'nginxLimitsSha256':digest(LIMITS),
       'nodeVersion':run('node','--version').strip(), 'testCounts':{'backend':78,'display':9},
       'apiReadRpcHost':'bsc-dataseed.bnbchain.org', 'paidLogRpcUnchanged':True,
       'restartedUnits':['pinkuang-product-v5'], 'contractsChanged':False, 'chainTransactionsSent':False}
    (ROOT/'installation.json').write_text(json.dumps(evidence, indent=2)+'\n')
    print(json.dumps(evidence))
finally:
    if not activated:
        NGINX.write_bytes(old_nginx)
        LIMITS.unlink(missing_ok=True); DROPIN.unlink(missing_ok=True); READ_ENV.unlink(missing_ok=True)
        run('nginx','-t'); run('systemctl','daemon-reload')
        run('systemctl','restart','pinkuang-product-v5'); run('systemctl','reload','nginx')
        print('API and nginx configuration rolled back; candidate files retained for inspection.')
