import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,writeFileSync,chmodSync,symlinkSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationConfiguration } from './config.mjs';

test('notification activation requires private secrets, exact website and allowed deployment',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bemine-notify-config-'));
 try {
  const secret=(name,value)=>{const path=join(dir,name);writeFileSync(path,value,{mode:0o600});return path;};
  const factory=`0x${'1'.repeat(40)}`,market=`0x${'2'.repeat(40)}`;
  const env={NODE_ENV:'production',BEMINE_NOTIFICATIONS_ENABLED:'1',BEMINE_TELEGRAM_TOKEN_FILE:secret('token',`123456:${'A'.repeat(40)}`),
   BEMINE_NOTIFICATION_KEY_FILE:secret('key','a'.repeat(64)),BEMINE_TELEGRAM_WEBHOOK_SECRET_FILE:secret('hook','b'.repeat(48)),
   BEMINE_NOTIFICATION_DB:join(dir,'private','notifications.sqlite'),BEMINE_NOTIFICATION_FACTORY:factory,BEMINE_NOTIFICATION_MARKET:market,
   BEMINE_JOURNAL_FACTORIES:factory,DEPLOYMENT_JOURNAL_ORIGIN:'https://example.org',BEMINE_NOTIFICATION_PUBLIC_URL:'https://example.org/bemine/'};
  assert.equal(notificationConfiguration({}),null);
  assert.equal(notificationConfiguration(env).factory,factory);
  assert.equal(notificationConfiguration(env).community,null);
  const community={...env,BEMINE_COMMUNITY_ENABLED:'1',BEMINE_COMMUNITY_CHAT_ID:'-1004492628953',
   BEMINE_COMMUNITY_THREAD_ID:'2',BEMINE_COMMUNITY_USERNAME:'BEMineCommunity'};
  assert.equal(notificationConfiguration(community).community.threadId,2);
  assert.equal(notificationConfiguration({...community,BEMINE_COMMUNITY_THREAD_ID:'3'}).communityUnavailable,true);
  assert.throws(()=>notificationConfiguration({...env,BEMINE_NOTIFICATION_PUBLIC_URL:'https://attacker.invalid/'}));
  assert.throws(()=>notificationConfiguration({...env,BEMINE_NOTIFICATION_INDEX_URL:'http://remote.invalid:4180'}));
  assert.throws(()=>notificationConfiguration({...env,BEMINE_JOURNAL_FACTORIES:market}));
  assert.throws(()=>notificationConfiguration({...env,BEMINE_TELEGRAM_BOT_USERNAME:'OtherBot'}));
  chmodSync(env.BEMINE_TELEGRAM_TOKEN_FILE,0o644);assert.throws(()=>notificationConfiguration(env),/private regular file/);chmodSync(env.BEMINE_TELEGRAM_TOKEN_FILE,0o600);
  symlinkSync(env.BEMINE_TELEGRAM_TOKEN_FILE,join(dir,'link'));assert.throws(()=>notificationConfiguration({...env,BEMINE_TELEGRAM_TOKEN_FILE:join(dir,'link')}),/private regular file/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
