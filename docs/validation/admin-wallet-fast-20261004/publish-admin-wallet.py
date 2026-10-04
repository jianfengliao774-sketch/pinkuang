from pathlib import Path
import datetime,fcntl,hashlib,json,os,shutil,subprocess,sys,tarfile,urllib.request
SOURCE='597e24f92c3d19d0641001745e8d66eefa91c9c6'
OLD='af164a6ad76427e53a4bb1a6e1e907f96dae998a'
BASE=Path('/root/bemine-admin-wallet-release-20261004-597e24f92c3d')
ROOT=Path('/var/www/bemine-v5'); CURRENT=ROOT/'current'; DEST=ROOT/'releases'/('admin-wallet-'+SOURCE[:12])
UNITS=['pinkuang-index-v5','pinkuang-product-v5','pinkuang-v5-purchase','pinkuang-v5-mining','pinkuang-v5-signer','pinkuang-v5-price','pinkuang-deploy-latest','pinkuang-deploy-v5']
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p): return json.loads(Path(p).read_text())
def save(name,obj):
    p=BASE/name;p.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n');p.chmod(0o600)
def files(root):
    out={}
    for p in sorted(root.rglob('*')):
        assert not p.is_symlink(),str(p)
        if p.is_file():out[str(p.relative_to(root))]=sha(p)
    return out
def digest(mapping):return hashlib.sha256(''.join(f'{name}\0{value}\n' for name,value in sorted(mapping.items())).encode()).hexdigest()
def bindings():
    out={}
    for name in UNITS:
        values=dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',name,'--property=WorkingDirectory,FragmentPath,MainPID,ActiveState,SubState,InvocationID,ExecMainStartTimestamp'],text=True).splitlines())
        assert values['ActiveState']=='active' and values['SubState']=='running',name
        out[name]=values
    return out
def protected():
    paths=set(Path('/etc/nginx').rglob('*'))
    paths.update(Path('/etc/systemd/system').glob('pinkuang*.service'))
    paths.update(Path('/etc/systemd/system').glob('pinkuang*.service.d/*'))
    paths.update([Path('/etc/pinkuang-v5/trusted-product-deployment.json'),Path('/etc/pinkuang-v5/fresh-activation.json')])
    return {str(p):sha(p) for p in sorted(paths) if p.is_file()}
def runtime_code(service):
    out={}
    for root in sorted(set(v['WorkingDirectory'] for v in service.values())):
        rows={}
        for base,dirs,names in os.walk(root):
            dirs[:]=[name for name in dirs if name not in ['node_modules','.git'] and not name.startswith('.')]
            for name in names:
                p=Path(base)/name
                if name.startswith('.env') or p.suffix in ['.key','.pem','.p12','.pfx'] or p.is_symlink():continue
                if p.is_file():rows[str(p.relative_to(root))]=sha(p)
        out[root]=rows
    return out
def unchanged(before):
    assert CURRENT.is_symlink() and str(CURRENT.resolve())==before['previous'],'Current changed'
    assert files(CURRENT.resolve())==before['files'],'Active static bytes changed'
    assert protected()==before['protected'],'Nginx/deployment/systemd changed'
    assert bindings()==before['bindings'],'A runtime service changed'
    assert runtime_code(before['bindings'])==before['runtimeCode'],'Backend or deployment-console source changed'
def get(path):
    with urllib.request.urlopen('https://bemine.cc.cd'+path,timeout=12) as r:return r.status,r.read()
BASE.mkdir(parents=True,exist_ok=True,mode=0o700);BASE.chmod(0o700)
with (ROOT/'.mobile-ui-release.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    activation=os.open('/run/pinkuang-v5-activation.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    fcntl.flock(activation,fcntl.LOCK_EX|fcntl.LOCK_NB)
    assert sys.argv[1]=='publish' and not DEST.exists() and not (BASE/'before.json').exists(),'Inspect prior attempt before reuse'
    previous=CURRENT.resolve();meta=read(previous/'fresh-product-release.json')
    assert meta['frontendSourceHead']==OLD and previous==ROOT/'releases/catalog-prices-af164a6ad764'
    service=bindings();before={'previous':str(previous),'metadata':meta,'files':files(previous),'protected':protected(),'bindings':service,'runtimeCode':runtime_code(service)}
    save('before.json',before);unchanged(before)
    # Existing immutable release is the rollback copy; save its exact pre-overlay inventory.
    candidate=BASE/'candidate';assert candidate.is_dir()
    build=read(candidate/'fresh-product-release.json');built=files(candidate);built.pop('fresh-product-release.json')
    assert build['frontendSourceHead']==SOURCE and digest(built)==build['contentSha256'] and len(built)==build['fileCount']
    for key in ['manifestSha256','artifactDigest','factory','portfolioFactory','authority','gasWallet','deployment']:
        assert build[key]==meta[key],key
    assert sha(candidate/'data/frontend-manifest.v5.json')==sha(previous/'data/frontend-manifest.v5.json')
    assert sha(BASE/'candidate.tar.gz')==sys.argv[2],'Transferred artifact differs'
    with tarfile.open(BASE/'candidate.tar.gz') as archive:
        archived={str(Path(member.name)):hashlib.sha256(archive.extractfile(member).read()).hexdigest() for member in archive.getmembers() if member.isfile()}
    assert archived==files(candidate),'Extracted candidate differs from transferred archive'
    shutil.copytree(candidate,DEST)
    for name in ['frontend-manifest.json','frontend-manifest.v4.json','fresh-product-manifest.json','sale-policy-upgrade.formal.json']:
        for p in [DEST/name,DEST/'data'/name]:
            if p.exists():p.unlink()
    retained=0
    for p in (previous/'_next/static').rglob('*'):
        if not p.is_file():continue
        out=DEST/'_next/static'/p.relative_to(previous/'_next/static')
        if out.exists():assert sha(out)==sha(p),'Immutable collision'
        else:out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,out);retained+=1
    final=files(DEST);final.pop('fresh-product-release.json')
    build.update({key:meta[key] for key in ['runtimeSourceHead','machineSourceHead','signerSourceHead','runtimeServiceDirectories']})
    build.update({'sourceCommit':SOURCE,'uiOnlyRelease':True,'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'previousFrontendSourceHead':OLD,'updateScope':'Administrator confirmation invokes the exact previewed wallet signature immediately; existing canonical public links retained',
        'buildContentSha256':build['contentSha256'],'buildFileCount':build['fileCount'],'retainedImmutableChunks':retained,
        'contentSha256':digest(final),'fileCount':len(final),'contentSha256Scope':'Sorted file path and SHA256 list; excludes fresh-product-release.json'})
    (DEST/'fresh-product-release.json').write_text(json.dumps(build,indent=2)+'\n')
    for p in [DEST,*DEST.rglob('*')]:p.chmod(0o755 if p.is_dir() else 0o644)
    unchanged(before);switched=False
    try:
        tmp=ROOT/('.admin-wallet-'+SOURCE[:12]);assert not tmp.exists() and not tmp.is_symlink()
        tmp.symlink_to(DEST,target_is_directory=True);os.replace(tmp,CURRENT);switched=True
        status,body=get('/bemine-v5/fresh-product-release.json');assert status==200 and json.loads(body)['frontendSourceHead']==SOURCE
        checks={}
        for path in ['/', '/?lang=zh#operator','/mobile-review.html','/preview.html','/pinkuang-target-owner-upgrade/','/bemine-v5/api/chain-index/v1/display/stats']:
            status,body=get(path);assert status==200,path
            checks[path]={'status':status,'sha256':hashlib.sha256(body).hexdigest()}
            if path=='/':assert body== (DEST/'index.html').read_bytes(),'Root serves another release'
            if path=='/bemine-v5/api/journal/product-graph':
                graph=json.loads(body);assert graph['factory'].lower()==meta['factory'].lower() and graph['stage']=='fresh-active'
        assert bindings()==before['bindings'] and protected()==before['protected'] and runtime_code(before['bindings'])==before['runtimeCode']
        assert files(previous)==before['files'],'Previous release changed'
        receipt={'published':True,'sourceHead':SOURCE,'previous':str(previous),'current':str(DEST),'manifestSha256':build['manifestSha256'],
            'buildContentSha256':build['buildContentSha256'],'contentSha256':build['contentSha256'],'fileCount':build['fileCount'],
            'retainedImmutableChunks':retained,'runtimeServicesUnchanged':True,'nginxUnchanged':True,'backendAndUpgradeConsoleUnchanged':True,
            'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'httpChecks':checks}
        save('publication.json',receipt);print(json.dumps(receipt,ensure_ascii=False))
    except BaseException:
        if switched and CURRENT.resolve()==DEST:
            tmp=ROOT/('.admin-wallet-rollback-'+SOURCE[:12]);tmp.symlink_to(previous,target_is_directory=True);os.replace(tmp,CURRENT)
            save('rollback.json',{'restored':str(previous),'sourceHead':SOURCE})
        raise
