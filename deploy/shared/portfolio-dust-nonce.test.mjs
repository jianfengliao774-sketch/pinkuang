import test from 'node:test';
import assert from 'node:assert/strict';
import {readPortfolioDustNonce} from './portfolio-dust-nonce.mjs';
const account=`0x${'11'.repeat(20)}`,h=`0x${'ab'.repeat(32)}`;
const q=n=>`0x${n.toString(16)}`;
function fixture(rounds) {
  let round=-1;const calls=[];
  const rpc=async(method,params)=>{calls.push(['rpc',method,...params]);
    if(method==='eth_getBlockByNumber') {if(params[0]==='latest') round++;
      return {number:q(100+round),hash:params[0]!=='latest'&&rounds[round].reorg?`0x${'cd'.repeat(32)}`:h};}
    return rounds[round][params[1]==='pending'?'pending':'confirmed'];};
  const wallet={request:async({method,params})=>{calls.push(['wallet',method,...params]);return rounds[round][params[1]==='pending'?'wp':'wl'];}};
  return {rpc,wallet,account,calls};
}
const row=(c,p=c,wl=c,wp=p)=>({confirmed:q(c),pending:q(p),wl:q(wl),wp:q(wp)});
test('healthy confirmed nonce is block-pinned and accepted without retry',async()=>{
  const f=fixture([row(170)]),r=await readPortfolioDustNonce(f);
  assert.equal(r.nonce,'170');assert.equal(r.attempt,1);
  assert.equal(f.calls.filter(x=>x[1]==='eth_getBlockByNumber').length,2);
  assert.deepEqual(f.calls.find(x=>x[0]==='rpc'&&x[1]==='eth_getTransactionCount'),['rpc','eth_getTransactionCount',account,'0x64']);
});
test('wallet latest/pending behind the independent canonical nonce does not falsely block',async()=>{
  assert.equal((await readPortfolioDustNonce(fixture([row(170,170,169,169)]))).nonce,'170');
  assert.equal((await readPortfolioDustNonce(fixture([row(170,170,170,169)]))).nonce,'170');
});
test('old latest/new pending after mining is resolved by fresh block proof',async()=>{
  const r=await readPortfolioDustNonce(fixture([row(169,170,169,170),row(170)]));
  assert.equal(r.nonce,'170');assert.equal(r.attempt,2);
});
test('a wallet view leading the independent node must wait until independent proof catches up',async()=>{
  const r=await readPortfolioDustNonce(fixture([row(169,169,170,170),row(170)]));assert.equal(r.attempt,2);
  const f=fixture([row(169,169,170,170),row(169,169,170,170),row(169,169,170,170)]);
  await assert.rejects(readPortfolioDustNonce(f),e=>e.code==='SYNC');
});
test('actual persistent independent pending nonce does not advance or skip nonce',async()=>{
  const f=fixture([row(170,171),row(170,171),row(170,171)]);
  await assert.rejects(readPortfolioDustNonce(f),e=>e.code==='PENDING'&&e.observation.confirmed==='170');
  assert.equal(f.calls.filter(x=>x[1]==='eth_getBlockByNumber'&&x[2]==='latest').length,3);
});
test('a pending read behind confirmed is a sync condition, not an outstanding transaction',async()=>{
  await assert.rejects(readPortfolioDustNonce(fixture([row(170,169),row(170,169),row(170,169)])),e=>e.code==='SYNC');
});
test('confirmed journal nonce cannot be reused even when all current reads match',async()=>{
  const f=fixture([row(170),row(170),row(170)]);
  await assert.rejects(readPortfolioDustNonce({...f,transactions:{deploy:{status:'confirmed',nonce:'170'}}}),e=>e.code==='SYNC');
  assert.equal((await readPortfolioDustNonce({...fixture([row(171)]),transactions:{deploy:{status:'confirmed',nonce:'170'}}})).nonce,'171');
});
test('confirmed nonce floor belongs to the actual signing account',async()=>{
  const transactions={deploy:{status:'confirmed',from:`0x${'22'.repeat(20)}`,nonce:'180'}};
  assert.equal((await readPortfolioDustNonce({...fixture([row(170)]),transactions})).nonce,'170');
});
test('uncertain/submitted intents require original receipt recovery before any nonce reads',async()=>{
  for(const status of ['uncertain','submitted']) {const f=fixture([row(170)]);
    await assert.rejects(readPortfolioDustNonce({...f,transactions:{deploy:{status,nonce:'170'}}}),e=>e.code==='ORIGINAL');
    assert.equal(f.calls.length,0);}
});
test('malformed responses are separate from pending and never produce a nonce',async()=>{
  for(const value of [170,null,'170','0x00aa','0xzz','0x20000000000000']) {
    const r=row(170);r.wp=value;await assert.rejects(readPortfolioDustNonce(fixture([r])),e=>e.code==='INVALID');}
});
test('reorg during read fails closed and RPC transport errors are not pending claims',async()=>{
  await assert.rejects(readPortfolioDustNonce(fixture([{...row(170),reorg:true}])),e=>e.code==='REORG');
  await assert.rejects(readPortfolioDustNonce({...fixture([row(170)]),rpc:async()=>{throw new Error('transport');}}),/transport/);
});
