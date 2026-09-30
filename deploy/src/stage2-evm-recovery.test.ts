import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
// @ts-expect-error Production server modules are exercised directly by the Node EVM test.
import { JournalStore } from '../server/journal-store.mjs';
// @ts-expect-error Production server modules are exercised directly by the Node EVM test.
import { validateFreshActivation, verifyFinalizedFreshAttempt, verifyRecoveredFreshSigning, verifyConfirmedFreshActivation } from '../server/fresh-activation-journal.mjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserProvider, Contract, Interface, getAddress } from 'ethers';
import { DeploymentEngine, PROTOCOL_ADDRESSES, artifactDigest,
  type ArtifactBundle, type DeploymentSnapshot, type Eip1193Provider } from './deployment';
import { FreshActivationEngine, activationEvidence, activatedDeploymentManifest,
  type FreshActivationRecord } from './fresh-activation';
import type { ServerJournal } from './server-journal';
import { deploymentManifest } from './manifest';
// @ts-expect-error The pinned compiler script is loaded directly by the Node test.
import { artifactContentDigest, compileDeploymentArtifacts } from '../scripts/build-artifacts.mjs';

const bundle: ArtifactBundle = JSON.parse(await readFile(new URL('../public/deployment-artifacts.json', import.meta.url), 'utf8'));
(globalThis as unknown as Record<string, unknown>).__DEPLOYMENT_ARTIFACT_DIGEST__ =
  artifactContentDigest(compileDeploymentArtifacts());

test('disposable delegated EOA direct 16+7 graph; real failed steps 3/7 recover at new nonce using server proof and SQLite history',
  { timeout: 240_000 }, async () => {
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const url = `http://127.0.0.1:${port}`;
    const anvilPath = process.platform === 'win32' ? '../node_modules/@foundry-rs/anvil-win32-amd64/bin/anvil.exe'
      : '../node_modules/.bin/anvil';
    const processHandle = spawn(fileURLToPath(new URL(anvilPath, import.meta.url)),
      ['--host','127.0.0.1','--port',String(port),'--chain-id','56','--block-time','1','--silent'],
      { stdio: 'ignore', windowsHide: true });
    let rpcId = 0;
    async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
      const response = await fetch(url, {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params})});
      const result=await response.json() as {result?:unknown;error?:{message:string}};
      if(result.error) throw new Error(result.error.message);
      return result.result;
    }
    try {
      let ready=false;
      for(let i=0;i<50;i++){try{await rpc('eth_chainId');ready=true;break;}catch{await delay(100);}}
      assert(ready,'disposable Anvil did not start');
      const account=getAddress((await rpc('eth_accounts') as string[])[0]);
      const gasWallet=getAddress((await rpc('eth_accounts') as string[])[1]);
      const fixture=JSON.parse(await readFile(new URL('./fixtures/fresh-delegation-runtime.json',import.meta.url),'utf8'));
      const delegate=getAddress(fixture.codes.delegator.address);
      for(const item of Object.values(fixture.codes) as {address:string;code:string}[])await rpc('anvil_setCode',[item.address,item.code]);
      await rpc('anvil_setCode',[account,`0xef0100${delegate.slice(2)}`]);
      await rpc('anvil_setNonce',[account,'0x53']);
      assert.equal(await rpc('eth_getCode',[account,'latest']),`0xef0100${delegate.slice(2)}`.toLowerCase());
      const failureEvidence: Record<string,unknown>[]=[];
      let injectLowGas=false;
      const initializerSelector=new Interface(bundle.artifacts.AtomicDeployment.abi)
        .getFunction('deployIntegratedSingleOwner')!.selector;
      const stage1Sends:Record<string,unknown>[]=[];
      let createSimulations=0;
      let initializerSimulationCalls=0;
      const wallet:Eip1193Provider={request:({method,params})=>{
        if(method==='eth_estimateGas') createSimulations++;
        if(method==='eth_call'){
          const call=(params as Record<string,string>[] | undefined)?.[0];
          if(call?.data?.startsWith(initializerSelector)) initializerSimulationCalls++;
        }
        if(method==='eth_sendTransaction') {
          stage1Sends.push((params as Record<string,unknown>[])[0]);
          if(injectLowGas) { injectLowGas=false; return rpc(method,[{...(params as Record<string,unknown>[])[0],gas:'0x59d8'}]); }
        }
        return rpc(method,params as unknown[] | undefined);
      }};
      for(const address of Object.values(PROTOCOL_ADDRESSES)) await rpc('anvil_setCode',[address,'0x00']);
      let savedGenesisId='';
      const first=new DeploymentEngine(wallet,bundle,{persist:record=>{savedGenesisId=structuredClone(record).id;}});
      const complete=await first.start({governanceMode:'single',ownerMultisig:account,operator:account,treasury:account,
        maxGasBudgetBnb:'0.1',gasPriceCapGwei:'10',governanceReviewed:true,protocolReviewed:true});
      assert.equal(complete.status,'complete');
      assert.deepEqual(complete.steps.map(step=>step.id).includes('FreshPoolFactory'),true);
      assert.equal(complete.steps.length,16);
      assert.equal(createSimulations,0,'the reviewed fresh CREATEs must not request app-level Gas simulations');
      assert.equal(stage1Sends.length,complete.steps.length);
      assert.equal(initializerSimulationCalls,0,'the initializer must not request an app-level simulation');
      for (const [index,step] of complete.steps.entries()) {
        assert(step.receipt && step.gasLimit);
        assert(BigInt(step.receipt.gasUsed) <= BigInt(step.gasLimit), `${step.id} exceeds its reviewed gas limit`);
        assert.equal(BigInt(String(stage1Sends[index].gas ?? '0')),BigInt(step.gasLimit),
          `${step.id} wallet transaction must retain its reviewed fixed Gas limit`);
        assert.equal(step.gasEstimate,undefined,`${step.id} uses its reviewed fixed Gas limit without simulation`);
      }
      assert.equal(savedGenesisId,complete.id);
      // Anvil's finalized tag trails latest by many blocks. Advance the disposable
      // chain so the production manifest verifier can require real finality.
      await rpc('anvil_mine',['0x80']);
      let saved:FreshActivationRecord | null=null;
      // The private filesystem ACL constructor cannot run on Windows. Use an
      // isolated in-memory SQLite database with the unmodified production
      // JournalStore transaction/put/recovery methods; Linux separately tests
      // the real filesystem constructor and HTTP API.
      const sqliteStore=Object.create(JournalStore.prototype);
      sqliteStore.db=new DatabaseSync(':memory:');
      sqliteStore.db.exec('CREATE TABLE fresh_activation(account TEXT PRIMARY KEY,revision INTEGER NOT NULL,record TEXT); CREATE TABLE market(account TEXT PRIMARY KEY,revision INTEGER NOT NULL,record TEXT)');
      const serverProvider=new BrowserProvider(wallet,'any',{cacheTimeout:-1});
      let revision=0;
      const journal={
        loadFreshActivation:async()=>{const current=sqliteStore.freshActivation(account);revision=current.revision;saved=current.record;return saved?structuredClone(saved):null;},
        saveFreshActivation:async(record:FreshActivationRecord)=>{
          validateFreshActivation(record,account,complete,gasWallet);
          const previous=sqliteStore.freshActivation(account).record;
          const newSigning=record.steps.some((step,index)=>step.status==='signing'&&previous?.steps[index]?.status!=='signing');
          if(newSigning&&record.steps.some(step=>step.attempts?.length)) await verifyRecoveredFreshSigning(serverProvider,previous,complete,account,bundle);
          await verifyConfirmedFreshActivation(serverProvider,record,previous,complete,account,bundle);
          revision=sqliteStore.putFreshActivation(account,record,revision);saved=structuredClone(record);
        },
        recoverFinalizedFreshAttempt:async(stepId:string,nonce:number,winnerHash:string)=>{
          const current=sqliteStore.freshActivation(account);
          validateFreshActivation(current.record,account,complete,gasWallet);
          const proof=await verifyFinalizedFreshAttempt(serverProvider,current.record,complete,account,stepId,nonce,winnerHash,bundle);
          const result=sqliteStore.recoverFinalizedFreshAttempt(account,revision,proof);
          assert.throws(()=>sqliteStore.recoverFinalizedFreshAttempt(account,revision,proof),/revision/);
          revision=result.revision;saved=result.record;return structuredClone(saved);
        },
        freshActivationCredentialStatus:async()=>({credentialVerified:true,gasWallet}),
        readCurrentNonce:async()=>({latest:Number(await rpc('eth_getTransactionCount',[account,'latest'])),
          pending:Number(await rpc('eth_getTransactionCount',[account,'pending']))}),
        assertCurrentArtifact:async(digest:string)=>assert.equal(digest,artifactDigest(bundle)),
      } as unknown as ServerJournal;
      const activation=new FreshActivationEngine(wallet,bundle,journal,complete);
      let state=await activation.prepare('0.2','10',gasWallet);
      for(let index=0;index<7;index++){
        const failHere=index===2||index===6;
        if(failHere) injectLowGas=true;
        const beforeSend: number=stage1Sends.length;
        state=await activation.sendNext(state);
        assert.equal(state.steps[index].status,'submitted');
        if(failHere){
          const preFinality=await activation.reconcile(state);
          assert.equal(preFinality.steps[index].status,'submitted','unfinalized failed result must stay unresolved');
        }
        await rpc('anvil_mine',['0x80']);
        state=await activation.reconcile(state);
        if(failHere){
          assert.equal(state.status,'aborted');
          assert.equal(state.steps[index].status,'failed');
          assert.equal(state.steps[index].receipt?.status,0);
          const failed=structuredClone(state.steps[index]);
          const spent=state.spentWei;
          await assert.rejects(activation.sendNext(state),/终止/);
          assert.equal(stage1Sends.length,beforeSend+1,'failed receipt must not cause automatic resend');
          state=await activation.recoverFinalizedAttempt(state);
          assert.equal(state.steps[index].status,'waiting');
          assert.equal(state.spentWei,spent);
          assert.equal(state.steps[index].attempts?.length,1);
          assert.equal(stage1Sends.length,beforeSend+1,'recovery is read-only and cannot send');
          assert.equal(state.steps[index].attempts?.[0].receipt?.blockHash,failed.receipt?.blockHash);
          const tampered=structuredClone(state);tampered.steps[index].attempts=[];
          assert.throws(()=>sqliteStore.putFreshActivation(account,tampered,revision),/progress/);
          state=await activation.sendNext(state);
          assert.equal(state.steps[index].nonce,failed.nonce!+1);
          assert.equal(state.steps[index].dataHash,failed.dataHash);
          await rpc('anvil_mine',['0x80']);
          state=await activation.reconcile(state);
          failureEvidence.push({step:index+1,id:failed.id,failedNonce:failed.nonce,failedReceipt:failed.receipt,
            recoveredNonce:state.steps[index].nonce,recoveredReceipt:state.steps[index].receipt,
            immutableAttempts:state.steps[index].attempts?.length,feesRetained:true,noAutomaticResend:true});
        }
        assert.equal(state.steps[index].status,'confirmed');
      }
      assert.equal(state.status,'complete');
      const evidence=activationEvidence(state);
      assert.equal(evidence.steps.length,7);
      const staticManifest=await activation.verifiedManifest(state);
      assert.equal(staticManifest.verifiedBlockHash, evidence.steps.at(-1)?.blockHash);
      const expectedManifest=activatedDeploymentManifest(
        deploymentManifest(complete,bundle),evidence,staticManifest.freshAuthority.codehash);
      const {verifiedAt:actualVerifiedAt,...actualFields}=staticManifest;
      const {verifiedAt:_expectedVerifiedAt,...expectedFields}=expectedManifest;
      assert(Number.isFinite(Date.parse(actualVerifiedAt)));
      assert.deepEqual(actualFields,expectedFields);
      const provider=new BrowserProvider(wallet);
      assert.equal(stage1Sends.length,25,'16 initial + 7 intended authority + 2 explicit failure retries');
      assert(stage1Sends.every(tx=>tx.type==='0x2'&&tx.value==='0x0'));
      assert(stage1Sends.slice(0,15).every(tx=>tx.to==null),'all Stage 1 CREATEs remain top-level');
      const authorityCreate=stage1Sends[16];assert.equal(authorityCreate.to,undefined);
      assert.equal(await rpc('eth_getCode',[account,'latest']),`0xef0100${delegate.slice(2)}`.toLowerCase());
      await writeFile(process.env.STAGE2_EVM_EVIDENCE ?? join(tmpdir(),'stage2-evm-recovery.json'),JSON.stringify({sourceHead:'5a765de93a1f5465096ac0c9d37d5231ed223707',scope:'Disposable local Anvil chainId56, no fork/prod transactions; local test account delegation to official pinned runtime, mocked credential attestation; real contracts, direct type2, production server proof and in-memory SQLite JournalStore methods',artifactDigest:artifactDigest(bundle),createdAt:new Date().toISOString(),chainUrl:url,initialNonce:83,delegatedAccount:account,transactions:25,status:state.status,failures:failureEvidence,final:{core:complete.addresses.factory,budget:complete.addresses.portfolioFactory,authority:state.authorityAddress,timelock:complete.addresses.timelock}},null,2));
      sqliteStore.close();
      for(const factory of [complete.addresses.factory,complete.addresses.portfolioFactory]){
        const contract=new Contract(factory,bundle.artifacts.PoolFactory.abi,provider);
        assert.equal(getAddress(await contract.owner()),complete.addresses.timelock);
        assert.equal(getAddress(await contract.operator()),state.authorityAddress);
        assert.equal(getAddress(await contract.treasury()),state.authorityAddress);
      }
    } finally {processHandle.kill('SIGTERM');}
  });
