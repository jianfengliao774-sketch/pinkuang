import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interface, keccak256, type JsonRpcProvider } from 'ethers';
import { inspectPauseTargets, pauseCreationData } from './upgrade-pause';
import type { DeploymentManifest } from './manifest';

const address = (n: number) => `0x${n.toString(16).padStart(40,'0')}`;
const code = '0x60016000';
const abi = new Interface([
  'function owner() view returns(address)',
  'function timelock() view returns(address)',
  'function creationPaused() view returns(bool)',
  'function pauseCreation(bool)',
]);
const manifest = {factory:address(1),portfolioFactory:address(2),timelock:address(3),
  codehash:{factory:keccak256(code),portfolioFactory:keccak256(code)}} as unknown as DeploymentManifest;

function fake(options: {wrongCode?: boolean; wrongOwner?: boolean; corePaused?: boolean} = {}) {
  const reads: Array<{to:string;data:string;tag:string}> = [];
  const provider = {
    async getBlock(tag: number | string) {
      assert.ok(tag === 'finalized' || tag === 123);
      return {number:123,hash:`0x${'a'.repeat(64)}`};
    },
    async getCode(target: string,block: number) {
      assert.equal(block,123);
      return options.wrongCode && target.toLowerCase() === address(1).toLowerCase() ? '0x6002' : code;
    },
    async send(method: string, params: unknown[]) {
      if (method === 'eth_chainId') return '0x38';
      assert.equal(method,'eth_call');
      const [tx,tag] = params as [{to:string;data:string},string];
      reads.push({...tx,tag});
      assert.equal(tag,'0x7b');
      const parsed = abi.parseTransaction(tx);
      if (parsed?.name === 'owner') return abi.encodeFunctionResult('owner',[
        options.wrongOwner ? address(9) : address(4),
      ]);
      if (parsed?.name === 'timelock') return abi.encodeFunctionResult('timelock',[address(3)]);
      if (parsed?.name === 'creationPaused') return abi.encodeFunctionResult('creationPaused',[
        tx.to.toLowerCase() === address(1).toLowerCase() ? options.corePaused ?? false : true,
      ]);
      throw new Error('unexpected call');
    },
  } as unknown as JsonRpcProvider;
  return {provider,reads};
}

test('pause calldata only requests true and finalized trusted factory proxies are pinned', async () => {
  const parsed = abi.parseTransaction({data:pauseCreationData(),value:0n});
  assert.equal(parsed?.name,'pauseCreation');
  assert.equal(parsed?.args[0],true);
  const {provider,reads} = fake();
  const proof = await inspectPauseTargets(provider,manifest,address(4));
  assert.equal(proof.targets.factory.paused,false);
  assert.equal(proof.targets.portfolioFactory.paused,true);
  assert.equal(proof.targets.factory.owner,address(4));
  assert.equal(proof.blockNumber,123);
  assert.equal(reads.length,6);
});

test('pause preflight rejects changed code or owner before a wallet can sign', async () => {
  await assert.rejects(() => inspectPauseTargets(fake({wrongCode:true}).provider,manifest,address(4)),/运行代码/);
  await assert.rejects(() => inspectPauseTargets(fake({wrongOwner:true}).provider,manifest,address(4)),/owner/);
});
