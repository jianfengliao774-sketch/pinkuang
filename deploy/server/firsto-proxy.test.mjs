import test from 'node:test';
import assert from 'node:assert/strict';
import {upstreamUrl, proxyFirsto} from './firsto-proxy.mjs';

test('quote proxy pins the origin, read-only paths and official collections', () => {
  assert.equal(upstreamUrl('/firsto-api/v1/circuits?page=1&pageSize=20').searchParams.get('category'),'official_mining');
  assert.equal(upstreamUrl('/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/16480').origin,'https://api-tapeout.firsto.ai');
  for(const path of ['//evil.example/v1/circuits','/firsto-api/v1/order-request','/firsto-api/v1/circuits?account=0x123','/firsto-api/v1/circuits?category=other','/firsto-api/v1/circuits?pageSize=999999','/firsto-api/v1/circuit/0x0000000000000000000000000000000000000001/1','/firsto-api/v1/circuit/0xb1024b89886b9a34aa4ff5f31c411d708b20a14c/'+(2n**256n).toString()]) assert.throws(()=>upstreamUrl(path));
});
test('quote proxy rejects POST before any network call', async()=>{
  const response={statusCode:0,setHeader(){},end(body){this.body=body;}};
  await proxyFirsto({url:'/firsto-api/v1/circuits',method:'POST'},response);
  assert.equal(response.statusCode,405);
  assert.match(response.body,/只读/);
});
