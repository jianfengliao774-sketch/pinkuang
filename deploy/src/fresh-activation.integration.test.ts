import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('local 16+7 fresh deployment transfers both Factory owners to the 48h Timelock',
  { timeout: 180_000 }, async () => {
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
        if(method==='eth_sendTransaction') stage1Sends.push((params as Record<string,unknown>[])[0]);
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
      const journal={
        loadFreshActivation:async()=>saved ? structuredClone(saved):null,
        saveFreshActivation:async(record:FreshActivationRecord)=>{saved=structuredClone(record);},
        freshActivationCredentialStatus:async()=>({credentialVerified:true,gasWallet}),
        readCurrentNonce:async()=>({latest:Number(await rpc('eth_getTransactionCount',[account,'latest'])),
          pending:Number(await rpc('eth_getTransactionCount',[account,'pending']))}),
        assertCurrentArtifact:async(digest:string)=>assert.equal(digest,artifactDigest(bundle)),
      } as unknown as ServerJournal;
      const activation=new FreshActivationEngine(wallet,bundle,journal,complete);
      let state=await activation.prepare('0.2','10',gasWallet);
      for(let index=0;index<7;index++){
        state=await activation.sendNext(state);
        assert.equal(state.steps[index].status,'submitted');
        await rpc('anvil_mine',['0x80']);
        state=await activation.reconcile(state);
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
      for(const factory of [complete.addresses.factory,complete.addresses.portfolioFactory]){
        const contract=new Contract(factory,bundle.artifacts.PoolFactory.abi,provider);
        assert.equal(getAddress(await contract.owner()),complete.addresses.timelock);
        assert.equal(getAddress(await contract.operator()),state.authorityAddress);
        assert.equal(getAddress(await contract.treasury()),state.authorityAddress);
      }
    } finally {processHandle.kill('SIGTERM');}
  });
