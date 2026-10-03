#!/usr/bin/env python3
"""Reviewed v4 runtime activation. No action is performed by importing this file.

Use separate explicit phases. New user/member transactions are never sent here.
The enable-automation phase starts approved backend workers and is deliberately
separate from installing the loopback readers. A failed send phase never restarts
legacy senders or deletes journals, locks, or databases.
"""
import argparse
from datetime import datetime,timezone
import grp,hashlib,json,math,os,pwd,re,stat,subprocess,time,urllib.error,urllib.request
from pathlib import Path

PRODUCT='pinkuang-product-v4.service';INDEX='pinkuang-index-v4.service'
SIGNER='pinkuang-v4-signer.service';WORKERS=['pinkuang-v4-purchase.service','pinkuang-v4-mining.service']
OLD=['pinkuang-deploy-v4.service','pinkuang-deploy-v2.service','pinkuang-index-v2.service']
UNIT_ROOT=Path('/etc/systemd/system');PRODUCT_USER='pinkuang-v4-product';RELAY_GROUP='pinkuang-v4-relay'

def need(ok,reason):
    if not ok:raise RuntimeError(reason)
def sha(b):return hashlib.sha256(b).hexdigest()
def run(args,timeout=20,**kw):
    p=subprocess.run(args,capture_output=True,text=True,timeout=timeout,**kw)
    need(p.returncode==0,f'{Path(args[0]).name} failed (exit {p.returncode}).')
    return p.stdout.strip()
def info(unit):
    return dict(x.split('=',1) for x in run(['systemctl','show',unit,'--property=LoadState,ActiveState,MainPID,InvocationID,FragmentPath,DropInPaths,UnitFileState']).splitlines() if '=' in x)
def ids(units=OLD):return {u:info(u) for u in units}
def env(unit):
    pid=int(info(unit)['MainPID']);need(pid>0,'Required service is not running.')
    return dict(x.decode().split('=',1) for x in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in x)
def regular(path,root=True):
    need(path.is_file() and not path.is_symlink(),'Expected regular file: '+str(path))
    st=path.stat();need(not st.st_mode&0o022 and (not root or st.st_uid==0),'Unsafe file ownership/mode: '+str(path))
    return path.read_bytes()
def safe_path(path):
    for p in [path,*path.parents]:need(not p.is_symlink(),'Unexpected symlink in protected path.')
def newfile(path,data,mode=0o600):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
    with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
def replace(path,expected,data,mode=0o644):
    if expected is None:need(not path.exists() and not path.is_symlink(),'Target already exists.')
    else:need(sha(regular(path))==expected,'Compare-and-swap mismatch: '+str(path))
    tmp=path.with_name(path.name+'.v4-'+str(os.getpid()));newfile(tmp,data,mode);os.replace(tmp,path)
def remove_own(path,expected):
    need(sha(regular(path))==expected,'Rollback CAS mismatch.');path.unlink()
def load_plan(path,digest):
    raw=regular(path);need(sha(raw)==digest,'Plan digest differs.');p=json.loads(raw)
    need(p.get('kind')=='bemine-v4-product-runtime-plan' and p.get('chainId')==56
         and re.fullmatch('[0-9a-f]{40}',p.get('sourceHead','')),'Wrong runtime plan.')
    for key,prefix in [('runtimeRoot','/srv/pinkuang-deploy-v4/releases/'),('productRoot','/var/www/bemine-v4/releases/')]:
        v=p.get(key,'');need(v.startswith(prefix) and re.fullmatch('v4-[a-z0-9-]{2,72}',v[len(prefix):]),'Unsafe release path.');safe_path(Path(v))
    need(set(p['units'])=={PRODUCT,INDEX,SIGNER,*WORKERS},'Unexpected service inventory.')
    for name,text in p['units'].items():need(sha(text.encode())==p['unitSha256'][name],'Unit content differs.')
    need(p['environmentFile']=='/etc/pinkuang-v4/product-runtime.env' and p['inputRoot']=='/etc/pinkuang-v4/product','Unsafe config paths.')
    need(p['publication']['currentLink']=='/var/www/bemine-v4/current' and p['publication']['expectedTarget'] is None
         and p['publication']['nginxVhost']=='/etc/nginx/sites-available/bemine-v4-domain'
         and sha(p['publication']['content'].encode())==p['publication']['sha256'],'Unsafe publication target.')
    return p
def verify_release(p):
    root=Path(p['runtimeRoot']);front=Path(p['productRoot']);pair=p['releasePair']
    rb=regular(root/'public/fresh-release-manifest.json');fb=regular(front/'fresh-product-release.json')
    need(sha(rb)==pair['backendReleaseSha256'] and sha(fb)==pair['frontendReleaseSha256'],'Staged release manifest differs.')
    back=json.loads(rb);fm=json.loads(fb)
    need(back['sourceHead']==p['sourceHead']==fm['frontendSourceHead'],'Runtime and frontend source differ.')
    actual=set()
    for parent,dirs,files in os.walk(root,followlinks=False):
        if Path(parent)==root:dirs[:]=[d for d in dirs if d!='node_modules']
        for d in dirs:need(not (Path(parent)/d).is_symlink(),'Symlink in backend source.')
        for name in files:
            f=Path(parent)/name;rel=f.relative_to(root).as_posix();b=regular(f);actual.add(rel)
            if rel=='public/fresh-release-manifest.json':continue
            need(back['files'].get(rel)=={'sha256':sha(b),'bytes':len(b)},'Backend source file differs: '+rel)
    need(actual==set(back['files'])|{'public/fresh-release-manifest.json'},'Backend inventory differs.')
    need(len(actual)==pair['backendFileCount'] and sha(regular(root/'public/fresh-product-manifest.json'))==pair['indexManifestSha256'],'Backend graph/count differs.')
    inventory=[]
    for f in front.rglob('*'):
        need(not f.is_symlink(),'Symlink in frontend package.')
        if f.is_file() and f.relative_to(front).as_posix()!='fresh-product-release.json':inventory.append((f.relative_to(front).as_posix(),sha(regular(f))))
    inventory.sort();content=''.join(n+'\0'+digest+'\n' for n,digest in inventory)
    need(sha(content.encode())==pair['frontendContentSha256'] and len(inventory)==pair['frontendFileCount'],'Frontend content differs.')
    need('data/frontend-manifest.json' not in dict(inventory),'Legacy default manifest is present.')
    for name,meta in p['inputs'].items():
        need(name in ['record','activation'] and str(meta['sourcePath']).startswith('/root/'),'Unreviewed product input.')
        need(sha(regular(Path(meta['sourcePath'])))==meta['sha256'],'Product input differs.')
    return back
def check_baseline(p):
    need(sha(regular(UNIT_ROOT/INDEX))==p['expectedIndexUnitSha256'],'Prewarmed index unit changed.')
    need(sha(regular(Path('/etc/pinkuang-index-v4.env')))==p['expectedIndexEnvironmentSha256'],'Prewarmed index environment changed.')
    need(sha(regular(UNIT_ROOT/SIGNER))==p['expectedSignerUnitSha256'] and info(SIGNER)['DropInPaths']=='','Existing attestor changed.')
    for u in [PRODUCT,*WORKERS]:need(info(u)['LoadState']=='not-found' and not (UNIT_ROOT/u).exists(),'New product role already exists.')
    for path in [Path(p['environmentFile']),Path(p['inputRoot']),Path('/var/lib/pinkuang-product-v4')]:need(not path.exists() and not path.is_symlink(),'New product target already exists.')
    need(not Path(p['publication']['currentLink']).exists() and not Path(p['publication']['currentLink']).is_symlink(),'Product current already exists.')
    need(sha(regular(Path(p['publication']['nginxVhost'])))==p['expectedDomainVhostSha256'],'Domain vhost changed.')
def http(url):
    try:r=urllib.request.urlopen(url,timeout=8)
    except urllib.error.HTTPError as e:r=e
    with r:return r.status,r.read(4*1024*1024)
def latest_block():
    url=env(PRODUCT)['DEPLOYMENT_JOURNAL_RPC_URL']
    def rpc(method):
        req=urllib.request.Request(url,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':[]}).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=8) as r:body=json.load(r)
            need('error' not in body and re.fullmatch('0x[0-9a-fA-F]+',body.get('result','')),'Latest chain proof unavailable.')
            return int(body['result'],16)
        except Exception:raise RuntimeError('Latest chain proof unavailable.') from None
    need(rpc('eth_chainId')==56,'Wrong chain.');return rpc('eth_blockNumber')
def index_ready(p,seconds=30):
    until=time.monotonic()+seconds;last=None
    while True:
        status,body=http('http://127.0.0.1:4184/health');s=json.loads(body).get('source',{})
        now=time.time();same=lambda a,b:str(a).lower()==str(b).lower()
        ok=status==200 and s.get('chainId')==56 and s.get('complete') is True
        ok=ok and same(s.get('factory'),p['releasePair']['factory']) and same(s.get('portfolioFactory'),p['releasePair']['portfolioFactory'])
        ok=ok and s.get('indexedThrough')==s.get('observedSafeHead') and re.fullmatch('0x[0-9a-f]{64}',s.get('indexedBlockHash') or '')
        ok=ok and isinstance(s.get('indexedTimestamp'),int) and 0<=now-s['indexedTimestamp']<=90
        if ok and 0<=latest_block()-s['indexedThrough']<=120:return s
        last=s
        if time.monotonic()>=until:raise RuntimeError('New index is not complete and recent; keep publication closed.')
        time.sleep(2)
def make_env(p):
    primary=env(p['rpcSourceUnit'])['DEPLOYMENT_JOURNAL_RPC_URL'];logs=env(p['logsRpcSourceUnit'])['CHAIN_INDEX_LOGS_RPC_URL']
    for value in [primary,logs]:need(value.startswith('https://') and not re.search(r'[\s"\\]',value),'Unsafe inherited RPC.')
    return ''.join(k+'="'+v+'"\n' for k,v in {'DEPLOYMENT_JOURNAL_RPC_URL':primary,'BEMINE_READ_RPC_URL':primary,'CHAIN_INDEX_RPC_URL':primary,'CHAIN_INDEX_LOGS_RPC_URL':logs}.items()).encode()
def npm_install(root,evidence):
    need(not (root/'node_modules').exists(),'Dependencies already installed; inspect the existing installation.')
    for name in ['npm-user.config','npm-global.config']:newfile(evidence/name,b'')
    e={'PATH':'/usr/bin:/bin','HOME':str(evidence),'NODE_ENV':'production'}
    p=subprocess.run(['/usr/bin/npm','ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--userconfig='+str(evidence/'npm-user.config'),
        '--globalconfig='+str(evidence/'npm-global.config'),'--cache='+str(evidence/'npm-cache')],cwd=root,env=e,umask=0o022,capture_output=True,text=True,timeout=240)
    (evidence/'npm.log').write_text(p.stdout+p.stderr);need(p.returncode==0,'Locked runtime dependency install failed.')
    run(['/usr/bin/node','--input-type=module','-e',"await Promise.all(['./server/index.mjs','./server/chain-index/server.mjs','./server/authority-signer.mjs','./scripts/purchase-supervisor.mjs','./scripts/mining-supervisor.mjs'].map(p=>import(p)));console.log('five runtime entries imported')"],cwd=root,env=e,timeout=35)
def install_readers(p,evidence):
    check_baseline(p);before=ids(OLD+[SIGNER,'pinkuang-purchase-v2.service']);root=Path(p['runtimeRoot']);old_index=regular(UNIT_ROOT/INDEX)
    newfile(evidence/'original-index.service',old_index);npm_install(root,evidence);verify_release(p)
    gid=grp.getgrnam(RELAY_GROUP).gr_gid;user=pwd.getpwnam(PRODUCT_USER);runtime_env=make_env(p)
    # Existing HMAC remains root:root 0600. Only root-reviewed public inputs and
    # drain evidence become traversable to the relay group.
    parent=Path('/etc/pinkuang-v4');safe_path(parent);need(parent.stat().st_uid==0 and not parent.stat().st_mode&0o022,'Unsafe v4 config parent.')
    os.chown(parent,0,gid);parent.chmod(0o750)
    inp=Path(p['inputRoot']);inp.mkdir(mode=0o750);os.chown(inp,0,gid)
    for key,name in [('record','trusted-product-deployment.json'),('activation','fresh-activation.json')]:
        path=inp/name;newfile(path,regular(Path(p['inputs'][key]['sourcePath'])),0o640);os.chown(path,0,gid)
    newfile(Path(p['environmentFile']),runtime_env)
    state=Path('/var/lib/pinkuang-product-v4');state.mkdir(mode=0o700);os.chown(state,user.pw_uid,user.pw_gid)
    run(['usermod','--append','--groups',RELAY_GROUP,PRODUCT_USER])
    installed=[]
    try:
        replace(UNIT_ROOT/PRODUCT,None,p['units'][PRODUCT].encode());installed.append(PRODUCT)
        replace(UNIT_ROOT/INDEX,p['expectedIndexUnitSha256'],p['units'][INDEX].encode());installed.append(INDEX)
        run(['systemd-analyze','verify',str(UNIT_ROOT/PRODUCT),str(UNIT_ROOT/INDEX)])
        need(ids(OLD+[SIGNER,'pinkuang-purchase-v2.service'])==before,'Protected role changed.')
        run(['systemctl','daemon-reload']);run(['systemctl','restart',INDEX],timeout=55);run(['systemctl','start',PRODUCT],timeout=30)
        time.sleep(2);status,_=http('http://127.0.0.1:4187/api/journal/session');need(status==401,'Unauthenticated new product API must return 401.')
        need(ids(OLD+[SIGNER,'pinkuang-purchase-v2.service'])==before,'Protected service identity changed.')
        return {'phase':'readers-installed','sourceHead':p['sourceHead'],'product':info(PRODUCT),'index':info(INDEX),'oldServicesUnchanged':True}
    except Exception:
        if PRODUCT in installed:
            run(['systemctl','stop',PRODUCT],timeout=55)
            remove_own(UNIT_ROOT/PRODUCT,p['unitSha256'][PRODUCT])
        if INDEX in installed:replace(UNIT_ROOT/INDEX,p['unitSha256'][INDEX],old_index)
        if installed:run(['systemctl','daemon-reload'])
        if INDEX in installed:run(['systemctl','restart',INDEX],timeout=55)
        raise
def verify_installed(p):
    for u in [PRODUCT,INDEX]:need(sha(regular(UNIT_ROOT/u))==p['unitSha256'][u] and not info(u)['DropInPaths'],'Installed reader changed.')
    for key,name in [('record','trusted-product-deployment.json'),('activation','fresh-activation.json')]:need(sha(regular(Path(p['inputRoot'])/name))==p['inputs'][key]['sha256'],'Installed product input changed.')
def verify_drain(p):
    path=Path('/etc/pinkuang-v4/legacy-drain.json');proof=json.loads(regular(path));need(proof.get('schemaVersion')==1 and proof.get('chainId')==56
       and proof.get('gasWallet','').lower()==p['releasePair']['gasWallet'].lower() and proof.get('units')==['pinkuang-purchase-v2.service'],'Unexpected drain proof.')
    for name in proof['units']:
        s=info(name);need(s['ActiveState']=='inactive' and s['MainPID']=='0' and s['UnitFileState'] in ['disabled','masked'],'Old Gas sender is still active or enabled.')
    # Live canonical receipt/nonce verification is duplicated by every fresh
    # worker and signer readiness; this probe uses the same reviewed validator.
    code="import {JsonRpcProvider} from 'ethers';import {verifyFreshLegacyDrain} from './server/fresh-machine-readiness.mjs';const p=new JsonRpcProvider(process.env.RPC,56,{staticNetwork:true});try{const v=await verifyFreshLegacyDrain(p,{gasWallet:process.env.GAS});console.log(JSON.stringify(v));}finally{p.destroy();}"
    e={'PATH':'/usr/bin:/bin','RPC':env(PRODUCT)['DEPLOYMENT_JOURNAL_RPC_URL'],'GAS':p['releasePair']['gasWallet']}
    return json.loads(run(['/usr/bin/node','--input-type=module','-e',code],cwd=p['runtimeRoot'],env=e,timeout=40))
def machine_probe_args(p):
    code="import {readAuthorityIpcKey,createFreshProductReadinessReader} from '"+p['runtimeRoot']+"/server/authority-ipc.mjs';const r=await createFreshProductReadinessReader({socketPath:'/run/pinkuang-v4-relay/authority.sock',origin:'https://bemine.cc.cd',expectedGasWallet:process.env.BEMINE_EXPECTED_GAS_WALLET,key:readAuthorityIpcKey()})();console.log(JSON.stringify({ready:r.ready,relayEnabled:r.relayEnabled,attestOnly:r.attestOnly,sourceHead:r.sourceHead,identity:r.identity,checkedAt:r.checkedAt,workers:{purchase:r.workers.purchase.ready,mining:r.workers.mining.ready},oldSendersDisabled:r.drain.oldSendersDisabled}));"
    name='bemine-v4-machine-check-'+str(os.getpid())
    args=['systemd-run','--quiet','--wait','--pipe','--collect','--unit='+name,'--property=User='+PRODUCT_USER,
      '--property=Group='+PRODUCT_USER,'--property=SupplementaryGroups='+RELAY_GROUP,
      '--property=LoadCredential=authority-ipc-hmac:/etc/pinkuang-v4/authority-ipc-hmac',
      '--setenv=AUTHORITY_RELAY_SOCKET=/run/pinkuang-v4-relay/authority.sock',
      '--setenv=DEPLOYMENT_JOURNAL_ORIGIN=https://bemine.cc.cd','--setenv=BEMINE_EXPECTED_GAS_WALLET='+p['releasePair']['gasWallet'],
      '/usr/bin/node','--input-type=module','-e',code]
    return args
def machine_ready(p,evidence):
    r=json.loads(run(machine_probe_args(p),timeout=45));need(r.get('ready') is True and r.get('sourceHead')==p['sourceHead'] and r.get('oldSendersDisabled') is True,'Operational machine proof is not ready.')
    return r
def integrated_product_ready(p):
    status,raw=http('http://127.0.0.1:4187/api/journal/product-graph');body=json.loads(raw)
    need(status==200 and body.get('status')=='verified' and body.get('stage')=='fresh-active'
         and body.get('chainId')==56 and body.get('operationalReady') is True and body.get('userExitReady') is True
         and body.get('stale') is False and body.get('readMode')=='current','Integrated product API is not operational and current.')
    pair=p['releasePair'];same=lambda x,y:isinstance(x,str) and isinstance(y,str) and x.lower()==y.lower()
    for key in ['factory','portfolioFactory']:need(same(body.get(key),pair[key]),'Product API graph differs.')
    authority=body.get('freshAuthority',{});need(same(authority.get('address'),pair['authority'])
       and same(authority.get('gasWallet'),pair['gasWallet']) and same(body.get('artifactDigest'),pair['artifactDigest']),
       'Product API Authority/Gas/artifact differs.')
    return {key:body[key] for key in ['status','stage','chainId','operationalReady','userExitReady','factory','portfolioFactory','verifiedBlockNumber','verifiedBlockHash']}
def check_price(body):
    b=json.loads(body);need(b.get('status')=='ok' and b.get('chainId')==56 and b.get('quoteCurrency')=='USDT'
      and str(b.get('tokenAddress','')).lower()=='0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a'
      and str(b.get('poolAddress','')).lower()=='0x28b12792f9d81bd529bc5572434e861c9edbbbc2'
      and isinstance(b.get('priceUsdt'),(int,float)) and math.isfinite(b['priceUsdt']) and b['priceUsdt']>0,
      'Public BEM reference price is invalid.')
    for key in ['updatedAt','blockTimestamp']:
        age=time.time()-datetime.fromisoformat(b[key].replace('Z','+00:00')).timestamp()
        need(-5<=age<=120,'Public BEM reference price is stale.')
    return {'chainId':56,'blockNumber':b['blockNumber'],'updatedAt':b['updatedAt']}
def public_assets(p,html):
    matches=re.findall(r'<script[^>]+src="([^"]+)"',html.decode());paths=[s for s in matches if s.startswith('/bemine-v4/_next/') and '?' not in s]
    need(paths,'No reviewed Next.js script found.')
    path=paths[0];relative=path[len('/bemine-v4/'):];need('..' not in Path(relative).parts,'Unsafe asset path.')
    expected=regular(Path(p['productRoot'])/relative)
    with urllib.request.urlopen('https://bemine.cc.cd'+path,timeout=8) as r:
        need(r.status==200 and r.read(8*1024*1024)==expected and 'no-store' in r.headers.get('Cache-Control',''),'Public Next.js asset or cache policy differs.')
    status,price=http('https://bemine.cc.cd/bemine-v4/data/bem-price.json');need(status==200,'Public BEM reference price is missing.')
    return {'script':path,'scriptSha256':sha(expected),'price':check_price(price)}
def enable_automation(p,evidence):
    verify_installed(p);index_ready(p);drain=verify_drain(p);before=ids();old_signer=regular(UNIT_ROOT/SIGNER)
    need(sha(old_signer)==p['expectedSignerUnitSha256'] and not info(SIGNER)['DropInPaths'],'Original attestor changed.')
    for u in WORKERS:need(info(u)['LoadState']=='not-found' and not (UNIT_ROOT/u).exists(),'Worker unit already exists.')
    newfile(evidence/'original-signer.service',old_signer)
    installed=[]
    try:
        run(['systemctl','stop',SIGNER],timeout=55)
        replace(UNIT_ROOT/SIGNER,p['expectedSignerUnitSha256'],p['units'][SIGNER].encode());installed.append(SIGNER)
        for u in WORKERS:replace(UNIT_ROOT/u,None,p['units'][u].encode());installed.append(u)
        run(['systemd-analyze','verify',*[str(UNIT_ROOT/u) for u in installed]]);run(['systemctl','daemon-reload'])
        run(['systemctl','start',SIGNER],timeout=35)
        for u in WORKERS:run(['systemctl','start',u],timeout=35)
        # Worker heartbeats are produced only after successful real reads.
        deadline=time.monotonic()+60
        while True:
            try:proof=machine_ready(p,evidence);break
            except Exception:
                if time.monotonic()>=deadline:raise RuntimeError('Workers/signing did not prove readiness; senders will be stopped.')
                time.sleep(3)
        need(ids()==before,'Old protected service changed.')
        return {'phase':'automation-enabled','sourceHead':p['sourceHead'],'drain':drain,'machine':proof,'oldServicesUnchanged':True,'enabledAtBoot':False}
    except Exception:
        for u in WORKERS:
            if u in installed:run(['systemctl','stop',u],timeout=55)
        if SIGNER in installed:
            run(['systemctl','stop',SIGNER],timeout=55);replace(UNIT_ROOT/SIGNER,p['unitSha256'][SIGNER],old_signer)
        for u in WORKERS:
            if u in installed:remove_own(UNIT_ROOT/u,p['unitSha256'][u])
        run(['systemctl','daemon-reload']);run(['systemctl','start',SIGNER],timeout=35)
        # Never clear persistent nonce locks, reset journals, or restart v2.
        raise
def publish(p,evidence):
    verify_installed(p);index=index_ready(p);machine=machine_ready(p,evidence);product_proof=integrated_product_ready(p);before=ids()
    for u in [SIGNER,*WORKERS]:need(sha(regular(UNIT_ROOT/u))==p['unitSha256'][u] and info(u)['ActiveState']=='active','Automation runtime changed.')
    pub=p['publication'];vhost=Path(pub['nginxVhost']);old=regular(vhost);link=Path(pub['currentLink']);need(sha(old)==p['expectedDomainVhostSha256'],'Maintenance vhost changed.')
    need(not link.exists() and not link.is_symlink(),'Product current already exists.');newfile(evidence/'original-nginx.conf',old)
    expected={'/bemine-v4/':regular(Path(p['productRoot'])/'index.html'),'/bemine-v4/data/frontend-manifest.v4.json':regular(Path(p['productRoot'])/'data/frontend-manifest.v4.json')}
    changed=False;linked=False
    try:
        os.symlink(p['productRoot'],link);linked=True
        replace(vhost,p['expectedDomainVhostSha256'],pub['content'].encode());changed=True
        run(['nginx','-t']);run(['systemctl','reload','nginx'])
        # nginx reload returns before old workers are fully drained.
        until=time.monotonic()+25
        while True:
            if all(http('https://bemine.cc.cd'+path)==(200,raw) for path,raw in expected.items()):break
            if time.monotonic()>=until:raise RuntimeError('Public HTML/manifest bytes did not converge to the reviewed release.')
            time.sleep(1)
        for path in ['/bemine-v4/api/journal/deployment','/bemine-v4/api/journal/fresh-activation','/pinkuang-deploy-v4/']:
            need(http('https://bemine.cc.cd'+path)[0]==404,'New domain exposes a deployment route.')
        need(http('https://bemine.cc.cd/bemine-v4/api/journal/session')[0]==401,'New product session must remain authenticated.')
        need(http('https://tapeout.cc.cd/bemine-v2/')[0]==200 and http('https://tapeout.cc.cd/pinkuang-deploy-v4/')[0]==401,'Old site authentication changed.')
        need(ids()==before,'Old service process identity changed.')
        assets=public_assets(p,expected['/bemine-v4/'])
        return {'phase':'published','sourceHead':p['sourceHead'],'publicHtmlSha256':sha(expected['/bemine-v4/']),
          'publicManifestSha256':sha(expected['/bemine-v4/data/frontend-manifest.v4.json']),'index':index,'machine':machine,'product':product_proof,'assets':assets,'oldServicesUnchanged':True}
    except Exception:
        if changed:replace(vhost,pub['sha256'],old);run(['nginx','-t']);run(['systemctl','reload','nginx'])
        if linked:need(link.is_symlink() and os.readlink(link)==p['productRoot'],'Product link rollback CAS differs.');link.unlink()
        raise
def finalize_enable(p,evidence):
    pub=p['publication'];link=Path(pub['currentLink'])
    need(link.is_symlink() and os.readlink(link)==p['productRoot']
      and sha(regular(Path(pub['nginxVhost'])))==pub['sha256'],'Reviewed product is not published.')
    index_ready(p);machine_ready(p,evidence);integrated_product_ready(p)
    old=info('pinkuang-purchase-v2.service');need(old['ActiveState']=='inactive' and old['MainPID']=='0' and old['UnitFileState'] in ['disabled','masked'],'Old Gas sender was re-enabled.')
    for u in p['units']:
        need(sha(regular(UNIT_ROOT/u))==p['unitSha256'][u] and info(u)['ActiveState']=='active' and not info(u)['DropInPaths'],'Final runtime differs.')
    newly=[]
    try:
        for u in p['units']:
            state=info(u)['UnitFileState'];need(state in ['enabled','disabled'],'Unexpected boot policy.')
            if state=='disabled':run(['systemctl','enable',u]);newly.append(u)
        need(all(info(u)['UnitFileState']=='enabled' for u in p['units']),'New boot policy was not applied.')
        return {'phase':'persistent-enabled','units':list(p['units']),'oldSenderRemainsDisabled':True,'restartPerformed':False}
    except Exception:
        for u in reversed(newly):run(['systemctl','disable',u])
        raise
def main():
    a=argparse.ArgumentParser();a.add_argument('--plan',type=Path,required=True);a.add_argument('--plan-sha256',required=True)
    a.add_argument('--mode',choices=['dry-run','install-readers','enable-automation','publish','finalize-enable'],required=True);a.add_argument('--evidence',type=Path,required=True)
    opt=a.parse_args();need(os.geteuid()==0,'Root is required.');p=load_plan(opt.plan,opt.plan_sha256);verify_release(p)
    if opt.mode=='dry-run':check_baseline(p);print(json.dumps({'dryRun':True,'sourceHead':p['sourceHead'],'roles':list(p['units']),'sendersStarted':False}));return
    need(str(opt.evidence).startswith('/root/pinkuang-v4-product/') and not opt.evidence.exists(),'New root-private evidence directory required.')
    opt.evidence.mkdir(parents=True,mode=0o700);opt.evidence.parent.chmod(0o700)
    result={'atUtc':datetime.now(timezone.utc).isoformat(),'planSha256':opt.plan_sha256,'mode':opt.mode}
    try:
        fn={'install-readers':install_readers,'enable-automation':enable_automation,'publish':publish,'finalize-enable':finalize_enable}[opt.mode]
        result.update(fn(p,opt.evidence));result['success']=True
    except Exception as e:result.update(success=False,error=str(e));raise
    finally:
        (opt.evidence/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':main()
