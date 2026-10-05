#!/usr/bin/env python3
"""Update the signing UI and its dedicated read proxy; never send a transaction."""
import fcntl, hashlib, json, os, pathlib, re, subprocess, sys, tarfile, tempfile, urllib.request

STATIC = pathlib.Path('/srv/pinkuang-portfolio-upgrade')
OLD_STATIC = STATIC/'releases/a08759f1d4dbca9a958faee1adf90fd6ab1f9087'
OLD_RPC = pathlib.Path('/srv/pinkuang-target-owner-read/releases/6841bf0132f600870b135e728ecb8ff5e882ee98')
DROPIN = pathlib.Path('/etc/systemd/system/pinkuang-target-owner-read.service.d/nonce-proof.conf')
SERVICE = 'pinkuang-target-owner-read.service'
URL = 'https://bemine.cc.cd/pinkuang-portfolio-upgrade/'
RPC_URL = 'https://bemine.cc.cd/pinkuang-target-owner-upgrade/api/rpc'
CONFIG_SHA = 'c01ad9d1e877c3003fb57b0dc129d6998c861684e05eb15f8ec33008e443bd83'
OLD_RPC_FILES = {
 'deploy/server/live-data-proxy.mjs':'0840df9af1203aa4a4e41e80cad56d7b16866798da93cd2a0603e2bfb4864f65',
 'deploy/server/target-owner-read-server.mjs':'c90487a4e6324eca8d7340fc21a56f852704db4ddf6b8139f34b180c2d7673d5',
 'deploy/server/request-limiter.mjs':'c70933abb6c0c3a60c198ff2164105827f73d2915e837e009bc9a8035e9e3c64',
}
sha = lambda data: hashlib.sha256(data).hexdigest()
def need(ok,message):
 if not ok: raise RuntimeError(message)
def run(*args): return subprocess.run(args,check=True,capture_output=True,text=True).stdout.strip()
def atomic(path,data):
 path.parent.mkdir(parents=True,exist_ok=True)
 fd,name=tempfile.mkstemp(dir=path.parent,prefix='.nonce-stage-')
 try:
  with os.fdopen(fd,'wb') as out: out.write(data);out.flush();os.fsync(out.fileno())
  os.chmod(name,0o644);os.replace(name,path)
 finally:
  if os.path.exists(name):os.unlink(name)
def link(path,target):
 temp=path.parent/'.nonce-current-next'
 need(not temp.exists() and not temp.is_symlink(),'Stale link stage')
 os.symlink(target,temp);os.replace(temp,path)
def fetch(url):
 with urllib.request.urlopen(urllib.request.Request(url,headers={'Cache-Control':'no-cache'}),timeout=30) as response:
  need(response.status==200 and response.url==url,'Published URL failed or redirected')
  return response.read(12_000_000)
def rpc(method,params):
 request=urllib.request.Request(RPC_URL,json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),{'Content-Type':'application/json'})
 with urllib.request.urlopen(request,timeout=30) as response: value=json.load(response)
 need(value.get('jsonrpc')=='2.0' and value.get('id')==1 and 'result' in value and 'error' not in value,'Read proxy returned no proof')
 return value['result']
def read_archive(path,inventory):
 files={}
 with tarfile.open(path,'r:gz') as tar:
  for member in tar.getmembers():
   need(member.isfile() and member.name in inventory and member.name not in files and member.size<=12_000_000,'Unexpected release member')
   files[member.name]=tar.extractfile(member).read()
 need(set(files)==set(inventory) and all(sha(data)==inventory[name] for name,data in files.items()),'Release inventory differs')
 return files
def publish_ui(incoming):
 """A subsequent UI-only correction preserves the already-installed proxy."""
 pins=json.loads((incoming/'pins.json').read_text())
 for key in ['sourceCommit','proxySourceCommit','expectedStaticCommit']:need(re.fullmatch('[a-f0-9]{40}',pins[key]),'Invalid release commit')
 need(sha((incoming/'static.tgz').read_bytes())==pins['archiveSha256'],'Static archive differs')
 files=read_archive(incoming/'static.tgz',pins['files'])
 need(all(re.fullmatch(r'(index.html|release.json|data/config.json|assets/[a-zA-Z0-9_.-]+\.(js|css))',name) for name in files),'Unexpected static file')
 prior=STATIC/'releases'/pins['expectedStaticCommit'];current=STATIC/'current'
 need(str(current.resolve(strict=True))==str(prior) and sha((prior/'index.html').read_bytes())==pins['expectedIndexSha256'],'Current UI differs')
 need(sha(files['data/config.json'])==CONFIG_SHA and sha((prior/'data/config.json').read_bytes())==CONFIG_SHA,'Journal or signing config changed')
 rpc_release=OLD_RPC.parent/pins['proxySourceCommit']
 need(run('systemctl','show',SERVICE,'-p','WorkingDirectory','--value')==str(rpc_release),'Read service changed')
 need(sha((rpc_release/'deploy/server/live-data-proxy.mjs').read_bytes())==pins['proxySha256'],'Read service digest differs')
 routing=pathlib.Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf');route_sha=sha(routing.read_bytes())
 need(route_sha=='03e77deead7df6eeb1f8d786a0d0e0f992f7a04eb68ecf927937cd74b5de53c9','Routes changed')
 protected=[pathlib.Path('/srv/pinkuang-target-owner-upgrade/current'),pathlib.Path('/var/www/bemine-v5/current')]
 preserved={str(p):(str(p.resolve(strict=True)),sha((p/'index.html').read_bytes())) for p in protected}
 invocation=run('systemctl','show',SERVICE,'-p','InvocationID','--value')
 release=STATIC/'releases'/pins['sourceCommit'];need(not release.exists(),'Release already exists; inspect original outcome')
 for name,data in files.items():atomic(release/name,data)
 try:
  link(current,release)
  for name,data in files.items():need(sha(fetch(URL+('' if name=='index.html' else name)))==sha(data),'Published file differs')
  need(sha(routing.read_bytes())==route_sha and run('systemctl','show',SERVICE,'-p','InvocationID','--value')==invocation,'Read service or routes changed')
  for path,(target,digest) in preserved.items():
   p=pathlib.Path(path);need(str(p.resolve(strict=True))==target and sha((p/'index.html').read_bytes())==digest,'Original entry changed')
  receipt={'kind':'portfolio-wallet-format-ui-publication-v1','url':URL,'sourceCommit':pins['sourceCommit'],
   'proxySourceCommit':pins['proxySourceCommit'],'configSha256':CONFIG_SHA,'proxySha256':pins['proxySha256'],
   'archiveSha256':pins['archiveSha256'],'staticRelease':str(release),'readServiceInvocation':invocation,
   'originalCoreEntryUnchanged':True,'formalProductUnchanged':True,'readServiceUnchanged':True,
   'signingConfigAndJournalKeyUnchanged':True,'chainActionsPerformed':False}
  atomic(incoming/'publication.json',(json.dumps(receipt,indent=2)+'\n').encode());print(json.dumps(receipt))
 except BaseException:
  if current.resolve()==release:link(current,prior)
  raise
def publish(incoming):
 pins=json.loads((incoming/'pins.json').read_text())
 for key in ['sourceCommit','proxySourceCommit']:need(re.fullmatch('[a-f0-9]{40}',pins[key]),'Invalid source commit')
 need(sha((incoming/'static.tgz').read_bytes())==pins['archiveSha256'],'Static archive differs')
 files=read_archive(incoming/'static.tgz',pins['files'])
 need(all(re.fullmatch(r'(index.html|release.json|data/config.json|assets/[a-zA-Z0-9_.-]+\.(js|css))',name) for name in files),'Unexpected static file')
 need(sha(files['data/config.json'])==CONFIG_SHA and sha((OLD_STATIC/'data/config.json').read_bytes())==CONFIG_SHA,'Signing config or journal identity changed')
 need(sha((OLD_STATIC/'index.html').read_bytes())=='4ca7ce1fe91eb03209179a36e360c8b62ea4f1808fd057f108ee03bf36f5fafd','Original signing entry changed')
 need(str((STATIC/'current').resolve(strict=True))==str(OLD_STATIC),'Signing entry already changed')
 need(run('systemctl','show',SERVICE,'-p','WorkingDirectory','--value')==str(OLD_RPC),'Read service already changed')
 need(not DROPIN.exists(),'A service override already exists')
 need(all(sha((OLD_RPC/name).read_bytes())==digest for name,digest in OLD_RPC_FILES.items()),'Live read service differs from reviewed baseline')
 need(sha((incoming/'live-data-proxy.mjs').read_bytes())==pins['proxySha256'],'Proxy patch digest differs')
 routing=pathlib.Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf')
 route_sha=sha(routing.read_bytes())
 need(route_sha=='03e77deead7df6eeb1f8d786a0d0e0f992f7a04eb68ecf927937cd74b5de53c9','Routes changed')
 core=pathlib.Path('/srv/pinkuang-target-owner-upgrade/current');product=pathlib.Path('/var/www/bemine-v5/current')
 preserved={str(p):(str(p.resolve(strict=True)),sha((p/'index.html').read_bytes())) for p in [core,product]}
 static_release=STATIC/'releases'/pins['sourceCommit']
 rpc_release=OLD_RPC.parent/pins['proxySourceCommit']
 need(not static_release.exists() and not rpc_release.exists(),'Release stage already exists; inspect original outcome first')
 for name,data in files.items():atomic(static_release/name,data)
 for name in OLD_RPC_FILES:atomic(rpc_release/name,(incoming/'live-data-proxy.mjs').read_bytes() if name.endswith('/live-data-proxy.mjs') else (OLD_RPC/name).read_bytes())
 run('/usr/bin/node','--check',str(rpc_release/'deploy/server/live-data-proxy.mjs'))
 run('/usr/bin/node','--check',str(rpc_release/'deploy/server/target-owner-read-server.mjs'))
 override=f'[Service]\nWorkingDirectory={rpc_release}\nExecStart=\nExecStart=/usr/bin/node {rpc_release}/deploy/server/target-owner-read-server.mjs\n'.encode()
 changed=False
 try:
  atomic(DROPIN,override);changed=True
  run('systemctl','daemon-reload');run('systemctl','restart',SERVICE);run('systemctl','is-active',SERVICE)
  need(run('systemctl','show',SERVICE,'-p','WorkingDirectory','--value')==str(rpc_release),'Running read service did not adopt reviewed release')
  need(rpc('eth_chainId',[])=='0x38','Read service chain differs')
  block=rpc('eth_getBlockByNumber',['latest',False]);tag=block['number']
  account='0x042B23288E2316DFb6503488292FD0Ad2F811Ae7'
  confirmed=rpc('eth_getTransactionCount',[account,tag]);pending=rpc('eth_getTransactionCount',[account,'pending'])
  canonical=rpc('eth_getBlockByNumber',[tag,False])
  need(canonical['hash']==block['hash'],'Nonce proof anchor changed')
  for value in [confirmed,pending]:need(isinstance(value,str) and re.fullmatch(r'0x(?:0|[1-9a-f][0-9a-f]*)',value,re.I),'Nonce response invalid')
  link(STATIC/'current',static_release)
  for name,data in files.items():need(sha(fetch(URL+('' if name=='index.html' else name)))==sha(data),'Published signing file differs')
  need(sha(routing.read_bytes())==route_sha,'Routing changed')
  for path,(target,digest) in preserved.items():
   p=pathlib.Path(path);need(str(p.resolve(strict=True))==target and sha((p/'index.html').read_bytes())==digest,'Formal product or original core upgrade changed')
  receipt={'kind':'portfolio-nonce-fix-publication-v1','url':URL,'sourceCommit':pins['sourceCommit'],
    'proxySourceCommit':pins['proxySourceCommit'],'configSha256':CONFIG_SHA,'proxySha256':pins['proxySha256'],
    'archiveSha256':pins['archiveSha256'],'staticRelease':str(static_release),'rpcRelease':str(rpc_release),
    'nonceProof':{'account':account,'blockNumber':int(tag,16),'blockHash':block['hash'],'confirmed':int(confirmed,16),'pending':int(pending,16)},
    'readServiceInvocation':run('systemctl','show',SERVICE,'-p','InvocationID','--value'),
    'originalCoreEntryUnchanged':True,'formalProductUnchanged':True,'signingConfigAndJournalKeyUnchanged':True,
    'chainActionsPerformed':False}
  atomic(incoming/'publication.json',(json.dumps(receipt,indent=2)+'\n').encode());print(json.dumps(receipt))
 except BaseException:
  if (STATIC/'current').resolve()==static_release:link(STATIC/'current',OLD_STATIC)
  if changed:
   DROPIN.unlink();run('systemctl','daemon-reload');run('systemctl','restart',SERVICE)
  raise
if __name__=='__main__':
 need(os.geteuid()==0,'Publication requires the server operator')
 with open('/run/pinkuang-portfolio-entry.lock','a') as lock:
  fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);incoming=pathlib.Path(sys.argv[1]).resolve(strict=True)
  if json.loads((incoming/'pins.json').read_text()).get('mode')=='static-ui':publish_ui(incoming)
  else:publish(incoming)
