#!/usr/bin/env python3
"""Install reviewed v5 packages on the existing host. Does not publish nginx or deploy contracts."""
from pathlib import Path
import hashlib, json, os, pwd, grp, shutil, subprocess, tarfile
UPLOAD = Path('/root/bemine-v5-upload')
SOURCE = 'dea3a78b51352df45771ce6d54043b874e70383e'
RELEASE = 'v5-product-' + SOURCE[:12]
RUNTIME = Path('/srv/pinkuang-v5/releases') / RELEASE
STATIC = Path('/var/www/bemine-v5/releases') / RELEASE
PRICE = Path('/opt/bemine-v5-price') / RELEASE
SHA = {'runtime.tgz':'a6ca74e9e21ebfb0b13335497d9749ffe80d8952f4573cb85e826fa5acc01bc9',
       'static.tgz':'0c427a7c2e710a60103e8ec4fad9fc8ff138d2326610dba441e33d2422bf6a05'}
def run(*args, **kwargs):return subprocess.run(args, check=True, **kwargs)
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def extract(name, destination):
    assert digest(UPLOAD/name) == SHA[name], 'Release archive digest differs'
    assert not destination.exists(), 'Never overwrite a release'
    destination.mkdir(parents=True)
    with tarfile.open(UPLOAD/name, 'r:gz') as archive:
        for entry in archive.getmembers():
            assert not entry.name.startswith('/') and '..' not in Path(entry.name).parts
            assert entry.isdir() or entry.isfile(), 'Links/devices forbidden'
        archive.extractall(destination)
    for p in [destination, *destination.rglob('*')]:os.chmod(p, 0o755 if p.is_dir() else 0o644)
def directory(path, user, group, mode):
    p=Path(path);p.mkdir(parents=True,exist_ok=True)
    assert not p.is_symlink()
    os.chown(p,pwd.getpwnam(user).pw_uid,grp.getgrnam(group).gr_gid);os.chmod(p,mode)
def write(path, data, mode=0o644):
    p=Path(path);p.write_text(data);os.chmod(p,mode)
assert os.getuid()==0
assert not Path('/var/www/bemine-v5/current').exists(), 'Existing v5 must use a release update'
for user in ['pinkuang-v5-product','pinkuang-v5-signer']:
    try:pwd.getpwnam(user)
    except KeyError:run('useradd','--system','--user-group','--no-create-home','--shell','/usr/sbin/nologin',user)
    run('usermod','-aG','pinkuang-v4-relay',user)
extract('runtime.tgz',RUNTIME);extract('static.tgz',STATIC)
metadata=json.loads((RUNTIME/'public/fresh-release-manifest.json').read_text())
assert metadata['sourceHead']==SOURCE
for name, row in metadata['files'].items():assert digest(RUNTIME/name)==row['sha256'], name
front=json.loads((STATIC/'fresh-product-release.json').read_text())
assert front['frontendSourceHead']==SOURCE and front['basePath']=='/bemine-v5'
assert front['factory'].lower()=='0x4a866e14816d8339a530c6c82300dbbb6544b37c'
console=Path('/srv/pinkuang-deploy-v5/current').resolve()
if digest(console/'package-lock.json')==digest(RUNTIME/'package-lock.json'):
    (RUNTIME/'node_modules').symlink_to(console/'node_modules',target_is_directory=True)
else:run('npm','ci','--omit=dev','--ignore-scripts',cwd=RUNTIME)
directory('/etc/pinkuang-v5','root','pinkuang-v4-relay',0o750)
for path, user, group, mode in [
 ('/var/lib/pinkuang-product-v5','pinkuang-v5-product','pinkuang-v5-product',0o700),
 ('/var/lib/pinkuang-index-v5','pinkuang-v5-product','pinkuang-v5-product',0o700),
 ('/var/lib/pinkuang-v5-signer','pinkuang-v5-signer','pinkuang-v4-relay',0o700),
 ('/var/lib/pinkuang-v5-public','root','root',0o755),
 ('/var/lib/pinkuang-v5-public/api','pinkuang-v5-product','pinkuang-v5-product',0o755),
 ('/var/lib/pinkuang-v5-public/signer','pinkuang-v5-signer','pinkuang-v4-relay',0o755),
 ('/var/lib/pinkuang-v5-public/price','www-data','www-data',0o755)]:directory(path,user,group,mode)
for suffix in ['keeper','authority','authority/listing-expiry','purchase','mining','readiness']:
    directory('/var/lib/pinkuang-v5-signer/'+suffix,'pinkuang-v5-signer','pinkuang-v4-relay',0o700)
for source,target in [('v5-deployment-public.json','trusted-product-deployment.json'),('fresh-activation.json','fresh-activation.json')]:
    shutil.copyfile(UPLOAD/source,Path('/etc/pinkuang-v5')/target);os.chmod(Path('/etc/pinkuang-v5')/target,0o644)
# Copy existing protected RPC configuration without exposing its values.
shutil.copyfile('/etc/pinkuang-v4/product-runtime.env','/etc/pinkuang-v5/rpc.env');os.chmod('/etc/pinkuang-v5/rpc.env',0o600)
PRICE.mkdir(parents=True)
shutil.copytree(UPLOAD/'price/scripts',PRICE/'scripts');shutil.copytree(UPLOAD/'price/lib',PRICE/'lib')
for source in (UPLOAD/'runtime').glob('*.in'):
    text=source.read_text().replace('@RUNTIME@',str(RUNTIME)).replace('@PRICE_RUNTIME@',str(PRICE)).replace('@INDEX_SHA@',metadata['indexManifestSha256'])
    assert '@RUNTIME@' not in text and '@INDEX_SHA@' not in text
    target=Path('/etc/systemd/system')/source.name[:-3] if '.service.' in source.name else Path('/etc/pinkuang-v5')/source.name[:-3]
    write(target,text)
run('systemctl','daemon-reload')
# Retire the remaining read-only attestor before transferring its protected IPC socket.
run('systemctl','disable','--now','pinkuang-v4-signer.service')
try:run('node',str(UPLOAD/'verify-cutover.mjs'),str(RUNTIME))
except BaseException:
    run('systemctl','start','pinkuang-v4-signer.service') # Existing paused-attestation override stays in place.
    raise
units=['pinkuang-index-v5','pinkuang-product-v5','pinkuang-v5-purchase','pinkuang-v5-mining','pinkuang-v5-signer','pinkuang-v5-price']
run('systemctl','enable','--now',*units)
print(json.dumps({'installed':True,'published':False,'runtime':str(RUNTIME),'static':str(STATIC),'source':SOURCE}))
