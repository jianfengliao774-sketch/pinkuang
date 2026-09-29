"""Execute only extracted pure/configuration and mocked rollback functions; no SSH/systemctl."""
import ast,hashlib,json,pathlib,re,stat,subprocess,sys,tempfile,types,unittest
HERE=pathlib.Path(__file__).resolve().parent
tree=ast.parse((HERE/'product-v2-update.remote.py.template').read_text(encoding='utf8'))
def functions(names,namespace):
 nodes=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
 exec(compile(ast.Module(body=nodes,type_ignores=[]),'reviewed-functions','exec'),namespace)
 return namespace
class Configuration(unittest.TestCase):
 def setUp(self):
  self.ns={'re':re,'CONFIG':{'manifest':{'factory':'0x11','portfolioFactory':'0x22'}},'runtime':pathlib.PurePosixPath('/srv/new-runtime'),
   'product':pathlib.PurePosixPath('/var/www/bemine-v2/releases/v2-product'),
   'upgrade_evidence_path':pathlib.PurePosixPath('/etc/pinkuang-deploy-v2/integrated-upgrade-evidence.json'),
   'dual_graph':False,
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
 def test_dual_graph_uses_separate_immutable_bundles_and_read_only_evidence(self):
  self.ns['dual_graph']=True
  result=self.ns['candidate_unit'](self.original+b'ProtectSystem=strict\n').decode()
  for expected in [
   'BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH=/srv/new-runtime/public/upgrade-genesis/genesis-artifacts.json',
   'BEMINE_INTEGRATED_UPGRADE_ARTIFACT_PATH=/srv/new-runtime/public/deployment-artifacts.json',
   'BEMINE_INTEGRATED_UPGRADE_EVIDENCE_PATH=/etc/pinkuang-deploy-v2/integrated-upgrade-evidence.json',
   'BEMINE_GENESIS_MANIFEST_PATH=/var/www/bemine-v2/releases/v2-product/public/bemine-v2/data/frontend-manifest.json']:
   self.assertIn('Environment='+expected+'\n',result)
  with self.assertRaisesRegex(AssertionError,'read only'):
   self.ns['candidate_unit'](self.original)
 def test_nginx_scope_base_and_cookie(self):
  text=self.ns['nginx_text']().decode()
  self.assertIn('root /var/www/bemine-v2/current/public;',text)
  self.assertIn('try_files $uri $uri.html $uri/ =404;',text)
  self.assertIn('proxy_cookie_path /api/journal /bemine-v2/api/journal;',text)
  for route in ['deployment','fresh-activation']:
   self.assertIn('location = /bemine-v2/api/journal/'+route+' { return 410; }',text)
   self.assertIn('location ^~ /bemine-v2/api/journal/'+route+'/ { return 410; }',text)
  self.assertIn('location ^~ /bemine-v2/api/ {',text)
  self.assertNotIn('location ^~ /bemine/',text);self.assertNotIn('4180',text)
 def test_runtime_hotfix_preserves_the_same_deployment_api_retirement(self):
  source=self.ns['nginx_text']()
  runtime_tree=ast.parse((HERE/'runtime-v2-hotfix.remote.py.template').read_text(encoding='utf8'))
  names={'quote_location','retired_deployment_api','candidate_snippet'}
  nodes=[node for node in runtime_tree.body if isinstance(node,ast.FunctionDef) and node.name in names]
  ns={};exec(compile(ast.Module(body=nodes,type_ignores=[]),'runtime-hotfix-functions','exec'),ns)
  candidate=ns['candidate_snippet'](source)
  self.assertEqual(candidate.replace(ns['quote_location'](),b'',1),source)
 def test_product_update_accepts_only_retired_public_console(self):
  seen=[]
  ns={'public':lambda path:(seen.append(path) or 410,b'')}
  functions(['retired_console_public_acceptance'],ns)
  for path in ['/','/deployment-artifacts.json']:
   ns['retired_console_public_acceptance'](path)
  self.assertEqual(seen,['/pinkuang-deploy-v2/','/pinkuang-deploy-v2/deployment-artifacts.json'])
  ns['public']=lambda path:(200,b'')
  with self.assertRaisesRegex(AssertionError,'became public'):
   ns['retired_console_public_acceptance']('/')
  main=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='main')
  self.assertTrue(any(isinstance(node,ast.Call) and isinstance(node.func,ast.Name)
   and node.func.id=='retired_console_public_acceptance' for node in ast.walk(main)))

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
  self.assertNotIn('CHAIN_INDEX_LOGS_FALLBACK_RPC_URL=',unit)
  config['fallbackLogsRpcUrl']='https://bsc-rpc.blockreq.com/v1/rpc/public'
  self.assertIn('CHAIN_INDEX_LOGS_FALLBACK_RPC_URL=https://bsc-rpc.blockreq.com/v1/rpc/public\n',self.ns['index_text']().decode())
  self.assertIn('CHAIN_INDEX_SCAN_RANGE=100\n',unit)
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
  ns={'sha':lambda data:hashlib.sha256(data).hexdigest(),'no_links':lambda path:None,'regular':lambda path:path.read_bytes(),'stat':stat,
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
 def test_candidate_digest_is_distinct_from_genesis(self):
  root,path,manifest,ns=self.fixture();ns['CONFIG']['artifactDigest']='0x'+'a'*64
  ns['CONFIG']['candidateArtifactDigest']=manifest['artifactDigest']
  self.assertEqual(ns['verify_files'](root,path.name,ns['sha'](path.read_bytes()),manifest['sourceHead']),manifest)
  ns['CONFIG']['candidateArtifactDigest']='0x'+'c'*64
  with self.assertRaises(AssertionError):ns['verify_files'](root,path.name,ns['sha'](path.read_bytes()),manifest['sourceHead'])

class DualGraphEvidence(unittest.TestCase):
 def test_existing_genesis_record_is_preserved_byte_for_byte(self):
  original=b'{\n  "artifactDigest": "genesis", "extra": true\n}\n'
  ns={'dual_graph':True,'json':json,'CONFIG':{'record':json.loads(original)},'record_path':'fixed',
      'regular':lambda path:original}
  functions(['candidate_record'],ns)
  self.assertEqual(ns['candidate_record'](),original)
  ns['CONFIG']['record']['artifactDigest']='candidate'
  with self.assertRaisesRegex(AssertionError,'genesis record'):ns['candidate_record']()
 def test_stage_zero_accepts_only_pinned_genesis_with_candidate_digest(self):
  old={'factory':'0x11','portfolioFactory':'0x22','artifactDigest':'0x'+'a'*64,
       'deployment':{'blockNumber':100,'blockHash':'0x'+'1'*64},'verifiedAt':'original','verifiedBlockNumber':110,'codehash':{'factory':'hash'}}
  ns={'json':json,'re':re,'CONFIG':{'manifest':old,'candidateArtifactDigest':'0x'+'b'*64}}
  functions(['verified_stage_zero'],ns)
  graph={'status':'verified','chainId':56,'stage':'genesis','artifactDigest':old['artifactDigest'],
         'genesisArtifactDigest':old['artifactDigest'],'upgradeArtifactDigest':ns['CONFIG']['candidateArtifactDigest'],
         'manifest':{**old,'verifiedAt':'activation','verifiedBlockNumber':100},'operationalReady':False,
         'stageActivationBlock':100,'stageActivationHash':old['deployment']['blockHash'],
         'verifiedBlockNumber':150,'verifiedBlockHash':'0x'+'2'*64,
         'factory':'0x11','portfolioFactory':'0x22'}
  self.assertTrue(ns['verified_stage_zero'](json.dumps(graph).encode()))
  for change in [{'stage':'code-upgraded'},{'operationalReady':True},{'upgradeArtifactDigest':'0x'+'c'*64},
                 {'manifest':{**graph['manifest'],'factory':'0x33'}},
                 {'stageActivationHash':'0x'+'3'*64}]:
   with self.subTest(change=change),self.assertRaises(AssertionError):ns['verified_stage_zero'](json.dumps({**graph,**change}).encode())
 def test_evidence_must_be_pinned_root_owned_group_read_only_and_pre_execution(self):
  content=json.dumps({'plan':{},'bootstrapPlan':{}}).encode();state={'dir_mode':0o750,'file_mode':0o640,'dir_uid':0,'file_uid':0,'file_gid':44,'body':content}
  class FakePath:
   def __init__(self,is_dir=False):self.is_dir=is_dir
   @property
   def parent(self):return FakePath(True)
   def stat(self):return types.SimpleNamespace(st_uid=state['dir_uid' if self.is_dir else 'file_uid'],
    st_gid=44,st_mode=state['dir_mode' if self.is_dir else 'file_mode'])
   def read_bytes(self):return state['body']
  ns={'dual_graph':True,'pwd':types.SimpleNamespace(getpwnam=lambda name:types.SimpleNamespace(pw_gid=44)),
      'upgrade_evidence_path':FakePath(),'no_links':lambda path:None,'stat':stat,'json':json,
      'CONFIG':{'integratedUpgradeEvidenceSha256':hashlib.sha256(content).hexdigest()},
      'sha':lambda body:hashlib.sha256(body).hexdigest()}
  functions(['upgrade_evidence_ready'],ns);ns['upgrade_evidence_ready']()
  for key,value in [('dir_mode',0o770),('file_mode',0o660),('file_uid',1000)]:
   with self.subTest(key=key),self.assertRaises(AssertionError):
    original=state[key];state[key]=value
    try:ns['upgrade_evidence_ready']()
    finally:state[key]=original
  state['body']=json.dumps({'plan':{},'bootstrapPlan':{},'codeExecuteTxHash':'0x'+'9'*64}).encode()
  ns['CONFIG']['integratedUpgradeEvidenceSha256']=hashlib.sha256(state['body']).hexdigest()
  with self.assertRaisesRegex(AssertionError,'Stage0'):ns['upgrade_evidence_ready']()

class RenderDualGraph(unittest.TestCase):
 def test_renderer_rejects_unpinned_manifest_and_equal_candidate_digest(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=pathlib.Path(tmp);manifest={'artifactDigest':'0x'+'a'*64};record={'artifactDigest':manifest['artifactDigest']}
   manifest_path=root/'manifest.json';manifest_path.write_text(json.dumps(manifest));record_path=root/'record.json';record_path.write_text(json.dumps(record))
   plan={k:'a'*64 for k in ['runtimeManifestSha256','productManifestSha256','nginxSha256','deployUnitSha256',
     'genesisBundleSha256','genesisManifestSha256','integratedUpgradeEvidenceSha256',
     'productSnippetSha256','indexUnitSha256','trustedRecordSha256']}
   plan.update(runtimeReleaseId='v2-runtime-test',productReleaseId='v2-product-test',runtimeSourceHead='b'*40,
     productSourceHead='c'*40,artifactDigest=manifest['artifactDigest'],candidateArtifactDigest='0x'+'b'*64,
     logsRpcUrl='https://bsc.publicnode.com')
   def render():
    input_path=root/'plan.json';input_path.write_text(json.dumps(plan))
    return subprocess.run([sys.executable,str(HERE/'render-product-v2-update.py'),'--plan',str(input_path),
      '--record',str(record_path),'--manifest',str(manifest_path),'--out',str(root/'out')],capture_output=True,text=True)
   self.assertNotEqual(render().returncode,0)
   plan['genesisManifestSha256']=hashlib.sha256(manifest_path.read_bytes()).hexdigest()
   plan['candidateArtifactDigest']=plan['artifactDigest'];self.assertNotEqual(render().returncode,0)
   plan['candidateArtifactDigest']='0x'+'b'*64;result=render()
   self.assertEqual(result.returncode,0,result.stderr)
   reviewed=json.loads((root/'out/reviewed-plan.json').read_text())
   self.assertEqual(reviewed['record'],record);self.assertEqual(reviewed['manifest'],manifest)

if __name__=='__main__':unittest.main()
