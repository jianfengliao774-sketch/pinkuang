import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Wallet } from 'ethers';
import { createJournalService } from './journal-api.mjs';

async function fixture(notificationService) {
  const dir = await mkdtemp(join(tmpdir(), 'bemine-notification-http-'));
  const origin = 'http://localhost:3108';
  const service = createJournalService({ dbPath:join(dir,'private','journal.sqlite'), origin,
    currentArtifactDigest:()=>`0x${'a'.repeat(64)}`, notificationService });
  const server = createServer(service.handle);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/journal`;
  async function request(path, {method='GET',body,headers={}}={}) {
    const response = await fetch(base+path,{method,headers:{ ...(body?{'Content-Type':'application/json'}:{}),...headers},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(wallet) {
    const account=wallet.address.toLowerCase();
    const challenge=await request('/challenge',{method:'POST',body:{account},headers:{Origin:origin}});
    const signed=await request('/session',{method:'POST',body:{account,nonce:challenge.body.nonce,
      signature:await wallet.signMessage(challenge.body.message)},headers:{Origin:origin}});
    assert.equal(signed.status,200);return {'Cookie':signed.cookie,'X-Pinkuang-Account':account,Origin:origin};
  }
  return {request,login,origin,close:async()=>{await new Promise(resolve=>server.close(resolve));await service.close();await rm(dir,{recursive:true,force:true});}};
}

test('unconfigured notifications expose capability without creating a wallet signature requirement',async()=>{
  const f=await fixture();try{
    assert.deepEqual((await f.request('/notifications/capabilities')).body,{enabled:false,botUsername:'BEMineNotifyBot'});
    assert.equal((await f.request('/notifications/status')).status,401);
    const headers=await f.login(Wallet.createRandom());
    assert.equal((await f.request('/notifications/status',{headers})).status,503);
    assert.equal((await f.request('/session',{headers})).status,200);
  }finally{await f.close();}
});

test('notification operations inherit signed wallet identity, selected-account and Origin checks',async()=>{
  const calls=[];
  const f=await fixture({capabilities:()=>({enabled:true,botUsername:'BEMineNotifyBot'}),
    handleWallet:async input=>{calls.push(input);return {status:200,body:{connected:false,account:input.account}};}});
  try{
    const owner=Wallet.createRandom(),other=Wallet.createRandom(),headers=await f.login(owner);
    const valid=await f.request('/notifications/binding',{method:'POST',body:{language:'en'},headers});
    assert.equal(valid.status,200);assert.equal(calls[0].account,owner.address.toLowerCase());
    assert.equal(calls[0].path,'/binding');
    assert.equal((await f.request('/notifications/binding',{method:'POST',body:{},headers:{...headers,Origin:'https://attacker.invalid'}})).status,403);
    assert.equal((await f.request('/notifications/status',{headers:{...headers,'X-Pinkuang-Account':other.address}})).status,409);
    const {['X-Pinkuang-Account']:ignored,...withoutAccount}=headers;
    assert.equal((await f.request('/notifications/status',{headers:withoutAccount})).status,400);
    assert.equal(calls.length,1);
  }finally{await f.close();}
});

test('only exact authenticated Telegram webhook bypasses browser Origin, never wallet endpoints',async()=>{
  const updates=[];
  const f=await fixture({acceptsWebhook:value=>value==='fixture-webhook-secret',handleTelegramUpdate:async value=>updates.push(value)});
  try{
    const path='/notifications/telegram/webhook',body={update_id:1};
    assert.equal((await f.request(path,{method:'POST',body})).status,403);
    assert.equal((await f.request(path,{method:'POST',body,headers:{'X-Telegram-Bot-Api-Secret-Token':'wrong'}})).status,403);
    assert.equal((await f.request(path,{method:'POST',body,headers:{'X-Telegram-Bot-Api-Secret-Token':'fixture-webhook-secret'}})).status,200);
    assert.equal((await f.request(path)).status,405);
    assert.equal((await f.request('/notifications/binding',{method:'POST',body,headers:{'X-Telegram-Bot-Api-Secret-Token':'fixture-webhook-secret'}})).status,403);
    assert.deepEqual(updates,[body]);
  }finally{await f.close();}
});
