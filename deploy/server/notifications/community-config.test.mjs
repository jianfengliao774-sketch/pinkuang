import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMUNITY_DESTINATION, assertCommunityDestination, communityConfiguration, verifyCommunityDestination } from './community-config.mjs';
import { TelegramClient } from './telegram.mjs';

const community = {...COMMUNITY_DESTINATION,photoUrl:'https://example.test/bemine/images/poster.jpg'};
test('group configuration is opt-in and pinned to approved exact forum topic',()=>{
  assert.equal(communityConfiguration({},'https://example.test/'),null);
  const env={BEMINE_COMMUNITY_ENABLED:'1',BEMINE_COMMUNITY_CHAT_ID:community.chatId,
    BEMINE_COMMUNITY_THREAD_ID:'2',BEMINE_COMMUNITY_USERNAME:community.username};
  assert.equal(communityConfiguration(env,'https://example.test/bemine/').threadId,2);
  for (const change of [{chatId:'-1001'},{threadId:1},{threadId:null},{username:'OtherGroup'}])
    assert.throws(()=>assertCommunityDestination({...community,...change}));
  assert.throws(()=>communityConfiguration({...env,BEMINE_COMMUNITY_THREAD_ID:''},'https://example.test/'));
});
test('group identity verifies username, forum and actual bot membership, not a forwarded message',async()=>{
  const make=(changes={},memberChanges={})=>({request:async method=>method==='getChat'
    ? {id:Number(community.chatId),username:community.username,type:'supergroup',is_forum:true,
      permissions:{can_send_messages:true,can_send_photos:true},...changes}
    : {user:{id:42},status:'member',...memberChanges}});
  assert.equal(await verifyCommunityDestination(make(),community,42),true);
  for(const changes of [{id:-1001},{username:'Fake'},{is_forum:false},{permissions:{can_send_messages:true,can_send_photos:false}}])
    await assert.rejects(verifyCommunityDestination(make(changes),community,42));
  await assert.rejects(verifyCommunityDestination(make({},{status:'left'}),community,42));
  await assert.rejects(verifyCommunityDestination(make({},{user:{id:43}}),community,42));
});
function clientFixture(responseBody) {
  const calls=[];
  const client=new TelegramClient({token:`123456:${'A'.repeat(40)}`,fetchImpl:async(url,options)=>{
    calls.push({method:url.split('/').at(-1),body:JSON.parse(options.body)});
    return {ok:responseBody.ok,json:async()=>responseBody,status:responseBody.ok?200:400};
  }});
  return {client,calls};
}
const sent={message_id:10,message_thread_id:2,chat:{id:Number(community.chatId)}};
test('photo always includes explicit topic and validates returned destination; private sender remains private',async()=>{
  const {client,calls}=clientFixture({ok:true,result:sent});
  assert.throws(()=>client.sendMessage(community.chatId,'bad'),/private/);
  await assert.rejects(client.sendTopicPhoto({...community,threadId:1},{caption:'test'}));
  assert.equal(calls.length,0);
  assert.equal((await client.sendTopicPhoto(community,{caption:'test'})).message_id,10);
  assert.equal(calls[0].body.message_thread_id,2);
  assert.equal(calls[0].body.chat_id,community.chatId);
  const wrong=clientFixture({ok:true,result:{...sent,message_thread_id:1}}).client;
  await assert.rejects(wrong.sendTopicPhoto(community,{caption:'test'}),error=>error.retryable===false);
});
test('topic not found is permanent, never retried in general chat; group cooldown uses group rate',async()=>{
  const {client,calls}=clientFixture({ok:false,error_code:400,description:'Bad Request: message thread not found'});
  await assert.rejects(client.sendTopicPhoto(community,{caption:'test'}),error=>error.retryable===false);
  assert.equal(calls.length,1);assert.equal(calls[0].body.message_thread_id,2);
  await assert.rejects(client.sendTopicPhoto(community,{caption:'test'}),error=>error.retryAfterMs>2500&&error.rateLimitScope==='chat');
  assert.equal(calls.length,1);
});
test('edits target original exact chat/message; not-modified is idempotent success',async()=>{
  const {client,calls}=clientFixture({ok:false,error_code:400,description:'Bad Request: message is not modified'});
  assert.equal((await client.editTopicCaption(community,10,{caption:'same'})).unchanged,true);
  assert.equal(calls[0].body.message_id,10);assert.equal(calls[0].body.chat_id,community.chatId);
  const wrong=clientFixture({ok:true,result:{...sent,message_thread_id:1}}).client;
  await assert.rejects(wrong.editTopicCaption(community,10,{caption:'same'}),error=>error.retryable===false);
});
