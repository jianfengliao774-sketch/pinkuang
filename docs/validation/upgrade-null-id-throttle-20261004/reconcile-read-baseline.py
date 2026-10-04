"""Pin two already-published static releases without weakening protected runtime checks."""
from pathlib import Path
import datetime, json
s=Path('/root/bemine-upgrade-null-id-throttle-20261004/publish-read.py').read_text()
exec(s[:s.index('BASE.mkdir(')])
original=read('read-before.json');current=protected()
assert {k for k in original if original[k]!=current[k]}=={'formalPath','formalFiles','upgradePath','upgradeFiles'}
assert binding(OLD)==read('read-old-binding.json')
formal=Path('/root/bemine-assets-activity-release-20261004-172200')
receipt=json.loads((formal/'activation-receipt.json').read_text())
verified=json.loads((formal/'public-verification.json').read_text())
manifest_path=Path(current['formalPath'])/'fresh-product-release.json'
manifest=json.loads(manifest_path.read_text())
head='a65f9e31dabeb240c16f4005c4f79a68302d4b04'
assert receipt['sourceHead']==head==verified['sourceHead']==manifest['sourceCommit']
assert receipt['previous']==original['formalPath']
assert receipt['active']==current['formalPath']==verified['release']=='/var/www/bemine-v5/releases/assets-activity-a65f9e31dabe'
assert receipt['runtimeRestarted'] is False and receipt['serviceProcessesUnchanged'] is True and verified['passed'] is True
manifest_checks=[r for r in verified['requests'] if r['url']=='https://bemine.cc.cd/bemine-v5/fresh-product-release.json']
assert len(manifest_checks)==1 and manifest_checks[0]['sha256']==sha(manifest_path)
assert set(p for p in current['formalFiles'] if p.startswith('data/'))==set(p for p in original['formalFiles'] if p.startswith('data/'))
assert all(current['formalFiles'][p]==digest for p,digest in original['formalFiles'].items() if p.startswith('data/') or (p.endswith('.json') and p!='fresh-product-release.json'))
formal_content={p:d for p,d in current['formalFiles'].items() if p!='fresh-product-release.json'}
assert len(formal_content)==manifest['fileCount']==899
assert hashlib.sha256(''.join(f'{p}\0{d}\n' for p,d in sorted(formal_content.items())).encode()).hexdigest()==manifest['contentSha256']=='4c68c49585701b054297fb90e2a97010302c8897671981d9a503150a06f2df87'
assert sha(manifest_path)=='ebcc7239e9a7d775029efb79f75a4380c8d77c8587b9318f03e3f46db3d12e25'
assert sha(formal/'activation-receipt.json')=='7d579a96bce525ae7582214f93abda47950186f0689e3b9c58bee518f7169510'
assert manifest['manifestSha256']=='0xc1e46426f96b858013c4485461f265021bf5e4c483be8a1591ad7563dcea112d'
ui=Path(current['upgradePath']);published=read('publication.json');pins=read('publication-pins.json')
assert ui.name==published['sourceCommit']==pins['sourceCommit']=='6841bf0132f600870b135e728ecb8ff5e882ee98'
assert published['previousSourceCommit']==Path(original['upgradePath']).name
assert published['servicesUnchanged'] and published['productUnchanged'] and published['nginxUnchanged']
assert sha(ui/'static-release-manifest.json')==pins['manifestSha256']==published['manifestSha256']
static=json.loads((ui/'static-release-manifest.json').read_text())
for name,metadata in static['files'].items():
 assert current['upgradeFiles'][name]==metadata['sha256'] and (ui/name).stat().st_size==metadata['bytes']
allowed=set(static['files'])|{'static-release-manifest.json'}
assert all(current['upgradeFiles'][p]==digest for p,digest in original['upgradeFiles'].items() if p not in allowed)
assert set(current['upgradeFiles'])==set(original['upgradeFiles'])|allowed
assert not (BASE/'read-activation-baseline.json').exists()
save('read-activation-baseline.json',current)
save('read-baseline-reconciliation.json',{'originalBaselineSha256':sha(BASE/'read-before.json'),'activationBaselineSha256':sha(BASE/'read-activation-baseline.json'),'allowedChangedKeys':['formalPath','formalFiles','upgradePath','upgradeFiles'],'formalActivationReceiptSha256':sha(formal/'activation-receipt.json'),'formalPublicVerificationSha256':sha(formal/'public-verification.json'),'formalReleaseSha256':sha(manifest_path),'upgradePublicationSha256':sha(BASE/'publication.json'),'upgradeManifestSha256':sha(ui/'static-release-manifest.json'),'servicesNginxEnvironmentAndOldHelperUnchanged':True,'originalBaselinePreserved':True,'chainActionsPerformed':False,'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()})
print(json.dumps({'reconciled':True,'allowedChangedKeys':['formalPath','formalFiles','upgradePath','upgradeFiles'],'formalSourceCommit':head,'upgradeSourceCommit':ui.name,'protectedRuntimeUnchanged':True}))
