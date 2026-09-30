import importlib.util
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('drain',Path(__file__).with_name('legacy-gas-drain.remote.py'))
drain=importlib.util.module_from_spec(spec);spec.loader.exec_module(drain)
H='0x'+'a'*64;B='0x'+'b'*64;F='0x'+'c'*64;TARGET='0x'+'1'*40


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.directory=self.root/'journals';self.directory.mkdir();self.path=self.directory/'one.json'
        self.pointer=self.root/'wallet.json';self.plan={'journalDirectories':[str(self.directory)],
            'journalPaths':[str(self.path)],'walletPointerPaths':[str(self.pointer)]}
        self.t={'phase':'confirmed','finality':'bsc-finalized','from':drain.GAS,'nonce':0,'hash':H,
                'blockNumber':100,'blockHash':B,'finalizedBlockNumber':101,'finalizedBlockHash':F,
                'data':'0x1234','value':'0'}
        self.j={'version':1,'chainId':56,'pool':TARGET,'transaction':self.t}
        self.jwrite()
        self.pointer.write_text(json.dumps({'chainId':56,'address':drain.GAS,'journal':str(self.path)}));self.pointer.chmod(0o600)
        self.pending=1;self.latest=1;self.receipt_hash=B;self.input='0x1234';self.calls=[]
    def tearDown(self):self.tmp.cleanup()
    def jwrite(self):self.path.write_text(json.dumps(self.j));self.path.chmod(0o600)
    def rpc(self,method,args):
        self.calls.append((method,args))
        if method=='eth_chainId':return '0x38'
        if method=='eth_getBlockByNumber':
            return {'number':'0x65','hash':F,'timestamp':hex(int(time.time()))} if args[0] in ['finalized','0x65'] else {'number':'0x64','hash':B}
        if method=='eth_getTransactionCount':return hex(self.pending if args[1]=='pending' else self.latest)
        if method=='eth_getTransactionReceipt':return {'transactionHash':H,'blockNumber':'0x64','blockHash':self.receipt_hash,'status':'0x1'}
        if method=='eth_getTransactionByHash':return {'hash':H,'from':drain.GAS,'nonce':'0x0','to':TARGET,'input':self.input,'value':'0x0'}
        raise AssertionError(method)
    def test_consumed_canonical_finalized_transaction_passes(self):
        r=drain.reconcile(self.plan,self.rpc)
        self.assertEqual(r['cutoverNonce'],1);self.assertEqual(r['journals'][0]['txHash'],H)
        self.assertTrue(all(not name.startswith(('eth_send','eth_sign')) for name,_ in self.calls))
    def test_pending_nonce_blocks(self):
        self.pending=2
        with self.assertRaisesRegex(RuntimeError,'pending'):drain.reconcile(self.plan,self.rpc)
    def test_unresolved_journal_blocks_even_when_rpc_nonce_consumed(self):
        self.t['phase']='broadcast';self.jwrite()
        with self.assertRaisesRegex(RuntimeError,'Unresolved'):drain.reconcile(self.plan,self.rpc)
    def test_stored_receipt_on_fork_blocks(self):
        self.receipt_hash='0x'+'e'*64
        with self.assertRaisesRegex(RuntimeError,'canonical'):drain.reconcile(self.plan,self.rpc)
    def test_transaction_payload_mismatch_blocks(self):
        self.input='0x9999'
        with self.assertRaisesRegex(RuntimeError,'payload'):drain.reconcile(self.plan,self.rpc)
    def test_unreviewed_new_journal_blocks(self):
        (self.directory/'new.json').write_text('{}')
        with self.assertRaisesRegex(RuntimeError,'inventory'):drain.reconcile(self.plan,self.rpc)
    def test_lost_wallet_pointer_target_blocks(self):
        self.pointer.write_text(json.dumps({'chainId':56,'address':drain.GAS,'journal':'/missing.json'}))
        with self.assertRaisesRegex(RuntimeError,'pointer'):drain.reconcile(self.plan,self.rpc)
    def test_missing_finalized_anchor_blocks(self):
        del self.t['finalizedBlockHash'];self.jwrite()
        with self.assertRaisesRegex(RuntimeError,'finality proof'):drain.reconcile(self.plan,self.rpc)
    def test_higher_uncovered_nonce_blocks(self):
        self.latest=self.pending=2
        with self.assertRaisesRegex(RuntimeError,'cover'):drain.reconcile(self.plan,self.rpc)
    def test_legacy_sender_must_be_inactive_and_disabled(self):
        item={'unit':'pinkuang-purchase-v2.service','files':{str(self.path):drain.sha(self.path.read_bytes())}}
        state={'FragmentPath':str(self.path),'DropInPaths':'','TriggeredBy':'','ActiveState':'inactive','MainPID':'0'}
        with patch.object(drain,'unit_state',return_value=state),patch.object(drain,'run',return_value='enabled'):
            with self.assertRaisesRegex(RuntimeError,'enabled'):drain.verify_units({'senders':[item]},stopped=True)
        with patch.object(drain,'unit_state',return_value=state),patch.object(drain,'run',return_value='disabled'):
            self.assertEqual(drain.verify_units({'senders':[item]},stopped=True)[0]['enabled'],'disabled')


class ExternalMigrationTests(unittest.TestCase):
    jwrite=ReconcileTests.jwrite
    tearDown=ReconcileTests.tearDown
    def setUp(self):
        ReconcileTests.setUp(self)
        self.latest=self.pending=4
        self.plan['expectedCutoverNonce']=4
        self.plan['externalMigrationAcknowledgement']={'userInstructions':['直接开启吧','我要进行测试 然后上线了'],
            'scope':'continue-after-disclosed-transactions','transactionOriginConfirmed':False}
        self.ext=[];self.external_tx={};self.external_receipt={}
        for nonce in [1,2,3]:
            h='0x'+str(nonce)*64;b='0x'+str(nonce+3)*64;value='10000000000000000' if nonce==1 else '0'
            row={'nonce':nonce,'txHash':h,'from':drain.GAS,'to':TARGET,'valueWei':value,
                 'inputSha256':drain.sha(bytes.fromhex('abcdef')),'blockNumber':110+nonce,'blockHash':b,'status':1}
            self.ext.append(row)
            self.external_tx[h]={'chainId':'0x38','hash':h,'from':drain.GAS,'to':TARGET,'nonce':hex(nonce),
                 'value':hex(int(value)),'input':'0xAbCdEf','blockNumber':hex(110+nonce),'blockHash':b}
            self.external_receipt[h]={'transactionHash':h,'status':'0x1','blockNumber':hex(110+nonce),'blockHash':b}
        self.plan['acknowledgedExternalTransactions']=self.ext
        self.final_nonce=4;self.final_block=200
    def rpc(self,method,args):
        if method=='eth_getBlockByNumber' and args[0] in ['finalized',hex(self.final_block)]:
            self.calls.append((method,args));return {'number':hex(self.final_block),'hash':F,'timestamp':hex(int(time.time()))}
        if method=='eth_getTransactionCount' and args[1] not in ['pending','latest']:
            self.calls.append((method,args));return hex(self.final_nonce)
        if method in ['eth_getTransactionByHash','eth_getTransactionReceipt'] and args[0] in self.external_tx:
            self.calls.append((method,args));return (self.external_tx if method=='eth_getTransactionByHash' else self.external_receipt)[args[0]]
        if method=='eth_getBlockByNumber':
            for row in self.ext:
                if args[0]==hex(row['blockNumber']):
                    self.calls.append((method,args));return {'number':hex(row['blockNumber']),'hash':row['blockHash']}
        return ReconcileTests.rpc(self,method,args)
    def test_external_evidence_is_distinct_and_preserves_original_bytes(self):
        before=[p.read_bytes() for p in [self.path,self.pointer]]
        result=drain.reconcile(self.plan,self.rpc)
        self.assertEqual(result['cutoverNonce'],4)
        self.assertEqual([r['nonce'] for r in result['journals']],[0,1,2,3])
        self.assertNotIn('evidenceKind',result['journals'][0])
        evidence=result['externalMigrationEvidence'];self.assertEqual(evidence['kind'],'external-finalized-migration-evidence')
        self.assertFalse(evidence['userAcknowledgment']['transactionOriginConfirmed'])
        self.assertNotIn('version',evidence);self.assertNotIn('transaction',evidence)
        digest=drain.sha(drain.evidence_bytes(evidence))
        for row in result['journals'][1:]:
            self.assertEqual(row['journalSha256'],digest)
            self.assertEqual(row['evidenceKind'],'external-finalized-migration-evidence')
            self.assertEqual(row['journalSha256Meaning'],'independent-migration-evidence-bytes')
        self.assertEqual(before,[p.read_bytes() for p in [self.path,self.pointer]])
        self.assertFalse(result['externalEvidenceWritten'])
        self.assertTrue(all(not name.startswith(('eth_send','eth_sign')) for name,_ in self.calls))
    def test_calldata_hash_is_of_bytes_not_hex_text(self):
        self.ext[0]['inputSha256']=drain.sha(b'0xAbCdEf')
        with self.assertRaisesRegex(RuntimeError,'payload'):drain.reconcile(self.plan,self.rpc)
    def test_external_payload_mutations_block(self):
        h=self.ext[0]['txHash'];original=copy.deepcopy(self.external_tx[h])
        for field,value in [('chainId','0x1'),('from',TARGET),('to','0x'+'2'*40),('value','0x0'),('input','0x00'),('nonce','0x2')]:
            with self.subTest(field=field):
                self.external_tx[h]={**original,field:value}
                with self.assertRaisesRegex(RuntimeError,'payload'):drain.reconcile(self.plan,self.rpc)
        self.external_tx[h]=original
    def test_external_receipt_mutations_block(self):
        h=self.ext[0]['txHash'];original=copy.deepcopy(self.external_receipt[h])
        for field,value in [('status','0x0'),('blockHash','0x'+'f'*64),('blockNumber','0x64'),('transactionHash',H)]:
            with self.subTest(field=field):
                self.external_receipt[h]={**original,field:value}
                with self.assertRaisesRegex(RuntimeError,'canonical'):drain.reconcile(self.plan,self.rpc)
        self.external_receipt[h]=original
    def test_external_future_block_rejected(self):
        self.final_block=112
        with self.assertRaisesRegex(RuntimeError,'canonical'):drain.reconcile(self.plan,self.rpc)
    def test_new_fifth_nonce_not_in_reviewed_plan_blocks(self):
        self.latest=self.pending=self.final_nonce=5
        with self.assertRaisesRegex(RuntimeError,'explicitly reviewed'):drain.reconcile(self.plan,self.rpc)
    def test_finalized_nonce_behind_latest_blocks(self):
        self.final_nonce=3
        with self.assertRaisesRegex(RuntimeError,'not finalized'):drain.reconcile(self.plan,self.rpc)
    def test_missing_external_nonce_blocks(self):
        self.ext.pop(1)
        with self.assertRaisesRegex(RuntimeError,'every nonce'):drain.reconcile(self.plan,self.rpc)
    def test_overlap_worker_nonce_rejected(self):
        h=self.ext[0]['txHash'];self.ext[0]['nonce']=0;self.external_tx[h]['nonce']='0x0'
        with self.assertRaisesRegex(RuntimeError,'every nonce'):drain.reconcile(self.plan,self.rpc)
    def test_duplicate_external_nonce_or_hash_rejected(self):
        for field in ['nonce','txHash']:
            with self.subTest(field=field):
                p=copy.deepcopy(self.plan);p['acknowledgedExternalTransactions'][1][field]=p['acknowledgedExternalTransactions'][0][field]
                with self.assertRaisesRegex(RuntimeError,'Duplicate'):drain.external_transactions(p)
    def test_missing_or_false_acknowledgment_rejected(self):
        del self.plan['externalMigrationAcknowledgement']
        with self.assertRaisesRegex(RuntimeError,'acknowledgment'):drain.external_transactions(self.plan)
        self.plan['externalMigrationAcknowledgement']={'userInstructions':['accepted'],'scope':'continue-after-disclosed-transactions','transactionOriginConfirmed':True}
        with self.assertRaisesRegex(RuntimeError,'acknowledgment'):drain.external_transactions(self.plan)
    def test_nonce_changes_after_evidence_reads_blocks(self):
        count=0
        def changing(method,args):
            nonlocal count
            value=self.rpc(method,args)
            if method=='eth_getTransactionCount' and args[1]=='latest':
                count+=1
                if count==2:return '0x5'
            return value
        with self.assertRaisesRegex(RuntimeError,'changed'):drain.reconcile(self.plan,changing)
    def test_wallet_pointer_mutation_during_reads_blocks(self):
        count=0
        def changing(method,args):
            nonlocal count
            value=self.rpc(method,args)
            if method=='eth_getTransactionCount' and args[1]=='latest':
                count+=1
                if count==2:self.pointer.write_text('{}')
            return value
        with self.assertRaisesRegex(RuntimeError,'Wallet pointer changed'):drain.reconcile(self.plan,changing)
    def test_inspect_never_writes_migration_or_drain_files(self):
        with patch.object(drain.os,'geteuid',return_value=0,create=True),patch.object(drain,'verify_units',return_value=[]),patch.object(drain,'sender_processes',return_value=[]),patch.object(drain,'rpc_client',return_value=self.rpc),patch.object(drain,'write_root_evidence') as write:
            p={**self.plan,'senders':[{'unit':'pinkuang-purchase-v2.service'}]}
            result=drain.execute(p,'inspect');self.assertFalse(result['proofWritten']);write.assert_not_called()
    def test_existing_migration_evidence_refuses_before_stopping_sender(self):
        migration=self.root/'migration.json';migration.write_text('{}')
        with patch.object(drain.os,'geteuid',return_value=0,create=True),patch.object(drain,'verify_units',return_value=[]),patch.object(drain,'PROOF',self.root/'proof.json'),patch.object(drain,'EXTERNAL_EVIDENCE',migration),patch.object(drain,'run') as run:
            p={**self.plan,'senders':[{'unit':'pinkuang-purchase-v2.service'}]}
            with self.assertRaisesRegex(RuntimeError,'never overwrite'):drain.execute(p,'stop-and-attest')
            run.assert_not_called()


class RootEvidenceTests(unittest.TestCase):
    def test_root_evidence_is_create_only_and_group_readable(self):
        # Ownership syscalls are isolated, while O_EXCL/NOFOLLOW and real
        # filesystem permissions are exercised without touching /etc.
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'migration.json'
            st=root.stat();fake=type('Stat',(),{'st_uid':0,'st_mode':st.st_mode})()
            original=Path.stat
            def stat(path,*args,**kwargs):return fake if path==root else original(path,*args,**kwargs)
            with patch.object(Path,'stat',stat),patch.object(drain.os,'fchown') as chown,patch.object(drain.grp,'getgrnam',return_value=type('Group',(),{'gr_gid':123})()):
                drain.write_root_evidence(path,b'evidence\n')
                self.assertEqual(path.read_bytes(),b'evidence\n');chown.assert_called_once()
                self.assertEqual(path.stat().st_mode&0o777,0o640)
                with self.assertRaises(FileExistsError):drain.write_root_evidence(path,b'replaced')
                self.assertEqual(path.read_bytes(),b'evidence\n')


if __name__=='__main__':unittest.main()
