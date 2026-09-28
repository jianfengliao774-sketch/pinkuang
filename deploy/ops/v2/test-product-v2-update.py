"""Execute only extracted pure/configuration and mocked rollback functions; no SSH/systemctl."""
import ast,hashlib,json,pathlib,re,tempfile,types,unittest
HERE=pathlib.Path(__file__).resolve().parent
tree=ast.parse((HERE/'product-v2-update.remote.py.template').read_text(encoding='utf8'))
def functions(names,namespace):
 nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
 exec(compile(ast.Module(body=nodes,type_ignores=[]),'reviewed-functions','exec'),namespace)
 return namespace
class Configuration(unittest.TestCase):
 def setUp(self):
  self.ns={'re':re,'CONFIG':{'manifest':{'factory':'0x11','portfolioFactory':'0x22'}},'runtime':pathlib.PurePosixPath('/srv/new-runtime'),
   'record_path':pathlib.PurePosixPath('/var/lib/pinkuang-deploy-v2/trusted-product-deployment.json'),
   'journal':pathlib.PurePosixPath('/var/lib/pinkuang-deploy-v2/journal.sqlite'),'old_factory':'0xOLD'}
  functions(['candidate_unit','nginx_text'],self.ns)
  self.original=b'User=pinkuang-v2\nGroup=pinkuang-v2\nWorkingDirectory=/srv/old-v2\nExecStart=/usr/bin/node /srv/old-v2/server/index.mjs\nEnvironment=PORT=4174\nEnvironment=DEPLOYMENT_JOURNAL_DB=/var/lib/pinkuang-deploy-v2/journal.sqlite\nEnvironment=BEMINE_JOURNAL_FACTORIES=\nEnvironment=BEMINE_DEPLOYMENT_RECORD_PATH=\nUMask=0077\n'
 def test_same_journal_and_both_factories_with_gate(self):
  result=self.ns['candidate_unit'](self.original).decode()
  for expected in ['DEPLOYMENT_JOURNAL_DB=/var/lib/pinkuang-deploy-v2/journal.sqlite','BEMINE_LEGACY_FACTORY=0xOLD','BEMINE_JOURNAL_FACTORIES=0x11,0x22','BEMINE_NOTIFICATIONS_ENABLED=0','WorkingDirectory=/srv/new-runtime']:
   self.assertIn(expected,result)
 def test_different_journal_rejected(self):
  with self.assertRaises(AssertionError):self.ns['candidate_unit'](self.original.replace(b'/journal.sqlite',b'/reset.sqlite'))
 def test_unreviewed_environment_file_rejected(self):
  with self.assertRaises(AssertionError):self.ns['candidate_unit'](self.original+b'EnvironmentFile=/etc/other\n')
 def test_nginx_scope_base_and_cookie(self):
  text=self.ns['nginx_text']().decode()
  self.assertIn('root /var/www/bemine-v2/current/public;',text)
  self.assertIn('try_files $uri $uri.html $uri/ =404;',text)
  self.assertIn('proxy_cookie_path /api/journal /bemine-v2/api/journal;',text)
  self.assertNotIn('location ^~ /bemine/',text);self.assertNotIn('4180',text)

class CatchupConfiguration(unittest.TestCase):
 def setUp(self):
  self.ns={'re':re};functions(['release_options','index_text'],self.ns)
  self.config={'productReleaseId':'v2-product-20260928-7b5176a','logsRpcUrl':'https://bsc-rpc.publicnode.com'}
 def test_defaults_preserve_original_backup_and_bound(self):
  self.assertEqual(self.ns['release_options'](self.config),('https://bsc-dataseed.bnbchain.org',120,'v2-product-20260928-7b5176a-product'))
 def test_independent_primary_and_retry_directory(self):
  config={**self.config,'primaryRpcUrl':'https://bsc.publicnode.com','catchupSeconds':900,'operationId':'v2-product-20260928-7b5176a-retry2'}
  primary,seconds,operation=self.ns['release_options'](config)
  self.assertEqual(seconds,900);self.assertNotEqual(operation,self.ns['release_options'](self.config)[2])
  config['manifest']={'factory':'core','shareMarket':'market','portfolioFactory':'budget','portfolioMarket':'budgetMarket','deployment':{'blockNumber':124453751}}
  self.ns.update(CONFIG=config,primary_rpc=primary,runtime='/srv/test-runtime')
  unit=self.ns['index_text']().decode();self.assertIn('CHAIN_INDEX_RPC_URL=https://bsc.publicnode.com\n',unit)
  self.assertIn('CHAIN_INDEX_LOGS_RPC_URL=https://bsc-rpc.publicnode.com\n',unit)
  self.assertIn('CHAIN_INDEX_START_BLOCK=124453751\n',unit);self.assertIn('CHAIN_INDEX_CONFIRMATIONS=12\n',unit)
 def test_invalid_bounds_and_path_or_environment_injection_rejected(self):
  for seconds in [True,119,1201,120.0,'600',None]:
   with self.subTest(seconds=seconds),self.assertRaises(AssertionError):self.ns['release_options']({**self.config,'catchupSeconds':seconds})
  for key,values in {'primaryRpcUrl':['http://bad.example','https://user:secret@example.com','https://rpc.example/key','https://rpc.example?key=secret','https://rpc.example\nEnvironment=BAD=1'], 'operationId':['../other','/root/x','v2-test\nline','v2-'+'x'*97]}.items():
   for value in values:
    with self.subTest(key=key,value=value),self.assertRaises(AssertionError):self.ns['release_options']({**self.config,key:value})

class CatchupWait(unittest.TestCase):
 def fixture(self,limit=120,ready_at=None,invalid=False):
  clock={'now':0};progress=[];checks=[]
  def http(url,timeout_s):
   return 200,json.dumps({'source':{'complete':ready_at is not None and clock['now']>=ready_at,'indexedThrough':10,'observedSafeHead':20,'unknownReason':'index_not_caught_up'}}).encode()
  def verify(body,deadline):
   checks.append(deadline)
   if invalid:raise AssertionError('wrong canonical block')
   return json.loads(body)['source']['complete']
  ns={'json':json,'time':types.SimpleNamespace(monotonic=lambda:clock['now'],sleep=lambda seconds:clock.update(now=clock['now']+seconds)),
      'catchup_seconds':limit,'http':http,'verified_index':verify,'print':lambda text,**kw:progress.append(json.loads(text))}
  functions(['wait_for_index'],ns);return ns,clock,progress,checks
 def test_full_configured_bound_and_progress_without_success(self):
  ns,clock,progress,checks=self.fixture(limit=1200)
  with self.assertRaisesRegex(RuntimeError,'1200 seconds'):ns['wait_for_index']()
  self.assertEqual(clock['now'],1200);self.assertEqual(len(progress),120)
  self.assertEqual({row['limitSeconds'] for row in progress},{1200});self.assertEqual(set(checks),{1200})
 def test_return_only_after_verified_complete(self):
  ns,clock,progress,checks=self.fixture(limit=900,ready_at=126);ns['wait_for_index']()
  self.assertEqual(clock['now'],126);self.assertEqual(set(checks),{900})
 def test_canonical_assertion_is_not_swallowed(self):
  ns,clock,progress,checks=self.fixture(invalid=True)
  with self.assertRaisesRegex(AssertionError,'canonical'):ns['wait_for_index']()
  self.assertEqual(clock['now'],0)

class Rollback(unittest.TestCase):
 def fixture(self,index_exists=False):
  temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=pathlib.Path(temporary.name)
  backup=root/'backup';backup.mkdir();targets={key:root/name for key,name in [('unit','deploy.service'),('index-unit','index.service'),('nginx','site.conf'),('snippet','product.conf'),('record','public-record.json')]}
  hashes={};before={};modes={}
  for name,path in targets.items():
   data=('candidate '+name).encode();hashes[name]=hashlib.sha256(data).hexdigest()
   if name in ['unit','nginx']:
    old=('before '+name).encode();(backup/(name+'.before')).write_bytes(old);before[name]=hashlib.sha256(old).hexdigest();modes[name]=0o644
    path.write_bytes(data)
   elif index_exists:path.write_bytes(data)
  journal=root/'journal.sqlite';journal.write_bytes(b'PRIVATE JOURNAL MUST REMAIN UNCHANGED')
  calls=[]
  ns={'sha':lambda data:hashlib.sha256(data).hexdigest(),'no_links':lambda path:None,'regular':lambda path:path.read_bytes(),
      'unit':targets['unit'],'index_unit':targets['index-unit'],'site':targets['nginx'],'snippet':targets['snippet'],'record_path':targets['record'],
      'backup':backup,'product':root/'new-product','public_current':root/'current','journal':journal,
      'link_target':lambda:None,'set_link':lambda value:self.fail('Must not create a new product link while rolling back'),
      'run':lambda args,**kw:calls.append(args),'service':lambda name:{'LoadState':'loaded' if targets['index-unit'].exists() else 'not-found'},
      'replace':lambda path,data,mode:path.write_bytes(data),'legacy':lambda:{}}
  state={'candidateHashes':hashes,'beforeHashes':before,'beforeModes':modes,'priorProductLink':None,'indexWasActive':False,'indexWasEnabled':False,'legacy':{}}
  functions(['restore'],ns);return ns,state,calls,targets,journal
 def test_concurrent_last_file_detected_before_any_stop(self):
  ns,state,calls,targets,journal=self.fixture(True);targets['record'].write_bytes(b'another administrator edit')
  with self.assertRaises(AssertionError):ns['restore'](state)
  self.assertEqual(calls,[]);self.assertEqual(targets['unit'].read_bytes(),b'candidate unit')
 def test_partial_failure_before_index_install_does_not_stop_unknown_service(self):
  ns,state,calls,targets,journal=self.fixture();ns['restore'](state)
  self.assertNotIn(['systemctl','stop','pinkuang-index-v2.service'],calls)
  self.assertEqual(targets['unit'].read_bytes(),b'before unit');self.assertEqual(journal.read_bytes(),b'PRIVATE JOURNAL MUST REMAIN UNCHANGED')
  self.assertIn(['systemctl','reload','nginx'],calls)
 def test_index_start_or_reload_failure_preserves_database_and_restores_old_route(self):
  ns,state,calls,targets,journal=self.fixture(True);ns['restore'](state)
  self.assertIn(['systemctl','stop','pinkuang-index-v2.service'],calls);self.assertIn(['systemctl','disable','pinkuang-index-v2.service'],calls)
  self.assertEqual(targets['nginx'].read_bytes(),b'before nginx');self.assertFalse(targets['index-unit'].exists())
  self.assertEqual(journal.read_bytes(),b'PRIVATE JOURNAL MUST REMAIN UNCHANGED');self.assertIn(['systemctl','restart','pinkuang-deploy-v2.service'],calls)
 def test_already_restored_original_still_reloads(self):
  ns,state,calls,targets,journal=self.fixture();targets['nginx'].write_bytes(b'before nginx');ns['restore'](state)
  self.assertIn(['nginx','-t'],calls);self.assertIn(['systemctl','reload','nginx'],calls)

class ReleaseFiles(unittest.TestCase):
 def fixture(self):
  temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup);root=pathlib.Path(temporary.name)
  data=b'reviewed';(root/'bundle.js').write_bytes(data)
  manifest={'sourceHead':'a'*40,'artifactDigest':'0x'+'b'*64,'files':{'bundle.js':{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}}}
  path=root/'product-release-manifest.json';path.write_text(json.dumps(manifest))
  ns={'json':json,'pathlib':pathlib,'runtime':root/'not-runtime','CONFIG':{'artifactDigest':manifest['artifactDigest']},
      'regular':lambda p:p.read_bytes(),'sha':lambda value:hashlib.sha256(value).hexdigest()}
  functions(['verify_files'],ns)
  return root,path,manifest,ns
 def test_every_listed_file_hash_is_verified(self):
  root,path,manifest,ns=self.fixture();result=ns['verify_files'](root,path.name,ns['sha'](path.read_bytes()),manifest['sourceHead']);self.assertEqual(result,manifest)
  (root/'bundle.js').write_bytes(b'changed')
  with self.assertRaises(AssertionError):ns['verify_files'](root,path.name,ns['sha'](path.read_bytes()),manifest['sourceHead'])
 def test_unlisted_file_is_rejected(self):
  root,path,manifest,ns=self.fixture();(root/'unreviewed.js').write_bytes(b'other')
  with self.assertRaises(AssertionError):ns['verify_files'](root,path.name,ns['sha'](path.read_bytes()),manifest['sourceHead'])
 def test_path_traversal_manifest_is_rejected(self):
  root,path,manifest,ns=self.fixture();manifest['files']['../outside.js']={'bytes':1,'sha256':'0'*64};path.write_text(json.dumps(manifest))
  with self.assertRaises(AssertionError):ns['verify_files'](root,path.name,ns['sha'](path.read_bytes()),manifest['sourceHead'])

if __name__=='__main__':unittest.main()
