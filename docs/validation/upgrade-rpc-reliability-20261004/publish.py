from pathlib import Path
import datetime, fcntl, hashlib, json, os, shutil, subprocess, sys, time
SOURCE = '86d635e452cba857e820108c7218b8fc3cd5d237'
BASE = Path('/root/bemine-upgrade-rpc-release-20261004')
DEST = Path('/srv/pinkuang-target-owner-read/releases') / SOURCE
ENV = Path('/etc/pinkuang-target-owner-read.env')
UNIT = Path('/etc/systemd/system/pinkuang-target-owner-read.service')
SNIPPET = Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf')
UNITS = ['pinkuang-index-v5','pinkuang-product-v5','pinkuang-v5-purchase','pinkuang-v5-mining','pinkuang-v5-signer','pinkuang-v5-price','pinkuang-deploy-latest','pinkuang-deploy-v5']
FILES = ['deploy/server/live-data-proxy.mjs','deploy/server/target-owner-read-server.mjs','deploy/server/request-limiter.mjs']
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p): return json.loads(Path(p).read_text())
def save(name, obj):
    p = BASE / name
    p.write_text(json.dumps(obj, indent=2) + '\n')
    p.chmod(0o600)
def state():
    out = {}
    for name in UNITS:
        v = dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show',name,'--property=WorkingDirectory,MainPID,ActiveState,SubState,InvocationID'],text=True).splitlines())
        assert v['ActiveState'] == 'active' and v['SubState'] == 'running', name
        out[name] = v
    return out
def tree(root):
    root = Path(root)
    return {str(p.relative_to(root)): sha(p) for p in sorted(root.rglob('*')) if p.is_file()}
def baseline():
    formal = Path('/var/www/bemine-v5/current').resolve(strict=True)
    upgrade = Path('/srv/pinkuang-target-owner-upgrade/current').resolve(strict=True)
    return {'services':state(),'formalPath':str(formal),'formalFiles':tree(formal),'upgradePath':str(upgrade),'upgradeFiles':tree(upgrade),'nginxFiles':tree('/etc/nginx')}
def unchanged(before, route_hash=None):
    current = baseline()
    expected = before.copy()
    if route_hash is not None:
        expected['nginxFiles'] = dict(before['nginxFiles'])
        expected['nginxFiles']['snippets/pinkuang-target-owner-upgrade.conf'] = route_hash
    assert current == expected, 'Protected runtime, static release or unrelated nginx changed'
def process_environment(pid):
    return dict(row.decode().split('=',1) for row in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in row)
def env_quote(v):
    assert isinstance(v,str) and '\n' not in v and '\r' not in v and '\0' not in v
    return json.dumps(v)
def listeners():
    return subprocess.check_output(['ss','-H','-ltnp','( sport = :4228 )'],text=True).strip().splitlines()
def new_binding():
    value = dict(line.split('=',1) for line in subprocess.check_output(['systemctl','show','pinkuang-target-owner-read','--property=MainPID,ActiveState,SubState,WorkingDirectory,InvocationID,NRestarts'],text=True).splitlines())
    assert value['ActiveState']=='active' and value['SubState']=='running' and value['NRestarts']=='0'
    assert value['WorkingDirectory']==str(DEST)
    pid=int(value['MainPID'])
    assert pid>0 and Path(f'/proc/{pid}/cwd').resolve()==DEST
    command=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    assert command[:2]==[b'/usr/bin/node',str(DEST/'deploy/server/target-owner-read-server.mjs').encode()]
    rows=listeners()
    assert len(rows)==1 and '127.0.0.1:4228' in rows[0] and f'pid={pid},' in rows[0]
    return value
BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
BASE.chmod(0o700)
lockfd = os.open('/run/pinkuang-target-owner-read-release.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(lockfd, fcntl.LOCK_EX|fcntl.LOCK_NB)
mode = sys.argv[1]
if mode == 'prepare':
    assert not (BASE/'before.json').exists() and not DEST.exists() and not ENV.exists() and not UNIT.exists(), 'Inspect existing attempt before reuse'
    pins = read(BASE/'source-pins.json')
    assert pins['sourceCommit'] == SOURCE and set(pins['files']) == set(FILES)
    assert all(sha(BASE/'candidate'/p) == pins['files'][p] for p in FILES)
    assert listeners()==[], 'Port 4228 is already used'
    before = baseline()
    assert read(Path(before['formalPath'])/'fresh-product-release.json')['frontendSourceHead'] == 'b61a835a50ba876ddcd3f046ad2160d3041ec266'
    assert Path(before['upgradePath']).name == 'd5062d2ee45affeb59ae6bc5b92ba463d8d7bb61'
    original = SNIPPET.read_text()
    assert original.count('proxy_pass http://127.0.0.1:4227/api/rpc;') == 1
    assert original.count('location = /pinkuang-target-owner-upgrade/api/rpc') == 1
    save('before.json', before)
    (BASE/'nginx-original.conf').write_text(original)
    (BASE/'nginx-original.conf').chmod(0o600)
    a = process_environment(before['services']['pinkuang-product-v5']['MainPID'])
    b = process_environment(before['services']['pinkuang-deploy-v5']['MainPID'])
    archive = a.get('BEMINE_READ_RPC_URL') or a.get('DEPLOYMENT_JOURNAL_RPC_URL')
    transaction = b.get('BEMINE_READ_RPC_URL') or b.get('DEPLOYMENT_JOURNAL_RPC_URL')
    assert archive and transaction and archive != transaction
    DEST.mkdir(parents=True, mode=0o755)
    for name in FILES:
        out = DEST/name
        out.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        shutil.copyfile(BASE/'candidate'/name, out)
        out.chmod(0o644)
    for folder in [DEST.parent.parent, DEST.parent]: folder.chmod(0o755)
    env_text = 'BEMINE_READ_RPC_URL='+env_quote(archive)+'\nBEMINE_READ_TRANSACTION_RPC_URL='+env_quote(transaction)+'\nTARGET_OWNER_READ_PORT=4228\n'
    fd = os.open(ENV,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as out: out.write(env_text)
    unit = """[Unit]
Description=BEMine standalone upgrade read-only RPC
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory={dest}
EnvironmentFile=/etc/pinkuang-target-owner-read.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node {dest}/deploy/server/target-owner-read-server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=true
MemoryMax=256M

[Install]
WantedBy=multi-user.target
""".format(dest=DEST)
    UNIT.write_text(unit)
    UNIT.chmod(0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','pinkuang-target-owner-read'],check=True)
    time.sleep(0.3)
    binding=new_binding()
    unchanged(before)
    save('prepared.json',{'sourceCommit':SOURCE,'files':pins['files'],'unitSha256':sha(UNIT),'binding':binding,'environmentValuesPublished':False,'existingServicesUnchanged':True,'chainActionsPerformed':False,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
    print(json.dumps({'prepared':True,'sourceCommit':SOURCE,'chainActionsPerformed':False}))
elif mode == 'activate':
    before = read(BASE/'before.json')
    prepared = read(BASE/'prepared.json')
    assert prepared['sourceCommit'] == SOURCE
    proof = read(BASE/'local-proof.json')
    assert proof['ok'] and proof['chainActionsPerformed'] is False and proof['elapsedMs'] < 60000
    assert proof['sourceCommit']==SOURCE and proof['readEndpoint']=='dedicated-loopback-4228'
    checked_at=datetime.datetime.fromisoformat(proof['generatedAt'])
    assert 0 <= (datetime.datetime.now(datetime.timezone.utc)-checked_at).total_seconds() < 300
    assert new_binding()==prepared['binding']
    assert tree(DEST) == prepared['files'] and sha(UNIT) == prepared['unitSha256']
    unchanged(before)
    original = (BASE/'nginx-original.conf').read_text()
    assert SNIPPET.read_text() == original
    updated = original.replace('proxy_pass http://127.0.0.1:4227/api/rpc;','proxy_pass http://127.0.0.1:4228/api/rpc;')
    temp = SNIPPET.with_suffix('.tmp')
    assert not temp.exists()
    temp.write_text(updated)
    temp.chmod(SNIPPET.stat().st_mode & 0o777)
    os.replace(temp,SNIPPET)
    try:
        subprocess.run(['nginx','-t'],check=True)
        subprocess.run(['systemctl','reload','nginx'],check=True)
        unchanged(before,hashlib.sha256(updated.encode()).hexdigest())
        assert new_binding()==prepared['binding']
        receipt = {'published':True,'sourceCommit':SOURCE,'location':'/pinkuang-target-owner-upgrade/api/rpc','beforePort':4227,'afterPort':4228,'existingServicesUnchanged':True,'formalAndUpgradeStaticUnchanged':True,'onlyOneNginxLocationChanged':True,'chainActionsPerformed':False,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'localProof':proof,'unitSha256':sha(UNIT),'sourcePins':prepared['files']}
        save('publication.json',receipt)
        print(json.dumps(receipt))
    except BaseException:
        if SNIPPET.read_text() == updated:
            rollback_temp = SNIPPET.with_suffix('.rollback.tmp')
            assert not rollback_temp.exists()
            rollback_temp.write_text(original)
            rollback_temp.chmod(SNIPPET.stat().st_mode & 0o777)
            assert SNIPPET.read_text() == updated
            os.replace(rollback_temp, SNIPPET)
            subprocess.run(['nginx','-t'],check=True)
            subprocess.run(['systemctl','reload','nginx'],check=True)
            unchanged(before)
            save('rollback.json',{'restored':4227,'chainActionsPerformed':False})
        raise
else:
    raise ValueError('Unknown phase')
