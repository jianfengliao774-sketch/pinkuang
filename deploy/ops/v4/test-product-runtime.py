import copy,hashlib,importlib.util,json,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
def module(name,file):
 s=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
g=module('generator','prepare-product-runtime.py');a=module('activate','activate-product-runtime.remote.py')
def sha(b):return hashlib.sha256(b).hexdigest()
def pair():
 return {'kind':'fresh-v4-bound-cutover-draft','activationAllowed':False,'runtimeRoot':'/srv/pinkuang-deploy-v4/releases/v4-test-final',
  'productRoot':'/var/www/bemine-v4/releases/v4-test-final','releasePair':{'sourceHead':'a'*40,'factory':'0x'+'1'*40,
   'portfolioFactory':'0x'+'2'*40,'authority':'0x'+'3'*40,'gasWallet':'0x'+'4'*40,'indexManifestSha256':'b'*64}}
def inputs():return {k:{'sourcePath':'/root/'+k+'.json','sha256':'c'*64} for k in ['record','activation']}
def limits():return {'authorityTotalBnb':'0.01','purchasePerJournalBnb':'0.01','miningPerJournalBnb':'0.02','maxGasPriceGwei':'1'}
class Generator(unittest.TestCase):
 def test_scoped_limits_and_no_key_public(self):
  p=g.prepare(pair(),inputs(),limits())
  self.assertFalse(p['gasScope']['sharedCumulativeCap']);self.assertNotIn('keeper-private-key',p['units'][g.PRODUCT]);self.assertNotIn('keeper-private-key',p['units'][g.INDEX])
  self.assertIn('AUTHORITY_RELAY_MAX_GAS_BNB=0.01',p['units'][g.SIGNER]);self.assertIn('--max-gas-bnb 0.01',p['units'][g.PURCHASE]);self.assertIn('--max-gas-bnb 0.02',p['units'][g.MINING])
 def test_missing_budget_rejected(self):
  v=limits();del v['authorityTotalBnb']
  with self.assertRaises(RuntimeError):g.prepare(pair(),inputs(),v)
 def test_unit_injection_rejected(self):
  p=pair();p['runtimeRoot']+='\nExecStart=/bin/false'
  with self.assertRaises(RuntimeError):g.prepare(p,inputs(),limits())
 def test_origin_and_role_boundaries(self):
  p=g.prepare(pair(),inputs(),limits());s=p['units'][g.SIGNER];pub=p['units'][g.PRODUCT]
  self.assertIn('AUTHORITY_ATTESTATION_ORIGIN=https://tapeout.cc.cd',s);self.assertIn('DEPLOYMENT_JOURNAL_ORIGIN=https://bemine.cc.cd',s)
  self.assertIn('AUTHORITY_RELAY_ENABLED=0',pub);self.assertIn('BEMINE_FRESH_STAGE2_HOLD=1',pub)
  self.assertIn('BEMINE_INDEX_URL=http://127.0.0.1:4184',pub)
  for key in [g.PURCHASE,g.MINING]:self.assertIn('--fresh-graph --send',p['units'][key]);self.assertIn('PINKUANG_KEEPER_STATE_ROOT=/var/lib/pinkuang-v4-signer/keeper',p['units'][key])
 def test_new_domain_does_not_expose_console(self):
  text=g.vhost();self.assertIn('location ^~ /bemine-v4/api/journal/fresh-activation { return 404; }',text)
  self.assertIn('proxy_set_header Cookie "";',text);self.assertIn('root /var/www/bemine-v4/current;',text)
  self.assertIn('location = /bemine-v4/data/bem-price.json',text);self.assertNotIn('location /bemine-v4/data/',text)
  firsto=text.split('location ^~ /bemine-v4/firsto-api/ {',1)[1].split('}',1)[0]
  self.assertIn('proxy_set_header X-Real-IP $remote_addr;',firsto)
  for key in ['X-Forwarded-For','X-Forwarded-Host','X-Forwarded-Proto']:self.assertIn('proxy_set_header '+key+' "";',firsto)
 def test_uncertain_workers_stay_stopped(self):
  p=g.prepare(pair(),inputs(),limits())
  for u in [g.PURCHASE,g.MINING]:self.assertIn('RestartPreventExitStatus=2',p['units'][u])
  self.assertNotIn('RestartPreventExitStatus',p['units'][g.SIGNER])
class Files(unittest.TestCase):
 def test_cas_rejects_intervening_change(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'unit';p.write_bytes(b'changed')
   with self.assertRaises(RuntimeError):a.replace(p,sha(b'old'),b'new')
   self.assertEqual(p.read_bytes(),b'changed')
 def test_new_file_never_overwrites(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'state';p.write_bytes(b'journal')
   with self.assertRaises(RuntimeError):a.replace(p,None,b'new')
   self.assertEqual(p.read_bytes(),b'journal')
 def test_symlink_target_rejected(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'target';p.write_bytes(b'original');link=Path(d)/'link';link.symlink_to(p)
   with self.assertRaises(RuntimeError):a.replace(link,sha(b'original'),b'new')
   self.assertEqual(p.read_bytes(),b'original')
 def test_rollback_cannot_clobber_another_change(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'config';p.write_bytes(b'other editor')
   with self.assertRaises(RuntimeError):a.remove_own(p,sha(b'ours'))
   self.assertTrue(p.exists())
class Phases(unittest.TestCase):
 def test_stale_quote_blocks_publication(self):
  b={'status':'ok','chainId':56,'quoteCurrency':'USDT','tokenAddress':'0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a','poolAddress':'0x28b12792f9d81bd529bc5572434e861c9edbbbc2','priceUsdt':1,'updatedAt':'2000-01-01T00:00:00Z','blockTimestamp':'2000-01-01T00:00:00Z'}
  with self.assertRaisesRegex(RuntimeError,'stale'):a.check_price(json.dumps(b).encode())
 def test_machine_probe_needs_only_hmac_not_gas_or_incomplete_journal_config(self):
  p=pair();args=a.machine_probe_args(p)
  text=' '.join(args)
  self.assertIn('readAuthorityIpcKey',text);self.assertNotIn('authorityIpcConfiguration',text)
  self.assertNotIn('keeper-private-key',text);self.assertNotIn('/keeper.key',text)
  self.assertIn("socketPath:'/run/pinkuang-v4-relay/authority.sock'",text)
  self.assertIn('LoadCredential=authority-ipc-hmac:',text)
 def test_individual_machine_success_does_not_substitute_product_ready(self):
  body={'chainId':56,'status':'verified','stage':'fresh-active','operationalReady':False,'userExitReady':True,'stale':False,'readMode':'current'}
  with patch.object(a,'http',return_value=(200,json.dumps(body).encode())):
   with self.assertRaisesRegex(RuntimeError,'not operational'):a.integrated_product_ready(pair())
 def test_failed_worker_proof_restores_attestor_not_legacy_sender(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);old=b'attest only';(root/a.SIGNER).write_bytes(old);ev=root/'evidence';ev.mkdir()
   units={u:'new '+u for u in [a.SIGNER,*a.WORKERS]}
   p={'units':units,'unitSha256':{u:sha(t.encode()) for u,t in units.items()},'expectedSignerUnitSha256':sha(old)};calls=[]
   def info(u):return {'LoadState':'not-found','DropInPaths':''}
   with patch.object(a,'UNIT_ROOT',root),patch.object(a,'verify_installed'),patch.object(a,'index_ready'),patch.object(a,'verify_drain',return_value={}),patch.object(a,'ids',return_value={}),patch.object(a,'info',side_effect=info),patch.object(a,'run',side_effect=lambda args,**kw:calls.append(args) or ''),patch.object(a,'machine_ready',side_effect=RuntimeError('unready')),patch.object(a.time,'monotonic',side_effect=[0,61]):
    with self.assertRaisesRegex(RuntimeError,'Workers/signing'):a.enable_automation(p,ev)
   self.assertEqual((root/a.SIGNER).read_bytes(),old)
   for u in a.WORKERS:self.assertFalse((root/u).exists())
   self.assertFalse(any('pinkuang-purchase-v2.service' in c for c in calls))
 def test_failed_nginx_validation_restores_only_own_publication(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);units=root/'units';units.mkdir();product=root/'product';(product/'data').mkdir(parents=True);(product/'index.html').write_bytes(b'HTML');(product/'data/frontend-manifest.v4.json').write_bytes(b'JSON')
   texts={u:'new '+u for u in [a.SIGNER,*a.WORKERS]}
   for u,t in texts.items():(units/u).write_text(t)
   vhost=root/'nginx';vhost.write_bytes(b'maintenance');link=root/'current';ev=root/'evidence';ev.mkdir()
   p={'productRoot':str(product),'units':texts,'unitSha256':{u:sha(t.encode()) for u,t in texts.items()},'expectedDomainVhostSha256':sha(b'maintenance'),
    'publication':{'nginxVhost':str(vhost),'currentLink':str(link),'content':'new vhost','sha256':sha(b'new vhost')}}
   attempts=0
   def run(args,**kw):
    nonlocal attempts
    if args==['nginx','-t']:
     attempts+=1
     if attempts==1:raise RuntimeError('nginx test failed')
    return ''
   with patch.object(a,'UNIT_ROOT',units),patch.object(a,'verify_installed'),patch.object(a,'index_ready'),patch.object(a,'machine_ready'),patch.object(a,'integrated_product_ready'),patch.object(a,'ids',return_value={}),patch.object(a,'info',return_value={'ActiveState':'active'}),patch.object(a,'run',side_effect=run):
    with self.assertRaisesRegex(RuntimeError,'nginx test failed'):a.publish(p,ev)
   self.assertEqual(vhost.read_bytes(),b'maintenance');self.assertFalse(link.is_symlink())
 def test_complete_but_stale_index_fails(self):
  source={'chainId':56,'complete':True,'factory':'0x1','portfolioFactory':'0x2','indexedThrough':5,'observedSafeHead':5,'indexedBlockHash':'0x'+'a'*64,'indexedTimestamp':1}
  with patch.object(a,'http',return_value=(200,json.dumps({'source':source}).encode())):
   with self.assertRaisesRegex(RuntimeError,'not complete and recent'):a.index_ready({'releasePair':{'factory':'0x1','portfolioFactory':'0x2'}},seconds=0)
 def test_recent_but_incomplete_index_fails(self):
  source={'chainId':56,'complete':False,'factory':'0x1','portfolioFactory':'0x2','indexedThrough':5,'observedSafeHead':5,'indexedBlockHash':'0x'+'a'*64,'indexedTimestamp':int(a.time.time())}
  with patch.object(a,'http',return_value=(200,json.dumps({'source':source}).encode())):
   with self.assertRaisesRegex(RuntimeError,'not complete and recent'):a.index_ready({'releasePair':{'factory':'0x1','portfolioFactory':'0x2'}},seconds=0)
 def test_recent_timestamp_does_not_bypass_120_block_gap(self):
  source={'chainId':56,'complete':True,'factory':'0x1','portfolioFactory':'0x2','indexedThrough':5,'observedSafeHead':5,'indexedBlockHash':'0x'+'a'*64,'indexedTimestamp':int(a.time.time())}
  with patch.object(a,'http',return_value=(200,json.dumps({'source':source}).encode())),patch.object(a,'latest_block',return_value=126):
   with self.assertRaisesRegex(RuntimeError,'not complete and recent'):a.index_ready({'releasePair':{'factory':'0x1','portfolioFactory':'0x2'}},seconds=0)
 def test_partial_enable_undoes_only_new_boot_links_without_restart(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);units=root/'units';units.mkdir();target=root/'product';target.mkdir();link=root/'current';link.symlink_to(target)
   vhost=root/'nginx';vhost.write_bytes(b'published');names=[a.PRODUCT,a.INDEX,a.SIGNER,*a.WORKERS]
   texts={u:'current '+u for u in names}
   for u,t in texts.items():(units/u).write_text(t)
   p={'productRoot':str(target),'units':texts,'unitSha256':{u:sha(t.encode()) for u,t in texts.items()},
    'publication':{'currentLink':str(link),'nginxVhost':str(vhost),'sha256':sha(b'published')}};calls=[]
   def info(u):
    if u=='pinkuang-purchase-v2.service':return {'ActiveState':'inactive','MainPID':'0','UnitFileState':'disabled'}
    return {'ActiveState':'active','DropInPaths':'','UnitFileState':'enabled' if u==a.PRODUCT else 'disabled'}
   def run(args,**kw):
    calls.append(args)
    if args==['systemctl','enable',a.WORKERS[1]]:raise RuntimeError('simulated enable failure')
    return ''
   with patch.object(a,'UNIT_ROOT',units),patch.object(a,'index_ready'),patch.object(a,'machine_ready'),patch.object(a,'integrated_product_ready'),patch.object(a,'info',side_effect=info),patch.object(a,'run',side_effect=run):
    with self.assertRaisesRegex(RuntimeError,'simulated enable'):a.finalize_enable(p,root)
   self.assertNotIn(['systemctl','disable',a.PRODUCT],calls)
   self.assertIn(['systemctl','disable',a.INDEX],calls)
   self.assertFalse(any('restart' in c or 'stop' in c for c in calls))
if __name__=='__main__':unittest.main()
