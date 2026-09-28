import test from 'node:test';
import assert from 'node:assert/strict';
import {configureNotificationBot} from './configure-notification-bot.mjs';
test('bot setup verifies identity, localizes metadata and registers only scoped HTTPS webhook',async()=>{
 const calls=[],config={botUsername:'BEMineNotifyBot',publicBaseUrl:'https://example.org/bemine/',webhookSecret:'fixture-secret'};
 const client={request:async(method,body)=>{calls.push({method,body});return method==='getMe'?{is_bot:true,username:'BEMineNotifyBot'}:method==='getWebhookInfo'?{url:'https://example.org/bemine/api/journal/notifications/telegram/webhook',pending_update_count:0}:true;}};
 const result=await configureNotificationBot(config,client);assert.equal(result.username,'BEMineNotifyBot');
 assert.equal(calls.filter(x=>x.method==='setMyCommands').length,3);
 const hook=calls.find(x=>x.method==='setWebhook').body;assert.equal(hook.drop_pending_updates,false);assert.deepEqual(hook.allowed_updates,['message','callback_query']);
 const serialized=JSON.stringify(result);assert(!serialized.includes('fixture-secret'));
 for(const call of calls.filter(x=>x.method==='setMyDescription'))assert(call.body.description.length<=512);
 await assert.rejects(configureNotificationBot(config,{request:async()=>({is_bot:true,username:'wrong'})}),/identity/);
});
