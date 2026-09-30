import importlib.util
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


if __name__=='__main__':unittest.main()
