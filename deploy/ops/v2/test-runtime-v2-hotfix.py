"""Real template functions with local fixture files; never run service commands."""
import ast,datetime,hashlib,json,math,pathlib,re,tempfile,time,types,unittest
HERE=pathlib.Path(__file__).resolve().parent;tree=ast.parse((HERE/'runtime-v2-hotfix.remote.py.template').read_text(encoding='utf8'))
def functions(names,ns):
    nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'hotfix-functions','exec'),ns);return ns
class HotfixConfiguration(unittest.TestCase):
    def setUp(self):
        self.ns={'re':re,'legacy_names':['old','price']};functions(['hotfix_options','candidate_snippet','quote_location','retired_deployment_api'],self.ns)
        self.plan={'runtimeReleaseId':'v2-hotfix-new','previousRuntimeReleaseId':'v2-old-runtime','productReleaseId':'v2-product-existing','operationId':'v2-hotfix-attempt-1',
            'runtimeSourceHead':'a'*40,'productSourceHead':'b'*40,'legacy':{'services':{'old':{},'price':{}}}}
        for k in ['runtimeManifestSha256','productManifestSha256','nginxSha256','deployUnitSha256','indexUnitSha256','productSnippetSha256','trustedRecordSha256']:self.plan[k]='c'*64
    def test_defaults_and_allowed_explicit_limits(self):
        self.assertEqual(self.ns['hotfix_options'](self.plan),(12000,120,'v2-hotfix-attempt-1'))
        self.assertEqual(self.ns['hotfix_options']({**self.plan,'logsTimeoutMs':30000,'catchupSeconds':1200}),(30000,1200,'v2-hotfix-attempt-1'))
        self.assertEqual(self.ns['hotfix_options']({**self.plan,'logsRpcUrl':'https://bsc-rpc.blockreq.com/v1/rpc/public','fallbackLogsRpcUrl':'https://bsc.publicnode.com'}),(12000,120,'v2-hotfix-attempt-1'))
    def test_invalid_input_or_same_release_rejected(self):
        for k,v in [('logsTimeoutMs',30001),('logsTimeoutMs',11999),('logsTimeoutMs',True),('catchupSeconds',1201),('catchupSeconds','120'),('runtimeSourceHead','TBD'),('runtimeReleaseId','v2-old-runtime'),('operationId','../backup')]:
            with self.subTest(k=k,v=v),self.assertRaises(AssertionError):self.ns['hotfix_options']({**self.plan,k:v})
        with self.assertRaises(AssertionError):self.ns['hotfix_options']({**self.plan,'legacy':{'services':{'old':{}}}})
        with self.assertRaises(AssertionError):self.ns['hotfix_options']({**self.plan,'logsRpcUrl':'https://bsc.publicnode.com','fallbackLogsRpcUrl':'https://bsc.publicnode.com'})
    def test_adds_only_exact_price_and_deployment_retirement_routes(self):
        original=b'location ^~ /bemine-v2/api/ { proxy_pass http://127.0.0.1:4174/api/; }\nlocation ^~ /bemine-v2/ { root /var/www/bemine-v2/current/public; }\n'
        candidate=self.ns['candidate_snippet'](original);addition=self.ns['quote_location']();retired=self.ns['retired_deployment_api']()
        self.assertEqual(candidate.replace(addition,b'',1).replace(retired,b'',1),original)
        self.assertEqual(self.ns['candidate_snippet'](candidate),candidate)
        self.assertIn(b'location = /bemine-v2/data/bem-price.json',candidate);self.assertNotIn(b'location /bemine-v2/data/',candidate)
        self.assertIn(b'location = /bemine-v2/api/journal/deployment { return 410; }',candidate)
        self.assertIn(b'location ^~ /bemine-v2/api/journal/deployment/ { return 410; }',candidate)
        self.assertIn(b'location = /bemine-v2/api/journal/fresh-activation { return 410; }',candidate)
        self.assertIn(b'location ^~ /bemine-v2/api/ { proxy_pass http://127.0.0.1:4174/api/; }',candidate)
    def test_existing_reviewed_no_store_route_is_preserved_byte_for_byte(self):
        current=self.ns['retired_deployment_api']()+self.ns['quote_location']()+b'location ^~ /bemine-v2/api/ { proxy_pass http://127.0.0.1:4174/api/; }\nlocation ^~ /bemine-v2/ { root /var/www/bemine-v2/current/public; }\n'
        self.assertEqual(self.ns['candidate_snippet'](current),current)
    def test_old_or_unknown_existing_price_route_requires_new_review(self):
        legacy=self.ns['quote_location']().replace(b'    add_header Cache-Control "no-store" always;\n    add_header X-Content-Type-Options nosniff always;\n',b'    expires -1;\n')
        with self.assertRaises(AssertionError):self.ns['candidate_snippet'](legacy)
    def test_unexpected_existing_quote_route_rejected(self):
        with self.assertRaises(AssertionError):self.ns['candidate_snippet'](b'location = /bemine-v2/data/bem-price.json { alias /other; }')
    def test_partial_or_unknown_deployment_api_mapping_rejected(self):
        original=b'location ^~ /bemine-v2/api/ { proxy_pass http://127.0.0.1:4174/api/; }\nlocation ^~ /bemine-v2/ { root /var/www/bemine-v2/current/public; }\n'
        with self.assertRaisesRegex(AssertionError,'deployment API mapping'):
            self.ns['candidate_snippet'](original+b'location = /bemine-v2/api/journal/deployment { return 200; }\n')

class UnitPaths(unittest.TestCase):
    def setUp(self):
        self.ns={'re':re,'previous_runtime':pathlib.PurePosixPath('/srv/old'),'runtime':pathlib.PurePosixPath('/srv/new'),'journal':pathlib.PurePosixPath('/private/journal.sqlite'),
            'index_db':pathlib.PurePosixPath('/private-index/index.sqlite'),'record_path':pathlib.PurePosixPath('/private/record.json'),'old_factory':'OLD','logs_timeout_ms':30000,
            'CONFIG':{'manifest':{'factory':'CORE','shareMarket':'MARKET','portfolioFactory':'BUDGET','portfolioMarket':'BMARKET','deployment':{'blockNumber':123}}}}
        functions(['candidate_service'],self.ns)
    def fixture(self,index):
        script='server/chain-index/server.mjs' if index else 'server/index.mjs'
        text='User=pinkuang-v2\nGroup=pinkuang-v2\nWorkingDirectory=/srv/old\nExecStart=/usr/bin/node /srv/old/'+script+'\nUMask=0077\nTimeoutStopSec=45\n'
        env={'CHAIN_INDEX_DB':'/private-index/index.sqlite','CHAIN_INDEX_HOST':'127.0.0.1','CHAIN_INDEX_PORT':'4181','CHAIN_INDEX_FACTORY':'CORE','CHAIN_INDEX_MARKET':'MARKET','CHAIN_INDEX_PORTFOLIO_FACTORY':'BUDGET','CHAIN_INDEX_PORTFOLIO_MARKET':'BMARKET','CHAIN_INDEX_START_BLOCK':'123','CHAIN_INDEX_CONFIRMATIONS':'12'} if index else {
            'DEPLOYMENT_JOURNAL_DB':'/private/journal.sqlite','PORT':'4174','BEMINE_INDEX_URL':'http://127.0.0.1:4181','BEMINE_JOURNAL_FACTORIES':'CORE,BUDGET','BEMINE_DEPLOYMENT_RECORD_PATH':'/private/record.json','BEMINE_LEGACY_FACTORY':'OLD','BEMINE_NOTIFICATIONS_ENABLED':'0'}
        return (text+''.join('Environment='+k+'='+v+'\n' for k,v in env.items())).encode()
    def test_runtime_only_changes_paths(self):
        old=self.fixture(False);new=self.ns['candidate_service'](old,False)
        self.assertEqual(new,old.replace(b'/srv/old',b'/srv/new'));self.assertIn(b'BEMINE_LEGACY_FACTORY=OLD',new)
    def test_index_changes_paths_and_adds_timeout_only(self):
        old=self.fixture(True);new=self.ns['candidate_service'](old,True)
        self.assertEqual(new.replace(b'Environment=CHAIN_INDEX_LOGS_TIMEOUT_MS=30000\n',b''),old.replace(b'/srv/old',b'/srv/new'))
        self.assertIn(b'CHAIN_INDEX_DB=/private-index/index.sqlite',new)
    def test_index_can_replace_logs_rpc_and_add_fallback(self):
        self.ns['CONFIG']['logsRpcUrl']='https://bsc-rpc.blockreq.com/v1/rpc/public'
        self.ns['CONFIG']['fallbackLogsRpcUrl']='https://bsc.publicnode.com'
        old=self.fixture(True)+b'Environment=CHAIN_INDEX_LOGS_RPC_URL=https://bsc.publicnode.com\n'
        new=self.ns['candidate_service'](old,True)
        self.assertIn(b'Environment=CHAIN_INDEX_LOGS_RPC_URL=https://bsc-rpc.blockreq.com/v1/rpc/public\n',new)
        self.assertIn(b'Environment=CHAIN_INDEX_LOGS_FALLBACK_RPC_URL=https://bsc.publicnode.com\n',new)
        self.assertEqual(new.count(b'Environment=CHAIN_INDEX_LOGS_RPC_URL='),1)
    def test_wrong_database_or_unknown_old_path_rejected(self):
        for old,index in [(self.fixture(True).replace(b'/private-index/index.sqlite',b'/new.sqlite'),True),(self.fixture(False).replace(b'/srv/old',b'/srv/unknown'),False),(self.fixture(False)+b'EnvironmentFile=/etc/secret\n',False)]:
            with self.assertRaises(AssertionError):self.ns['candidate_service'](old,index)

class Quote(unittest.TestCase):
    def setUp(self):
        self.ns={'json':json,'datetime':datetime,'time':time,'math':math};functions(['quote_valid'],self.ns)
        self.quote={'status':'ok','chainId':56,'quoteCurrency':'USDT','tokenAddress':'0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a','poolAddress':'0x28b12792f9d81bd529bc5572434e861c9edbbbc2','conversionPoolAddress':'0x172fcd41e0913e95784454622d1c3724f546f849','priceUsdt':50.02,'blockNumber':123,
            'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'blockTimestamp':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    def test_live_valid_quote(self):self.assertEqual(self.ns['quote_valid'](json.dumps(self.quote))['priceUsdt'],50.02)
    def test_stale_wrong_token_and_nan_rejected(self):
        for k,v in [('updatedAt','2020-01-01T00:00:00Z'),('blockTimestamp','2020-01-01T00:00:00Z'),('tokenAddress','OTHER'),('priceUsdt',float('nan')),('priceUsdt',True),('chainId',1)]:
            with self.subTest(k=k),self.assertRaises(AssertionError):self.ns['quote_valid'](json.dumps({**self.quote,k:v}))

class GenesisGraphAcceptance(unittest.TestCase):
    def setUp(self):
        self.ns={'json':json,'re':re};functions(['verified_genesis_graph'],self.ns)
        self.manifest=json.loads((HERE.parent.parent.parent/'web/public/data/frontend-manifest.json').read_text())
        m=self.manifest;d=m['deployment']
        self.graph={'status':'verified','chainId':56,'stage':'genesis','readMode':'current','stale':False,
            'operationalReady':False,'upgradeArtifactDigest':None,'operationId':None,
            'artifactDigest':m['artifactDigest'],'genesisArtifactDigest':m['artifactDigest'],
            'factory':m['factory'],'portfolioFactory':m['portfolioFactory'],
            'stageActivationBlock':d['blockNumber'],'stageActivationHash':d['blockHash'],
            'verifiedBlockNumber':m['verifiedBlockNumber']+1,'verifiedBlockHash':'0x'+'ab'*32,
            'manifest':{**m,'verifiedBlockNumber':d['blockNumber']}}
    def test_original_genesis_is_accepted(self):
        self.assertEqual(self.ns['verified_genesis_graph'](json.dumps(self.graph).encode(),self.manifest)['stage'],'genesis')
    def test_wrong_factory_or_upgrade_or_stale_read_fails(self):
        for patch in [{'factory':'0x0000000000000000000000000000000000000001'},
            {'stage':'fresh-active'},{'readMode':'verified_snapshot'},{'upgradeArtifactDigest':'0x'+'ab'*32},
            {'manifest':{**self.graph['manifest'],'portfolioFactory':'0x0000000000000000000000000000000000000001'}}]:
            with self.subTest(patch=patch),self.assertRaises(AssertionError):
                self.ns['verified_genesis_graph'](json.dumps({**self.graph,**patch}).encode(),self.manifest)

class RetiredConsoleAcceptance(unittest.TestCase):
    def test_public_console_remains_410_while_local_runtime_bytes_match(self):
        runtime={'files':{'dist/index.html':{'sha256':hashlib.sha256(b'local console').hexdigest()},
                          'dist/deployment-artifacts.json':{'sha256':hashlib.sha256(b'local artifacts').hexdigest()}}}
        product={'files':{'public/bemine-v2/index.html':{'sha256':hashlib.sha256(b'product').hexdigest()},
                          'public/bemine-v2/data/frontend-manifest.json':{'sha256':hashlib.sha256(b'manifest').hexdigest()}}}
        console_status={"value":410};local_console={"value":b'local console'};public_calls=[]
        def http(url,payload=None):
            if url.endswith('/deployment-artifacts.json'):return 200,b'local artifacts'
            if url.endswith('/api/journal/product-graph'):return 200,b'{}'
            if url.endswith('/api/rpc'):return 200,b'{"result":"0x38"}'
            return 200,local_console['value']
        def public(path):
            public_calls.append(path)
            if path.startswith('/pinkuang-deploy-v2'):return console_status['value'],b''
            return {'/bemine-v2/':(200,b'product'),
                    '/bemine-v2/data/frontend-manifest.json':(200,b'manifest'),
                    '/bemine-v2/api/journal/product-graph':(200,b'{}'),
                    '/bemine-v2/api/journal/build':(401,b''),
                    '/bemine-v2/data/bem-price.json':(200,b'{}')}[path]
        ns={'http':http,'public':public,'sha':lambda body:hashlib.sha256(body).hexdigest(),
            'json':json,'CONFIG':{'manifest':{}},'verified_genesis_graph':lambda body,manifest:{},
            'quote_valid':lambda body:{},'observe_index_cycles':lambda:None,'print':lambda *args,**kw:None}
        functions(['public_acceptance'],ns)
        ns['public_acceptance'](runtime,product)
        self.assertIn('/pinkuang-deploy-v2/',public_calls)
        self.assertIn('/pinkuang-deploy-v2/deployment-artifacts.json',public_calls)
        console_status['value']=200
        with self.assertRaises(AssertionError):ns['public_acceptance'](runtime,product)
        console_status['value']=410;local_console['value']=b'unreviewed runtime'
        with self.assertRaises(AssertionError):ns['public_acceptance'](runtime,product)

class IndexCycleObservation(unittest.TestCase):
    def fixture(self,rows):
        clock={'now':0,'i':0};prints=[]
        def public(path):
            row=rows[min(clock['i'],len(rows)-1)];clock['i']+=1
            return row.get('status',200),json.dumps({'source':row}).encode()
        def verified(body,deadline):
            row=json.loads(body)['source']
            if row.get('badCanonical'):raise AssertionError('Wrong canonical hash')
            return row.get('complete',False)
        ns={'json':json,'time':types.SimpleNamespace(monotonic=lambda:clock['now'],sleep=lambda n:clock.update(now=clock['now']+n)),
            'public':public,'verified_index':verified,'print':lambda text,**kw:prints.append(json.loads(text))}
        functions(['observe_index_cycles'],ns);return ns,clock,prints
    def test_sync_in_between_does_not_discard_verified_cycles(self):
        ns,clock,prints=self.fixture([{'complete':True,'indexedThrough':100},{'complete':False},{'complete':True,'indexedThrough':100},{'status':503},{'complete':True,'indexedThrough':110}]);ns['observe_index_cycles']()
        result=prints[-1]['indexCycleObservation'];self.assertEqual(result,{'samples':5,'verifiedSamples':3,'distinctIndexedBlocks':2,'incompleteOrUnavailable':2,'http503':1})
    def test_repeating_same_complete_block_is_insufficient(self):
        ns,clock,prints=self.fixture([{'complete':True,'indexedThrough':100}])
        with self.assertRaisesRegex(RuntimeError,'two completed cycles'):ns['observe_index_cycles']()
        self.assertEqual(clock['now'],90)
    def test_persistent_incomplete_times_out(self):
        ns,clock,prints=self.fixture([{'complete':False}])
        with self.assertRaises(RuntimeError):ns['observe_index_cycles']()
        self.assertEqual(clock['now'],90)
    def test_bad_canonical_aborts_immediately(self):
        ns,clock,prints=self.fixture([{'complete':True,'indexedThrough':100,'badCanonical':True}])
        with self.assertRaisesRegex(AssertionError,'canonical'):ns['observe_index_cycles']()
        self.assertEqual(clock['now'],0)

class Rollback(unittest.TestCase):
    def fixture(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);root=pathlib.Path(t.name);backup=root/'backup';backup.mkdir()
        targets={key:root/name for key,name in [('unit','runtime.service'),('index-unit','index.service'),('snippet','product.conf')]}
        state={'databaseIds':{'journal':[1,2],'index':[1,3]},'beforeHashes':{},'candidateHashes':{},'beforeModes':{}}
        sha=lambda b:hashlib.sha256(b).hexdigest()
        for key,path in targets.items():
            before=('old '+key).encode();after=('new '+key).encode();(backup/(key+'.before')).write_bytes(before);path.write_bytes(after)
            state['beforeHashes'][key]=sha(before);state['candidateHashes'][key]=sha(after);state['beforeModes'][key]=0o644
        calls=[];journal=root/'journal.sqlite';journal.write_bytes(b'live signed intent');index=root/'index.sqlite';index.write_bytes(b'new verified headers')
        ns={'targets':targets,'backup':backup,'sha':sha,'regular':lambda p:p.read_bytes(),'preserved_surface':lambda strict=True:None,'current_database_ids':lambda:state['databaseIds'],
            'replace':lambda p,b,m:p.write_bytes(b),'run':lambda args,**kw:calls.append(args)}
        functions(['restore_hotfix'],ns);return ns,state,targets,calls,journal,index
    def test_concurrent_last_file_prevents_any_stop(self):
        ns,state,targets,calls,journal,index=self.fixture();targets['snippet'].write_bytes(b'concurrent admin')
        with self.assertRaises(AssertionError):ns['restore_hotfix'](state)
        self.assertEqual(calls,[])
    def test_changed_db_inode_prevents_stop(self):
        ns,state,targets,calls,journal,index=self.fixture();ns['current_database_ids']=lambda:{'journal':[1,99],'index':[1,3]}
        with self.assertRaises(AssertionError):ns['restore_hotfix'](state)
        self.assertEqual(calls,[])
    def test_failure_restores_both_services_and_routes_without_touching_databases(self):
        ns,state,targets,calls,journal,index=self.fixture();ns['restore_hotfix'](state)
        for key,path in targets.items():self.assertEqual(path.read_bytes(),('old '+key).encode())
        self.assertEqual(journal.read_bytes(),b'live signed intent');self.assertEqual(index.read_bytes(),b'new verified headers')
        self.assertIn(['systemctl','start','pinkuang-index-v2.service'],calls);self.assertIn(['systemctl','start','pinkuang-deploy-v2.service'],calls)
        self.assertEqual(calls[-2:],[['nginx','-t'],['systemctl','reload','nginx']])
        self.assertFalse(any('enable' in x or 'disable' in x for x in calls))

class RollbackLegacyRestart(unittest.TestCase):
    def test_unrelated_pid_change_does_not_block_rollback_surface_guard(self):
        stable={'LoadState':'loaded','ActiveState':'active','SubState':'running','User':'old','Group':'old','MainPID':'10','InvocationID':'old'}
        current={**stable,'MainPID':'11','InvocationID':'new'}
        baseline={'services':{'other':stable},'links':{'/old/current':'/old/release'}}
        observed={'services':{'other':current},'links':baseline['links']}
        content=b'unchanged';sha=lambda data:hashlib.sha256(data).hexdigest()
        ns={'legacy':lambda:observed,'CONFIG':{'legacy':baseline,'nginxSha256':sha(content),'trustedRecordSha256':sha(content)},
            'sha':sha,'regular':lambda p:content,'site':'site','record_path':'record','link_target':lambda:'/product',
            'product':'/product'}
        functions(['preserved_surface'],ns)
        ns['preserved_surface'](False)
        with self.assertRaisesRegex(AssertionError,'Legacy services'):ns['preserved_surface']()
        observed['links']={'/old/current':'/unexpected'}
        with self.assertRaisesRegex(AssertionError,'Legacy links'):ns['preserved_surface'](False)

if __name__=='__main__':unittest.main()
