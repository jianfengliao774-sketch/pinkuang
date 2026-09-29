import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { authorityIpcConfiguration, createAuthorityAssertionVerifier, createAuthorityRelayProxy,
  createAuthoritySignerServer, listenAuthoritySigner, signAuthorityAssertion } from './authority-ipc.mjs';
import { startAuthoritySigner } from './authority-signer.mjs';

const origin='https://example.test';
const token='a'.repeat(43);

test('independent signer cannot start without explicit activation',async()=>{
  await assert.rejects(startAuthoritySigner({}),/disabled/);
  await assert.rejects(startAuthoritySigner({AUTHORITY_RELAY_ENABLED:'1',
    AUTHORITY_RELAY_SOCKET:'/tmp/unreviewed.sock'}),/unreviewed socket/);
});

test('public relay configuration rejects a Gas credential and any unreviewed IPC target',()=>{
  const root=mkdtempSync(join(tmpdir(),'authority-ipc-credentials-'));
  const env={AUTHORITY_RELAY_SOCKET:'/run/pinkuang-v4-relay/authority.sock',
    AUTHORITY_RELAY_ENABLED:'0',DEPLOYMENT_JOURNAL_ORIGIN:origin,
    DEPLOYMENT_JOURNAL_DB:join(root,'sessions.sqlite'),CREDENTIALS_DIRECTORY:root};
  try {
    writeFileSync(join(root,'authority-ipc-hmac'),randomBytes(32));
    assert.equal(authorityIpcConfiguration(env).key.length,32);
    assert.throws(()=>authorityIpcConfiguration({...env,AUTHORITY_RELAY_SOCKET:'/tmp/evil.sock'}),
      /reviewed local relay socket/);
    writeFileSync(join(root,'keeper-private-key'),'secret');
    assert.throws(()=>authorityIpcConfiguration(env),/must not receive a Gas private key/);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('authority assertion binds exact method, path, body, account, time and single use',()=>{
  const key=randomBytes(32), account=Wallet.createRandom().address;
  const body=Buffer.from('{"command":{}}');
  const verifier=createAuthorityAssertionVerifier(key,()=>10_500);
  const assertion=signAuthorityAssertion(key,{account,method:'POST',
    path:'/api/journal/authority-relay',body,now:10_000});
  assert.throws(()=>verifier(assertion,{method:'GET',url:'/api/journal/authority-relay'},body),
    /stale or mismatched/);
  assert.throws(()=>verifier(assertion,{method:'POST',url:'/api/journal/authority-relay'},Buffer.from('{}')),
    /stale or mismatched/);
  assert.equal(verifier(assertion,{method:'POST',url:'/api/journal/authority-relay'},body),account);
  assert.throws(()=>verifier(assertion,{method:'POST',url:'/api/journal/authority-relay'},body),/reused/);
  assert.throws(()=>createAuthorityAssertionVerifier(key,()=>26_000)(assertion,
    {method:'POST',url:'/api/journal/authority-relay'},body),/stale or mismatched/);
  assert.throws(()=>createAuthorityAssertionVerifier(randomBytes(32),()=>10_500)(assertion,
    {method:'POST',url:'/api/journal/authority-relay'},body),/invalid/);
});

test('local signer proxy accepts only authenticated exact paths, 0750 directory and 0660 socket',async()=>{
  const root=mkdtempSync(join(tmpdir(),'authority-ipc-test-'));
  chmodSync(root,0o750);
  const socketPath=join(root,'authority.sock'), account=Wallet.createRandom().address;
  const key=randomBytes(32), seen=[];
  const service={handle:async(req,res)=>{
    const body=[]; for await (const part of req) body.push(part);
    seen.push({path:req.url,method:req.method,account:req.authorityIpcAccount,
      body:Buffer.concat(body).toString()});
    res.statusCode=200;res.end(JSON.stringify({status:'idle'}));
  }};
  const signer=createAuthoritySignerServer(service,key);
  await listenAuthoritySigner(signer,socketPath,{allowTestPath:true});
  const proxy=createAuthorityRelayProxy({socketPath,origin,key},{store:{session:()=>account,close(){}}});
  const frontend=createServer((req,res)=>{void proxy.handle(req,res);});
  await new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${frontend.address().port}`;
  const headers={cookie:`pinkuang_journal=${token}`,'x-pinkuang-account':account,origin};
  try {
    assert.equal(statSync(socketPath).mode & 0o777,0o660);
    const ok=await fetch(`${url}/api/journal/authority-relay`,{method:'POST',headers:{...headers,
      'content-type':'application/json'},body:'{"command":{}}'});
    assert.equal(ok.status,200);
    assert.deepEqual(await ok.json(),{status:'idle'});
    assert.deepEqual(seen,[{path:'/api/journal/authority-relay',method:'POST',account,
      body:'{"command":{}}'}]);
    assert.equal((await fetch(`${url}/api/journal/authority-relay/other`,{headers})).status,404);
    assert.equal((await fetch(`${url}/api/journal/authority-relay`,{method:'POST',
      headers:{...headers,origin:'https://evil.test','content-type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(`${url}/api/journal/authority-relay/status`,{
      headers:{...headers,'x-pinkuang-account':Wallet.createRandom().address}})).status,409);
    assert.equal((await fetch(`${url}/api/journal/authority-relay`,{method:'POST',
      headers:{...headers,'content-type':'application/json'},body:'x'.repeat(65_537)})).status,413);
    assert.equal(seen.length,1);
  } finally {
    await new Promise(resolve=>frontend.close(resolve));
    await new Promise(resolve=>signer.close(resolve));
    proxy.close();rmSync(root,{recursive:true,force:true});
  }
});

test('unresponsive local signer times out without exposing an arbitrary HTTP target',async()=>{
  const root=mkdtempSync(join(tmpdir(),'authority-ipc-timeout-'));
  chmodSync(root,0o750);
  const socketPath=join(root,'authority.sock'), account=Wallet.createRandom().address;
  const signer=createServer((_req,_res)=>{});
  await listenAuthoritySigner(signer,socketPath,{allowTestPath:true});
  const proxy=createAuthorityRelayProxy({socketPath,origin,key:randomBytes(32)},
    {store:{session:()=>account,close(){}},timeoutMs:25});
  const frontend=createServer((req,res)=>{void proxy.handle(req,res);});
  await new Promise(resolve=>frontend.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${frontend.address().port}/api/journal/authority-relay/status`,
      {headers:{cookie:`pinkuang_journal=${token}`,'x-pinkuang-account':account,origin}});
    assert.equal(response.status,503);
    assert.match((await response.json()).error,/unavailable/);
  } finally {
    await new Promise(resolve=>frontend.close(resolve));
    signer.closeAllConnections();
    await new Promise(resolve=>signer.close(resolve));
    proxy.close();rmSync(root,{recursive:true,force:true});
  }
});
