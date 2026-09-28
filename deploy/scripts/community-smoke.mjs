/** Explicit operator-run smoke only; never called by the worker or by a web request. */
import { notificationConfiguration } from '../server/notifications/config.mjs';
import { NotificationStore } from '../server/notifications/store.mjs';
import { TelegramClient } from '../server/notifications/telegram.mjs';
import { verifyCommunityDestination } from '../server/notifications/community-config.mjs';
import { setTimeout as delay } from 'node:timers/promises';

let store;
try {
  if (process.argv[2] !== '--send-test') throw new Error('Explicit test flag required.');
  const config=notificationConfiguration();
  if(!config?.community)throw new Error('Community must be configured.');
  const client=new TelegramClient({token:config.token});
  const me=await client.request('getMe',{});
  if(!me?.is_bot||me.username!==config.botUsername)throw new Error('Unexpected bot.');
  await verifyCommunityDestination(client,config.community,me.id);
  store=new NotificationStore(config.dbPath,{encryptionKey:config.encryptionKey});
  const key=`community-smoke:${config.community.chatId}:${config.community.threadId}:v1`;
  const record=store.transaction(()=>{
    const existing=store.getMeta(key);
    if(existing)return existing;
    store.setMeta(key,{status:'sending',at:Date.now()});
    return null;
  });
  if(record) {
    console.log(JSON.stringify({status:'already_attempted',messageId:record.messageId??null,state:record.status}));
  } else {
    // Reserve before network I/O; an ambiguous send is never repeated automatically.
    const link=lang=>{const u=new URL(config.publicBaseUrl);u.searchParams.set('lang',lang);u.hash='market';return u.href;};
    const buttons={inline_keyboard:[[{text:'查看拼矿项目',url:link('zh')},{text:'View pools',url:link('en')}]]};
    const caption='🧪 拼矿 BEMine｜项目公告测试\nCommunity announcement test\n\n这里将发布新的拼矿项目，点击下方按钮即可查看。\nNew BEMine pools will be announced here. Use the buttons below to explore.\n\n这是一条测试消息，不代表新项目开放认购。\nThis is a test, not a live fundraising announcement.';
    const sent=await client.sendTopicPhoto(config.community,{caption,reply_markup:buttons});
    store.setMeta(key,{status:'sent',messageId:sent.message_id,at:Date.now()});
    await delay(3300);
    await client.editTopicCaption(config.community,sent.message_id,{caption:caption+'\n\n✅ 公告状态更新测试完成。\nAnnouncement update test completed.',reply_markup:buttons});
    store.setMeta(key,{status:'verified',messageId:sent.message_id,at:Date.now()});
    console.log(JSON.stringify({status:'verified',chatId:config.community.chatId,threadId:config.community.threadId,messageId:sent.message_id,
      url:`https://t.me/c/${config.community.chatId.slice(4)}/${config.community.threadId}/${sent.message_id}`}));
  }
} catch {console.error('Community smoke failed or delivery is ambiguous. Inspect the saved smoke state before retrying.');process.exitCode=1;}
finally {store?.close();}
