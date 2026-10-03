from contextlib import closing, contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = Path(__file__).parent
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

m = module('release_hold', BASE / 'release-stage2-hold.py')
u = module('reviewed_updater', Path(os.environ.get('HOLD_UPDATER', str(BASE / 'update-completed-console.remote.py'))))


@contextmanager
def database(path):
    with closing(sqlite3.connect(path)) as db:
        with db:
            yield db


class FakeHost:
    def __init__(self, updater, plan):
        self.u, self.p = updater, plan
        self.commands = []; self.state = 'active'; self.proofs = 0; self.chains = 0
        self.fail_chain = False; self.fail_proof = False; self.fail_health = False
        self.race_drop = False; self.race_unit = False
    def package(self, p): pass
    def protected(self): return {'v2': {'pid': 12, 'invocation': 'same'}}
    def configuration(self, p, hold, *, active=True):
        m.require(self.u.sha(self.u.regular(self.u.UNIT)) == p['unitSha256'], 'unit changed')
        m.require(self.state == ('active' if active else 'inactive'), 'process changed')
        if active:
            m.require(('HOLD='+str(hold)+'\n').encode() in (self.u.DROPINS / '20-stage2-attestation.conf').read_bytes(), 'flag changed')
    def chain(self, p, proof):
        self.chains += 1
        m.require(not self.fail_chain, 'nonce failed')
        return {'verified': True, 'nonce': proof['nonce'], 'blockNumber': 100, 'blockHash': '0x'+'a'*64}
    def proof(self, p):
        self.proofs += 1
        m.require(not self.fail_proof, 'proof failed')
    def health(self, p):
        if self.fail_health and any(cmd[:2] == ['systemctl','start'] for cmd in self.commands):
            self.fail_health = False
            if self.race_drop:
                (self.u.DROPINS / '20-stage2-attestation.conf').write_text('external change\n')
            if self.race_unit:
                self.u.UNIT.write_text('external main unit\n')
            raise RuntimeError('health failed')
    def run(self, args):
        self.commands.append(args)
        if args[1] == 'stop': self.state = 'inactive'
        if args[1] == 'start': self.state = 'active'


class HoldTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.saved = {key: getattr(u, key) for key in ('UNIT','DROPINS','DB','RELEASES','regular')}
        u.UNIT = self.root / 'main.service'; u.UNIT.write_text('unchanged main unit\n')
        u.DROPINS = self.root / 'main.service.d'; u.DROPINS.mkdir()
        u.DB = self.root / 'journal.sqlite'; u.RELEASES = self.root / 'releases'
        # Offline fixtures run on Windows too; root ownership is tested by the Linux installer suite.
        u.regular = lambda path: path.read_bytes()
        self.drop = u.DROPINS / '20-stage2-attestation.conf'
        self.original = b'[Service]\nEnvironment=BEMINE_FRESH_STAGE2_HOLD=1\nEnvironment=AUTHORITY_RELAY_ENABLED=0\n'
        self.drop.write_bytes(self.original)
        self.record = {'id':'fixture-deploy','account':'0x'+'1'*40,'artifactDigest':'0x'+'2'*64,
                       'status':'complete','kind':'integrated-v2','chainId':56,
                       'addresses':{'factory':'0x'+'3'*40,'portfolioFactory':'0x'+'4'*40},
                       'steps':[{'status':'confirmed','nonce':i} for i in range(16)]}
        with database(u.DB) as db:
            db.execute('CREATE TABLE deployment (account TEXT, revision INTEGER, record TEXT)')
            db.execute('INSERT INTO deployment VALUES (?,?,?)', (self.record['account'], 1, json.dumps(self.record)))
            for table in u.TABLES: db.execute('CREATE TABLE '+table+' (id TEXT)')
        self.p = {name:'a'*64 for name in ('manifestSha256','unitSha256','publicDropInSha256','journalSha256',
            'artifactSha256','signerManifestSha256','signerUnitSha256','updaterSha256','attestorHelperSha256',
            'chainProofSha256','protocolEvidenceSha256')}
        self.p.update(schemaVersion=1,operationId='hold-release-test',releaseId='v4-new',sourceHead='b'*40,
            artifactDigest=self.record['artifactDigest'],account=self.record['account'],deploymentId=self.record['id'],signerReleaseId='v4-new-signer',
            unitSha256=u.sha(u.UNIT.read_bytes()),publicDropInSha256=u.sha(self.original),
            journalSha256=u.sha(u.canonical({'account':self.record['account'],'revision':1,'record':self.record})))
        self.chain = {'schemaVersion':1,'fullDeploymentVerified':True,'chainId':56,
            'sourceHead':self.p['sourceHead'],'artifactDigest':self.p['artifactDigest'],
            'journalSha256':self.p['journalSha256'],'account':self.p['account'],'deploymentId':self.p['deploymentId'],
            'checkedAt':datetime.now(timezone.utc).isoformat(),'blockNumber':100,'blockHash':'0x'+'a'*64,'nonce':16}
        self.protocol = {'schemaVersion':1,'sourceHead':self.p['sourceHead'],'header':m.HEADER,'version':'2',
            'realHttpIntegrationPassed':True,'authenticatedMissingVersionStatus':426,'unauthenticatedStatus':401}
        self.host = FakeHost(u,self.p)
        self.release = m.Release(self.host,self.p,self.chain,self.protocol)
        self.release.evidence = self.root / 'evidence'
    def tearDown(self):
        for key,value in self.saved.items(): setattr(u,key,value)
        self.temp.cleanup()
    def test_dry_run_does_not_change_files_or_services(self):
        before=u.DB.read_bytes(); result=self.release.preflight()
        self.assertTrue(result['readyForHoldRelease']); self.assertEqual(self.host.commands,[])
        self.assertEqual(self.drop.read_bytes(),self.original); self.assertEqual(u.DB.read_bytes(),before)
    def test_apply_only_changes_hold_preserves_main_and_journal(self):
        before=u.DB.read_bytes(); unit=u.UNIT.read_bytes(); result=self.release.apply()
        self.assertFalse(result['stage2Held']); self.assertFalse(result['relayEnabled'])
        self.assertFalse(result['onChainActivationComplete']); self.assertEqual(u.DB.read_bytes(),before)
        self.assertEqual(u.UNIT.read_bytes(),unit); self.assertEqual(self.drop.read_bytes(),m.replacement(self.original))
        self.assertEqual(self.host.commands,[['systemctl','stop',m.PUBLIC],['systemctl','daemon-reload'],['systemctl','start',m.PUBLIC]])
    def test_stale_chain_proof_never_stops_service(self):
        self.chain['checkedAt']=(datetime.now(timezone.utc)-timedelta(seconds=301)).isoformat()
        with self.assertRaisesRegex(RuntimeError,'stale'): self.release.apply()
        self.assertEqual(self.host.commands,[])
    def test_future_chain_proof_rejected(self):
        self.chain['checkedAt']=(datetime.now(timezone.utc)+timedelta(seconds=10)).isoformat()
        with self.assertRaises(RuntimeError): self.release.preflight()
    def test_protocol_wrong_source_or_no_actual_http_rejected(self):
        for field,value in [('sourceHead','c'*40),('realHttpIntegrationPassed',False),('version','1'),('authenticatedMissingVersionStatus',401)]:
            wrong={**self.protocol,field:value}
            with self.assertRaises(RuntimeError): m.validate_evidence(self.p,self.chain,wrong)
    def test_changed_stage1_revision_rejected(self):
        with database(u.DB) as db: db.execute('UPDATE deployment SET revision=2')
        with self.assertRaisesRegex(RuntimeError,'changed'): self.release.apply()
        self.assertEqual(self.host.commands,[])
    def test_incomplete_stage1_rejected(self):
        self.record['steps'][15]['status']='submitted'
        with database(u.DB) as db: db.execute('UPDATE deployment SET record=?',(json.dumps(self.record),))
        with self.assertRaises(RuntimeError): self.release.apply()
    def test_stage2_must_be_empty(self):
        with database(u.DB) as db: db.execute("INSERT INTO fresh_activation VALUES ('new')")
        with self.assertRaisesRegex(RuntimeError,'no longer empty'): self.release.apply()
        self.assertEqual(self.host.commands,[])
    def test_nonce_mismatch_before_stop(self):
        self.host.fail_chain=True
        with self.assertRaises(RuntimeError): self.release.apply()
        self.assertEqual(self.host.commands,[])
    def test_gas_proof_failure_before_stop(self):
        self.host.fail_proof=True
        with self.assertRaises(RuntimeError): self.release.apply()
        self.assertEqual(self.host.commands,[])
    def test_cas_refuses_external_dropin(self):
        self.drop.write_text('external')
        with self.assertRaisesRegex(RuntimeError,'CAS'): self.release.cas(self.original,b'next')
        self.assertEqual(self.drop.read_text(),'external')
    def test_health_failure_rolls_back_own_dropin_only(self):
        before=u.DB.read_bytes(); self.host.fail_health=True
        with self.assertRaisesRegex(RuntimeError,'health'): self.release.apply()
        self.assertEqual(self.drop.read_bytes(),self.original); self.assertEqual(u.DB.read_bytes(),before)
        self.assertEqual(self.host.state,'active')
        self.assertTrue(json.loads((self.release.evidence/'result.json').read_text())['rolledBackToHold'])
    def test_rollback_refuses_other_operators_dropin(self):
        self.host.fail_health=True; self.host.race_drop=True
        with self.assertRaisesRegex(RuntimeError,'rollback refused'): self.release.apply()
        self.assertEqual(self.drop.read_text(),'external change\n'); self.assertEqual(self.host.state,'inactive')
    def test_rollback_refuses_other_operators_main_unit(self):
        self.host.fail_health=True; self.host.race_unit=True
        with self.assertRaisesRegex(RuntimeError,'rollback refused'): self.release.apply()
        self.assertEqual(u.UNIT.read_text(),'external main unit\n'); self.assertEqual(self.host.state,'inactive')
    def test_journal_written_after_start_is_not_restored(self):
        original_health=self.host.health
        def after_start(p):
            original_health(p)
            if any(c[:2]==['systemctl','start'] for c in self.host.commands):
                with database(u.DB) as db: db.execute("INSERT INTO fresh_activation VALUES ('preserve')")
        self.host.health=after_start
        with self.assertRaises(RuntimeError): self.release.apply()
        with database(u.DB) as db: self.assertGreater(db.execute('SELECT COUNT(*) FROM fresh_activation').fetchone()[0],0)
        self.assertEqual(self.drop.read_bytes(),self.original)
    def test_ambiguous_or_already_released_hold_rejected(self):
        for raw in (self.original+self.original, m.replacement(self.original), self.original+b'# BEMINE_FRESH_STAGE2_HOLD=1\n'):
            with self.assertRaises(RuntimeError): m.replacement(raw)
    def test_operation_id_reuse_rejected(self):
        self.release.evidence.mkdir()
        with self.assertRaisesRegex(RuntimeError,'already exists'): self.release.apply()
        self.assertEqual(self.host.commands,[])
    def test_no_private_or_session_output(self):
        output=json.dumps(self.release.preflight())
        for word in ('PRIVATE_KEY','signature','session','rpcUrl','cookie'): self.assertNotIn(word,output)


class RpcProbeTests(unittest.TestCase):
    """Real ethers/HTTP parsing against isolated localhost data; never public RPC."""
    @classmethod
    def setUpClass(cls):
        cls.runtime = os.environ.get('HOLD_DEPLOY_ROOT')
        if not cls.runtime:
            raise unittest.SkipTest('Set HOLD_DEPLOY_ROOT for the isolated ethers HTTP checks.')
        cls.node = os.environ.get('HOLD_NODE', 'node')
        derive = r'''import {pathToFileURL} from 'node:url';
const {Interface}=await import(pathToFileURL(process.argv[1]+'/node_modules/ethers/lib.esm/index.js'));
const i=new Interface(['function owner() view returns(address)','function operator() view returns(address)',
'function treasury() view returns(address)','function poolCount() view returns(uint256)',
'function portfolioCount() view returns(uint256)','function creationPaused() view returns(bool)']);
console.log(JSON.stringify(Object.fromEntries(['owner','operator','treasury','poolCount','portfolioCount','creationPaused'].map(n=>[i.encodeFunctionData(n),n]))));'''
        cls.selectors=json.loads(subprocess.check_output([cls.node,'--input-type=module','--eval',derive,cls.runtime],text=True))
    def probe(self, defect=None):
        methods=[]; selectors=self.selectors; block_reads=0
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(inner):
                nonlocal block_reads
                data=json.loads(inner.rfile.read(int(inner.headers['content-length'])))
                name=data['method']; params=data['params']; methods.append(name)
                value=None
                if name=='eth_chainId': value='0x38'
                elif name=='eth_getBlockByNumber':
                    number=100 if params[0]=='0x64' else 101
                    if number==101: block_reads+=1
                    value={'number':hex(number),'hash':'0x'+('a' if number==100 else 'b')*64,'timestamp':hex(int(time.time()))}
                    if defect=='canonical' and block_reads==2: value['hash']='0x'+'c'*64
                elif name=='eth_call':
                    self.assertEqual(params[1],'0x65')
                    role=selectors[params[0]['data']]
                    value='0x'+('0'*24+'1'*40 if role in ('owner','operator','treasury') else '0'*64)
                    if defect=='role' and role=='operator': value='0x'+'0'*24+'2'*40
                elif name=='eth_getTransactionCount':
                    value=hex(17 if defect=='nonce' and params[1]=='pending' else 16)
                body=json.dumps({'jsonrpc':'2.0','id':data['id'],'result':value}).encode()
                inner.send_response(200); inner.send_header('Content-Type','application/json'); inner.send_header('Content-Length',str(len(body))); inner.end_headers(); inner.wfile.write(body)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        inputs={'rpc':'http://127.0.0.1:'+str(server.server_port),'proof':{'blockNumber':100,'blockHash':'0x'+'a'*64,'nonce':16},
                'account':'0x'+'1'*40,'factory':'0x'+'3'*40,'portfolioFactory':'0x'+'4'*40}
        try:
            result=subprocess.run([self.node,'--input-type=module','--eval',m.CHAIN_JS,self.runtime],
                input=json.dumps(inputs),capture_output=True,text=True,timeout=25)
        finally:
            server.shutdown();server.server_close();worker.join()
        self.assertTrue(set(methods)<={'eth_chainId','eth_getBlockByNumber','eth_call','eth_getTransactionCount'})
        self.assertNotIn('http',result.stdout); self.assertNotIn('signature',result.stdout)
        return result,json.loads(result.stdout)
    def test_real_http_roles_and_nonce_all_verified(self):
        result,evidence=self.probe();self.assertEqual(result.returncode,0);self.assertTrue(evidence['verified'])
    def test_real_http_wrong_role_fails_closed(self):
        result,evidence=self.probe('role');self.assertEqual(result.returncode,1);self.assertFalse(evidence['verified'])
    def test_real_http_pending_nonce_fails_closed(self):
        result,evidence=self.probe('nonce');self.assertEqual(result.returncode,1);self.assertFalse(evidence['verified'])
    def test_real_http_reorg_fails_closed(self):
        result,evidence=self.probe('canonical');self.assertEqual(result.returncode,1);self.assertFalse(evidence['verified'])


if __name__=='__main__': unittest.main(verbosity=2)
