"""Fixed root handoff after the isolated authenticated wallet deployment succeeds."""
import hashlib,json,os,re,subprocess
from pathlib import Path

ROOT=Path('/srv/bemine-full-test/current')
STATE=Path('/var/lib/bemine-full-test')
CONFIG=Path('/etc/bemine-full-test')
def need(ok,message):
 if not ok:raise RuntimeError(message)
def read(path,limit=20000000):
 need(path.is_file() and not path.is_symlink() and 0<path.stat().st_size<=limit,'Invalid test state input')
 return path.read_bytes()
def install(path,body,mode=0o600):
 need(path.parent==CONFIG and not path.is_symlink(),'Unexpected test config target')
 temp=path.with_name(path.name+'.next')
 fd=os.open(temp,os.O_CREAT|os.O_EXCL|os.O_WRONLY,mode)
 with os.fdopen(fd,'wb') as file:file.write(body);file.flush();os.fsync(file.fileno())
 os.replace(temp,path);path.chmod(mode)
def environment(path):
 result={}
 for line in read(path,20000).decode().splitlines():
  if line and not line.startswith('#'):
   key,value=line.split('=',1);need(re.fullmatch('[A-Z0-9_]+',key),'Invalid fixed env file');result[key]=value
 return result
def encoded(values):return ''.join(key+'='+str(value)+'\n' for key,value in values.items()).encode()

need(os.geteuid()==0,'Root provisioner required')
release=ROOT.resolve()
need(ROOT.is_symlink() and release.parent==Path('/srv/bemine-full-test/releases') and re.fullmatch('full-test-[a-f0-9]{12}-[a-f0-9]{12}',release.name),'Unexpected installed test release')
rpc=environment(CONFIG/'rpc.env')
check=subprocess.run(['/usr/bin/node',str(release/'activate-proof.mjs')],env={**os.environ,**rpc},capture_output=True,text=True,timeout=180)
need(check.returncode==0,'Test graph proof failed; no service configuration changed')
proof=json.loads(check.stdout);need(re.fullmatch('0x[a-fA-F0-9]{40}',proof['factory']) and re.fullmatch('0x[a-fA-F0-9]{40}',proof['authority']),'Invalid proven graph addresses')
marker=read(STATE/'activation-ready.json',4096);marker_sha=hashlib.sha256(marker).hexdigest()
complete=CONFIG/'activation-installed.json'
if complete.exists() and json.loads(read(complete,4096))['markerSha256']==marker_sha:
 print('Full-test service handoff already installed.');raise SystemExit(0)
for name in ['genesis.json','authority-activation.json','index-manifest.json']:
 install(CONFIG/name,read(STATE/name),0o644)
common={'NODE_ENV':'production','DEPLOYMENT_JOURNAL_ORIGIN':'https://tapeout.cc.cd',
 'BEMINE_DEPLOYMENT_RECORD_PATH':str(CONFIG/'genesis.json'),'BEMINE_PRODUCT_ACTIVATION_PATH':str(CONFIG/'authority-activation.json'),
 'BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH':str(release/'public/deployment-artifacts.json'),
 'BEMINE_EXPECTED_GAS_WALLET':proof['gasWallet'],'DEPLOYMENT_JOURNAL_DB':str(STATE/'journal.sqlite'),
 'PINKUANG_KEEPER_STATE_ROOT':'/var/lib/bemine-full-test-signer/keeper',
 'AUTHORITY_RELAY_JOURNAL':'/var/lib/bemine-full-test-signer/authority/authority.json',
 'AUTHORITY_REQUIRE_FRESH_READINESS':'1','AUTHORITY_RELAY_MAX_GAS_BNB':'0.5','AUTHORITY_RELAY_MAX_GAS_PRICE_GWEI':'3',
 'AUTHORITY_RELAY_SOCKET':'/run/bemine-full-test-relay/authority.sock','AUTHORITY_RELAY_ENABLED':'1',
 'AUTHORITY_SIGNER_ATTEST_ONLY':'0','FRESH_PURCHASE_ENABLED':'1'}
install(CONFIG/'active.env',encoded(common))
index={'NODE_ENV':'production','CHAIN_INDEX_MODE':'fresh-v4','CHAIN_INDEX_HOST':'127.0.0.1','CHAIN_INDEX_PORT':'4204',
 'CHAIN_INDEX_DB':'/var/lib/bemine-full-test-index/index.sqlite','CHAIN_INDEX_SCAN_RANGE':'500','CHAIN_INDEX_CONFIRMATIONS':'12',
 'CHAIN_INDEX_FRESH_MANIFEST_PATH':str(CONFIG/'index-manifest.json'),'CHAIN_INDEX_FRESH_MANIFEST_SHA256':proof['indexManifestSha256']}
install(CONFIG/'index.env',encoded(index))
workers={'FULL_TEST_FACTORY':proof['factory'],'FULL_TEST_AUTHORITY':proof['authority']}
install(CONFIG/'workers.env',encoded(workers))
subprocess.run(['systemctl','enable','bemine-full-test-index.service','bemine-full-test-purchase.service','bemine-full-test-mining.service'],check=True,timeout=30)
for unit in ['bemine-full-test-index.service','bemine-full-test-signer.service','bemine-full-test-purchase.service','bemine-full-test-mining.service']:
 subprocess.run(['systemctl','restart',unit],check=True,timeout=60)
install(complete,(json.dumps({'schemaVersion':1,'markerSha256':marker_sha,'sourceHead':proof['sourceHead'],'artifactDigest':proof['artifactDigest']})+'\n').encode())
print('Independent full-test index, signer and workers installed; readiness remains based on live service state and test Gas funding.')
