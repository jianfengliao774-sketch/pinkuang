"""Stage and switch only the existing standalone read helper, with rollback."""
from pathlib import Path
import datetime, fcntl, hashlib, json, os, shutil, subprocess, sys, time
BASE=Path('/root/bemine-upgrade-null-id-throttle-20261004')
UNIT=Path('/etc/systemd/system/pinkuang-target-owner-read.service')
ENV=Path('/etc/pinkuang-target-owner-read.env')
OLD=Path('/srv/pinkuang-target-owner-read/releases/86d635e452cba857e820108c7218b8fc3cd5d237')
FILES=['deploy/server/live-data-proxy.mjs','deploy/server/target-owner-read-server.mjs','deploy/server/request-limiter.mjs']
UNITS=['pinkuang-index-v5','pinkuang-product-v5','pinkuang-v5-purchase','pinkuang-v5-mining','pinkuang-v5-signer','pinkuang-v5-price','pinkuang-deploy-latest','pinkuang-deploy-v5','nginx']
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(name,value):
 p=BASE/name;p.write_text(json.dumps(value,indent=2)+'\n');p.chmod(0o600)
def read(name):return json.loads((BASE/name).read_text())
def service(name):
 v=dict(x.split('=',1) for x in subprocess.check_output(['systemctl','show',name,'--property=WorkingDirectory,MainPID,ActiveState,SubState,InvocationID,NRestarts'],text=True).splitlines())
 assert v['ActiveState']=='active' and v['SubState']=='running',name
 return v
def tree(root):return {str(p.relative_to(root)):sha(p) for p in sorted(Path(root).rglob('*')) if p.is_file()}
def protected():
 formal=Path('/var/www/bemine-v5/current').resolve(strict=True)
 ui=Path('/srv/pinkuang-target-owner-upgrade/current').resolve(strict=True)
 return {'services':{name:service(name) for name in UNITS},'formalPath':str(formal),'formalFiles':tree(formal),'upgradePath':str(ui),'upgradeFiles':tree(ui),'nginxFiles':tree('/etc/nginx'),'envSha256':sha(ENV)}
def environment(pid):
 return dict(row.decode().split('=',1) for row in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in row)
def binding(dest):
 v=service('pinkuang-target-owner-read');pid=int(v['MainPID'])
 assert v['WorkingDirectory']==str(dest) and Path(f'/proc/{pid}/cwd').resolve()==dest
 cmd=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
 assert cmd[:2]==[b'/usr/bin/node',str(dest/'deploy/server/target-owner-read-server.mjs').encode()]
 rows=subprocess.check_output(['ss','-H','-ltnp','( sport = :4228 )'],text=True).strip().splitlines()
 assert len(rows)==1 and '127.0.0.1:4228' in rows[0] and f'pid={pid},' in rows[0]
 return v
def candidate_binding(dest,pid):
 assert Path(f'/proc/{pid}/cwd').resolve()==dest
 cmd=Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
 assert cmd[:2]==[b'/usr/bin/node',str(dest/'deploy/server/target-owner-read-server.mjs').encode()]
 rows=subprocess.check_output(['ss','-H','-ltnp','( sport = :4229 )'],text=True).strip().splitlines()
 assert len(rows)==1 and '127.0.0.1:4229' in rows[0] and f'pid={pid},' in rows[0]
def stop_candidate(dest,pid):
 if not Path(f'/proc/{pid}').exists():return
 candidate_binding(dest,pid);os.kill(pid,15)
BASE.mkdir(exist_ok=True,mode=0o700);BASE.chmod(0o700)
fd=os.open('/run/pinkuang-target-owner-read-release.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
pins=read('source-pins.json');head=pins['sourceCommit']
assert len(head)==40 and all(c in '0123456789abcdef' for c in head)
DEST=OLD.parent/head
assert set(pins['files'])==set(FILES)
mode=sys.argv[1]
if mode=='prepare':
 assert not (BASE/'read-before.json').exists() and not DEST.exists()
 before=protected();old_binding=binding(OLD)
 assert Path(before['formalPath']).name=='official-listing-capacity-80e754215a41'
 assert Path(before['upgradePath']).name=='d5062d2ee45affeb59ae6bc5b92ba463d8d7bb61'
 assert '/pinkuang-target-owner-upgrade/api/rpc' in Path('/etc/nginx/snippets/pinkuang-target-owner-upgrade.conf').read_text()
 assert ENV.stat().st_mode&0o777==0o600
 assert all(sha(BASE/'candidate'/p)==pins['files'][p] for p in FILES)
 assert not subprocess.check_output(['ss','-H','-ltnp','( sport = :4229 )'],text=True).strip()
 old_unit=UNIT.read_text();assert old_unit.count(str(OLD))==2
 (BASE/'read-old-unit').write_text(old_unit);(BASE/'read-old-unit').chmod(0o600)
 save('read-before.json',before);save('read-old-binding.json',old_binding)
 DEST.mkdir(mode=0o755)
 for name in FILES:
  p=DEST/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(BASE/'candidate'/name,p);p.chmod(0o644)
 log=BASE/'candidate-read.log';handle=log.open('wb');log.chmod(0o600)
 env=environment(old_binding['MainPID']);env['TARGET_OWNER_READ_PORT']='4229'
 process=subprocess.Popen(['/usr/bin/node',str(DEST/'deploy/server/target-owner-read-server.mjs')],cwd=DEST,env=env,stdin=subprocess.DEVNULL,stdout=handle,stderr=subprocess.STDOUT,start_new_session=True)
 handle.close()
 try:
  time.sleep(.3);assert process.poll() is None;candidate_binding(DEST,process.pid)
  save('read-prepared.json',{'sourceCommit':head,'files':pins['files'],'candidatePid':process.pid,'unitSha256':sha(UNIT),'chainActionsPerformed':False})
  assert protected()==before and binding(OLD)==old_binding
 except BaseException:
  if process.poll() is None:process.terminate()
  raise
 print(json.dumps({'prepared':True,'sourceCommit':head,'candidatePort':4229,'chainActionsPerformed':False}))
elif mode=='activate':
 original=read('read-before.json');reconciliation=read('read-baseline-reconciliation.json');before=read('read-activation-baseline.json')
 assert reconciliation['originalBaselineSha256']==sha(BASE/'read-before.json') and reconciliation['activationBaselineSha256']==sha(BASE/'read-activation-baseline.json')
 assert set(before)==set(original)
 assert all(before[k]==original[k] for k in original if k not in {'formalPath','formalFiles','upgradePath','upgradeFiles'})
 assert {k for k in original if original[k]!=before[k]}==set(reconciliation['allowedChangedKeys'])=={'formalPath','formalFiles','upgradePath','upgradeFiles'}
 prepared=read('read-prepared.json');proof=read('local-proof.json')
 assert proof['ok'] and proof['chainActionsPerformed'] is False and proof['elapsedMs']<60000
 assert proof['sourceCommit']==head and proof['readEndpoint']=='candidate-loopback-4229'
 stamp=datetime.datetime.fromisoformat(proof['generatedAt'])
 assert 0<=(datetime.datetime.now(datetime.timezone.utc)-stamp).total_seconds()<300
 assert protected()==before and binding(OLD)==read('read-old-binding.json')
 candidate_binding(DEST,prepared['candidatePid'])
 assert sha(UNIT)==prepared['unitSha256'] and tree(DEST)==prepared['files']
 old_unit=(BASE/'read-old-unit').read_text();new_unit=old_unit.replace(str(OLD),str(DEST))
 tmp=UNIT.with_suffix('.tmp');assert not tmp.exists();tmp.write_text(new_unit);tmp.chmod(0o644);os.replace(tmp,UNIT)
 try:
  subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','pinkuang-target-owner-read'],check=True)
  time.sleep(.3);after=binding(DEST);assert after['NRestarts']=='0' and protected()==before
  env=environment(after['MainPID']);old_env=environment(prepared['candidatePid'])
  for key in ['BEMINE_READ_RPC_URL','BEMINE_READ_TRANSACTION_RPC_URL']:assert env[key]==old_env[key]
  save('read-publication.json',{'published':True,'sourceCommit':head,'previousSourceCommit':OLD.name,'helperBinding':after,'sourcePins':pins['files'],'onlyReadHelperRestarted':True,'formalAndUpgradeStaticUnchanged':True,'environmentUnchanged':True,'nginxUnchanged':True,'chainActionsPerformed':False,'localProof':proof,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
  print(json.dumps({'published':True,'sourceCommit':head,'onlyReadHelperRestarted':True,'chainActionsPerformed':False}))
 except BaseException:
  assert UNIT.read_text()==new_unit
  tmp=UNIT.with_suffix('.rollback.tmp');assert not tmp.exists();tmp.write_text(old_unit);tmp.chmod(0o644);os.replace(tmp,UNIT)
  subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','pinkuang-target-owner-read'],check=True)
  time.sleep(.3);binding(OLD);assert protected()==before;save('read-rollback.json',{'restored':OLD.name});raise
 finally:
  stop_candidate(DEST,prepared['candidatePid'])
elif mode=='abort':
 prepared=read('read-prepared.json');assert prepared['sourceCommit']==head
 stop_candidate(DEST,prepared['candidatePid'])
 print(json.dumps({'candidateStopped':True,'businessServicesChanged':False}))
else:raise ValueError('unknown publication mode')
