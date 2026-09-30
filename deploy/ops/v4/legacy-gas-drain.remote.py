#!/usr/bin/env python3
"""Inspect or explicitly stop legacy senders and attest consumed nonce history.

No key access, signing, replacement, rebroadcast, journal edit or automatic
restart. Failure after stop intentionally leaves the old sender stopped.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time
import urllib.request

GAS = '0xA285d1933e32b5990625aC1F5BEa205Cf2606619'
PROOF = Path('/etc/pinkuang-v4/legacy-drain.json')
EXTERNAL_EVIDENCE = Path('/etc/pinkuang-v4/external-finalized-migration.json')
TERMINAL = {'confirmed', 'reverted', 'cancelled', 'cancel-reverted'}
HEX = re.compile(r'0x[0-9a-fA-F]{64}')


def need(ok, reason):
    if not ok: raise RuntimeError(reason)


def sha(raw): return hashlib.sha256(raw).hexdigest()


def evidence_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'))+'\n').encode()


def external_transactions(plan):
    """Explicitly disclosed transactions, never synthetic worker journal entries."""
    rows=plan.get('acknowledgedExternalTransactions',[])
    need(isinstance(rows,list) and len(rows)<=1000,'Invalid external migration inventory.')
    if not rows:
        need('expectedCutoverNonce' not in plan,'Pinned cutover requires external migration inventory.')
        return []
    end=plan.get('expectedCutoverNonce')
    need(type(end) is int and 0<end<=1000,'Missing bounded expected external cutover nonce.')
    acknowledgment=plan.get('externalMigrationAcknowledgement')
    need(isinstance(acknowledgment,dict)
         and set(acknowledgment)=={'userInstructions','scope','transactionOriginConfirmed'}
         and acknowledgment.get('scope')=='continue-after-disclosed-transactions'
         and acknowledgment.get('transactionOriginConfirmed') is False
         and isinstance(acknowledgment.get('userInstructions'),list)
         and 1<=len(acknowledgment['userInstructions'])<=5
         and all(isinstance(t,str) and 0<len(t)<=500 for t in acknowledgment['userInstructions']),
         'External migration must record the limited user acknowledgment, not an attributed sender.')
    fields={'nonce','txHash','from','to','valueWei','inputSha256','blockNumber','blockHash','status'}
    for row in rows:
        need(isinstance(row,dict) and set(row)==fields,'External transaction fields must be exact.')
        need(type(row['nonce']) is int and 0<=row['nonce']<end
             and isinstance(row['txHash'],str) and HEX.fullmatch(row['txHash'])
             and isinstance(row['blockHash'],str) and HEX.fullmatch(row['blockHash'])
             and type(row['blockNumber']) is int and row['blockNumber']>0
             and type(row['status']) is int and row['status'] in [0,1],
             'Invalid external transaction identity.')
        need(isinstance(row['from'],str) and row['from'].lower()==GAS.lower()
             and isinstance(row['to'],str) and re.fullmatch(r'0x[0-9a-fA-F]{40}',row['to'])
             and isinstance(row['valueWei'],str) and re.fullmatch(r'0|[1-9][0-9]{0,77}',row['valueWei'])
             and int(row['valueWei'])<2**256
             and isinstance(row['inputSha256'],str) and re.fullmatch(r'[0-9a-f]{64}',row['inputSha256']),
             'Invalid external transaction payload binding.')
    need(len({r['nonce'] for r in rows})==len(rows)
         and len({r['txHash'].lower() for r in rows})==len(rows),'Duplicate external migration transaction.')
    return rows


def run(args, timeout=15, allow_failure=False):
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if p.returncode and not allow_failure: raise RuntimeError(f'{Path(args[0]).name} failed ({p.returncode}).')
    return p.stdout.strip()


def unit_state(name):
    return dict(x.split('=',1) for x in run(['systemctl','show',name,
        '--property=LoadState,ActiveState,MainPID,FragmentPath,DropInPaths,InvocationID,TriggeredBy']).splitlines() if '=' in x)


def private_file(path):
    p = Path(path)
    need(p.is_absolute() and p.resolve() == p and p.is_file() and not p.is_symlink(), 'Noncanonical ledger path.')
    need(stat.S_IMODE(p.stat().st_mode) & 0o077 == 0, 'Legacy ledger is not private.')
    raw=p.read_bytes();need(len(raw)<=10_000_000,'Oversized ledger.')
    return raw,json.loads(raw)


def parse_plan(raw):
    p=json.loads(raw)
    need(p.get('schemaVersion')==1 and p.get('kind')=='bemine-v4-legacy-drain-plan'
         and p.get('chainId')==56 and p.get('gasWallet')==GAS,'Wrong drain plan.')
    need(p.get('rpcSourceUnit')=='pinkuang-deploy-v4.service','RPC must come from existing reviewed console.')
    units=p.get('senders',[])
    need(units and any(u.get('unit')=='pinkuang-purchase-v2.service' for u in units),'Missing known original sender.')
    need(len({u['unit'] for u in units})==len(units),'Duplicate sender.')
    for u in units:
        need(re.fullmatch(r'pinkuang-[a-z0-9-]+(?:-v[123])?\.service',u.get('unit',''))
             and u['unit'] not in ['pinkuang-v4-signer.service','pinkuang-deploy-v4.service'], 'Invalid legacy sender unit.')
        need(isinstance(u.get('files'),dict) and u['files'],'Missing pinned unit inventory.')
        for path,digest in u['files'].items():
            need(path.startswith('/etc/systemd/system/') and re.fullmatch('[0-9a-f]{64}',digest),'Invalid unit hash.')
    for key in ['journalPaths','walletPointerPaths','journalDirectories']:
        need(isinstance(p.get(key),list) and len(p[key])<=1000,'Missing ledger inventory.')
        for path in p[key]:
            need(path.startswith('/var/lib/pinkuang-') and '/..' not in path,'Invalid legacy ledger root.')
    external_transactions(p)
    return p


def verify_units(plan, stopped=False):
    result=[]
    for item in plan['senders']:
        s=unit_state(item['unit'])
        files=[s.get('FragmentPath')]+s.get('DropInPaths','').split()
        need(set(x for x in files if x)==set(item['files']),'Legacy unit/drop-in inventory changed.')
        for path,digest in item['files'].items(): need(sha(Path(path).read_bytes())==digest,'Legacy unit content changed.')
        need(s.get('TriggeredBy','')=='','Triggered legacy sender needs explicit trigger retirement review.')
        enabled=run(['systemctl','is-enabled',item['unit']],allow_failure=True)
        if stopped:
            need(s.get('ActiveState')=='inactive' and s.get('MainPID')=='0','Legacy sender has not fully stopped.')
            need(enabled in ['disabled','masked','masked-runtime'],'Legacy sender remains enabled.')
        result.append({'unit':item['unit'],'state':s,'enabled':enabled,'files':item['files']})
    return result


def sender_processes():
    result=[]
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():continue
        try:
            argv=p.joinpath('cmdline').read_bytes().decode(errors='replace').split('\0')
            env=dict(x.decode(errors='replace').split('=',1) for x in p.joinpath('environ').read_bytes().split(b'\0') if b'=' in x)
            modules=[a for a in argv if a.endswith('.mjs') and re.search('(?:purchase|mining|authority|treasury)(?:-|/)',a)]
            credential_dir=env.get('CREDENTIALS_DIRECTORY','')
            credential_names=[x.name for x in Path(credential_dir).iterdir()] if credential_dir and Path(credential_dir).is_dir() else []
            has_keeper_credential=any(re.search('keeper|gas|private.key',x,re.I) for x in credential_names)
            key_env='KEEPER_PRIVATE_KEY' in env or 'KEEPER_PRIVATE_KEY_FILE' in env
            if not modules and not has_keeper_credential and not key_env:continue
            is_attestor=any(a.endswith('/server/authority-signer.mjs') for a in modules)
            if is_attestor and env.get('AUTHORITY_SIGNER_ATTEST_ONLY')=='1' and env.get('AUTHORITY_RELAY_ENABLED')=='0':continue
            if '--send' in argv or env.get('AUTHORITY_RELAY_ENABLED')=='1' or has_keeper_credential or key_env:
                result.append({'pid':int(p.name),'modules':modules,'cgroup':p.joinpath('cgroup').read_text().strip()})
        except (FileNotFoundError,ProcessLookupError):continue
    return result


def rpc_client(plan):
    s=unit_state(plan['rpcSourceUnit']);pid=int(s.get('MainPID','0'))
    need(pid>0,'Reviewed RPC source service is unavailable.')
    env=dict(x.decode().split('=',1) for x in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in x)
    url=env.get('DEPLOYMENT_JOURNAL_RPC_URL','')
    need(url.startswith('https://'),'Reviewed HTTPS RPC is unavailable.')
    def rpc(method,params):
        try:
            req=urllib.request.Request(url,data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=15) as response: value=json.load(response)
            need(value.get('jsonrpc')=='2.0' and value.get('id')==1 and 'error' not in value and value.get('result') is not None,'RPC result missing.')
            return value['result']
        except Exception: raise RuntimeError(f'Read-only {method} unavailable; no drain proof issued.') from None
    return rpc


def reconcile(plan,rpc):
    external=external_transactions(plan)
    need(rpc('eth_chainId',[])=='0x38','RPC is not BSC mainnet.')
    finalized=rpc('eth_getBlockByNumber',['finalized',False])
    final_number=int(finalized['number'],16)
    need(0<=time.time()-int(finalized['timestamp'],16)<=120,'Finalized head is stale.')
    canonical=rpc('eth_getBlockByNumber',[hex(final_number),False])
    need(canonical['hash'].lower()==finalized['hash'].lower(),'Finalized/numeric block mismatch.')
    latest=int(rpc('eth_getTransactionCount',[GAS,'latest']),16)
    pending=int(rpc('eth_getTransactionCount',[GAS,'pending']),16)
    final_nonce=int(rpc('eth_getTransactionCount',[GAS,hex(final_number)]),16)
    need(latest==pending==final_nonce,'Gas nonce is pending or not finalized.')
    if external:
        need(latest==plan['expectedCutoverNonce'],'Gas nonce differs from the explicitly reviewed external cutover.')
    actual=set()
    for directory in plan['journalDirectories']:
        p=Path(directory);need(p.is_dir() and p.resolve()==p,'Legacy journal directory is missing or linked.')
        actual.update(str(x) for x in p.glob('*.json'))
    need(actual==set(plan['journalPaths']),'Legacy journal inventory changed; include every journal in a new plan.')
    journals=[];hashes={};highest=-1
    for path in plan['journalPaths']:
        raw,j=private_file(path);hashes[path]=sha(raw)
        need(j.get('version')==1 and j.get('chainId')==56,'Wrong legacy journal schema.')
        t=j.get('transaction')
        if t is None: continue
        need(t.get('phase') in TERMINAL and t.get('finality')=='bsc-finalized','Unresolved legacy journal transaction.')
        need(isinstance(t.get('finalizedBlockNumber'),int) and t['finalizedBlockNumber']>=t.get('blockNumber',0)
             and t['finalizedBlockNumber']<=final_number and HEX.fullmatch(t.get('finalizedBlockHash','')),
             'Legacy stored finality proof is missing.')
        need(str(t.get('from','')).lower()==GAS.lower() and isinstance(t.get('nonce'),int)
             and 0<=t['nonce']<final_nonce,'Legacy sender/nonce is not finalized and consumed.')
        need(HEX.fullmatch(t.get('hash','')) and HEX.fullmatch(t.get('blockHash','')),'Malformed legacy receipt identity.')
        receipt=rpc('eth_getTransactionReceipt',[t['hash']]);tx=rpc('eth_getTransactionByHash',[t['hash']])
        block_number=int(receipt['blockNumber'],16)
        header=rpc('eth_getBlockByNumber',[hex(block_number),False])
        stored_final=rpc('eth_getBlockByNumber',[hex(t['finalizedBlockNumber']),False])
        need(stored_final['hash'].lower()==t['finalizedBlockHash'].lower(),'Stored finalized anchor is no longer canonical.')
        need(block_number==t['blockNumber'] and block_number<=final_number
             and receipt['blockHash'].lower()==t['blockHash'].lower()==header['hash'].lower()
             and receipt['transactionHash'].lower()==t['hash'].lower(),'Legacy receipt is not canonical finalized.')
        need(tx['hash'].lower()==t['hash'].lower() and tx['from'].lower()==GAS.lower()
             and int(tx['nonce'],16)==t['nonce'] and int(tx['value'],16)==0,'Legacy transaction differs from journal.')
        is_cancel=t['phase'] in {'cancelled','cancel-reverted'}
        target=GAS if is_cancel else j.get('transactionTarget',j.get('pool'))
        data='0x' if is_cancel else t.get('data')
        need(tx['to'].lower()==str(target).lower() and tx['input'].lower()==str(data).lower(),'Legacy transaction payload differs.')
        expected_status=1 if t['phase'] in {'confirmed','cancelled'} else 0
        need(int(receipt['status'],16)==expected_status,'Legacy receipt status differs.')
        highest=max(highest,t['nonce'])
        journals.append({'journalSha256':sha(raw),'phase':t['phase'],'nonce':t['nonce'],'txHash':t['hash'],
                         'blockNumber':block_number,'blockHash':receipt['blockHash']})
    pointers=[]
    pointer_hashes={}
    for path in plan['walletPointerPaths']:
        raw,p=private_file(path)
        need(p.get('chainId')==56 and str(p.get('address','')).lower()==GAS.lower()
             and p.get('journal') in hashes,'Wallet pointer references a missing or unreviewed journal.')
        pointers.append({'path':path,'sha256':sha(raw),'journal':p['journal']})
        pointer_hashes[path]=sha(raw)
    migration=None
    if external:
        for row in external:
            tx=rpc('eth_getTransactionByHash',[row['txHash']])
            receipt=rpc('eth_getTransactionReceipt',[row['txHash']])
            header=rpc('eth_getBlockByNumber',[hex(row['blockNumber']),False])
            need(tx.get('chainId') is not None and int(tx['chainId'],16)==56
                 and tx['hash'].lower()==row['txHash'].lower()
                 and tx['from'].lower()==row['from'].lower() and int(tx['nonce'],16)==row['nonce']
                 and str(tx.get('to','')).lower()==row['to'].lower()
                 and int(tx['value'],16)==int(row['valueWei'])
                 and re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',tx.get('input',''))
                 and sha(bytes.fromhex(tx['input'][2:]))==row['inputSha256'],
                 'External transaction differs from the acknowledged payload.')
            need(receipt['transactionHash'].lower()==row['txHash'].lower()
                 and int(receipt['status'],16)==row['status']
                 and int(receipt['blockNumber'],16)==row['blockNumber']<=final_number
                 and int(tx['blockNumber'],16)==row['blockNumber']
                 and int(header['number'],16)==row['blockNumber']
                 and tx['blockHash'].lower()==receipt['blockHash'].lower()==header['hash'].lower()==row['blockHash'].lower(),
                 'External transaction lacks its acknowledged canonical finalized receipt.')
        all_nonces=[row['nonce'] for row in journals]+[row['nonce'] for row in external]
        need(sorted(all_nonces)==list(range(latest)),
             'Worker and external evidence must cover every nonce exactly once.')
        migration={'schemaVersion':1,'kind':'external-finalized-migration-evidence','chainId':56,
            'gasWallet':GAS,'expectedCutoverNonce':plan['expectedCutoverNonce'],
            'acknowledgement':'Explicitly disclosed external transactions approved for nonce migration; not worker execution.',
            'userAcknowledgment':plan['externalMigrationAcknowledgement'],
            'transactions':sorted(external,key=lambda row:row['nonce']),
            'finalizedBlockNumber':final_number,'finalizedBlockHash':finalized['hash'],
            'originalJournalSha256':hashes,'originalWalletPointerSha256':pointer_hashes}
        digest=sha(evidence_bytes(migration))
        for row in external:
            # 6a's root-reviewed drain validator calls this compatibility field
            # journalSha256. Here it hashes the clearly typed independent chain
            # evidence, not a fabricated worker journal or business completion.
            journals.append({'evidenceKind':'external-finalized-migration-evidence',
                'evidencePath':str(EXTERNAL_EVIDENCE),'evidenceSha256':digest,
                'journalSha256':digest,'journalSha256Meaning':'independent-migration-evidence-bytes',
                'phase':'confirmed' if row['status']==1 else 'reverted',
                'nonce':row['nonce'],'txHash':row['txHash'],
                'blockNumber':row['blockNumber'],'blockHash':row['blockHash']})
        journals.sort(key=lambda row:row['nonce'])
    else:
        need(highest+1==latest,'Ledger does not cover the latest consumed Gas nonce.')
    # Re-read consumed nonces after receipt checks, without ever reserving a nonce.
    need(int(rpc('eth_getTransactionCount',[GAS,'latest']),16)==latest
         and int(rpc('eth_getTransactionCount',[GAS,'pending']),16)==pending,'Gas nonce changed during reconciliation.')
    need(rpc('eth_getBlockByNumber',[hex(final_number),False])['hash'].lower()==finalized['hash'].lower(),'Finalized history changed.')
    for path,digest in hashes.items():need(sha(Path(path).read_bytes())==digest,'Journal changed during reconciliation.')
    for path,digest in pointer_hashes.items():need(sha(Path(path).read_bytes())==digest,'Wallet pointer changed during reconciliation.')
    result={'journals':journals,'cutoverNonce':latest,'latestNonce':latest,'pendingNonce':pending,
            'finalizedNonce':final_nonce,'finalizedBlockNumber':final_number,'finalizedBlockHash':finalized['hash'],
            'journalPaths':hashes,'walletPointers':pointers}
    if migration:
        result.update(externalMigrationEvidence=migration,externalMigrationEvidenceSha256=sha(evidence_bytes(migration)),
                      externalMigrationEvidencePath=str(EXTERNAL_EVIDENCE),externalEvidenceWritten=False)
    return result


def write_root_evidence(path,raw):
    parent=path.parent
    need(parent.is_dir() and parent.resolve()==parent and parent.stat().st_uid==0
         and stat.S_IMODE(parent.stat().st_mode)&0o022==0,'Proof directory must be root owned and not writable by other users.')
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640)
    with os.fdopen(fd,'wb') as f:
        os.fchown(f.fileno(),0,grp.getgrnam('pinkuang-v4-relay').gr_gid)
        os.fchmod(f.fileno(),0o640)
        f.write(raw);f.flush();os.fsync(f.fileno())


def execute(plan,mode):
    need(os.geteuid()==0,'Root is required for protected service inspection.')
    before=verify_units(plan)
    result={'schemaVersion':1,'kind':'bemine-v4-legacy-gas-drain','chainId':56,'gasWallet':GAS,
            'checkedAtMs':int(time.time()*1000),'units':[x['unit'] for x in plan['senders']],
            'before':before,'mode':mode,'hostScopeOnly':True}
    if mode=='inspect':
        result['activeSendProcesses']=sender_processes();result.update(reconcile(plan,rpc_client(plan)))
        result['proofWritten']=False;return result
    need(not PROOF.exists() and not PROOF.is_symlink(),'Drain proof already exists; never overwrite it.')
    if external_transactions(plan):
        need(not EXTERNAL_EVIDENCE.exists() and not EXTERNAL_EVIDENCE.is_symlink(),
             'External migration evidence already exists; never overwrite it.')
    if mode=='stop-and-attest':
        for item in plan['senders']:
            run(['systemctl','disable',item['unit']])
            run(['systemctl','stop',item['unit']],timeout=90)
    result['stopped']=verify_units(plan,stopped=True)
    need(not sender_processes(),'Another purchase/mining/Authority sender is still active.')
    result.update(reconcile(plan,rpc_client(plan)))
    result['stopped']=verify_units(plan,stopped=True)
    need(not sender_processes(),'A sender appeared during reconciliation.')
    result['pendingClear']=True
    if result.get('externalMigrationEvidence'):
        raw=evidence_bytes(result['externalMigrationEvidence'])
        need(sha(raw)==result['externalMigrationEvidenceSha256'],'External evidence digest differs.')
        write_root_evidence(EXTERNAL_EVIDENCE,raw)
        result['externalEvidenceWritten']=True
    write_root_evidence(PROOF,(json.dumps(result,indent=2)+'\n').encode())
    result['proofWritten']=True;result['proofSha256']=sha(PROOF.read_bytes())
    return result


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--plan',required=True);ap.add_argument('--plan-sha256',required=True)
    choices=ap.add_mutually_exclusive_group(required=True)
    for mode in ['inspect','stop-and-attest','attest-stopped']:choices.add_argument('--'+mode,action='store_true')
    a=ap.parse_args();raw=Path(a.plan).read_bytes();need(sha(raw)==a.plan_sha256,'Pinned plan differs.')
    mode='stop-and-attest' if a.stop_and_attest else 'attest-stopped' if a.attest_stopped else 'inspect'
    with open('/run/bemine-v4-drain.lock','a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        print(json.dumps(execute(parse_plan(raw),mode),indent=2))
