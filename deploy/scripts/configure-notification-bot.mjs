/** Run only after the HTTPS notification endpoint has been deployed. Never prints credentials. */
import { notificationConfiguration } from '../server/notifications/config.mjs';
import { TelegramClient } from '../server/notifications/telegram.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function configureNotificationBot(config, client = new TelegramClient({ token:config.token })) {
  const bot = await client.request('getMe',{});
  if (bot?.is_bot!==true || bot.username!==config.botUsername) throw new Error('Unexpected notification bot identity.');
  const endpoint = new URL('api/journal/notifications/telegram/webhook',config.publicBaseUrl).href;
  const en = {
    name:'BEMine | Mining Alerts',
    short_description:'Official BEMine notifications for miner sale proposals, voting reminders, results and completed sales.',
    description:'Your BEMine mining updates, in one place.\n\nLink your wallet through the BEMine website to receive sale proposals, voting reminders, voting results and sale completion updates.\n\nCast your vote on the website with your wallet.\n\nWe will never ask for your private key or recovery phrase.',
  };
  const zh = {
    name:'拼矿 BEMine｜通知助手',
    short_description:'拼矿 BEMine 官方通知助手，接收矿机出售提案、投票提醒、投票结果和成交通知。',
    description:'欢迎使用拼矿 BEMine 通知助手。\n\n通过拼矿官网绑定钱包，接收与你参与的矿机有关的重要提醒：\n\n• 矿机出售提案\n• 投票截止提醒\n• 投票结果\n• 矿机成交结果\n\n投票由你在官网连接钱包后确认。\n\n我们不会索取你的私钥或助记词。',
  };
  for (const [language_code,copy] of [['',en],['en',en],['zh',zh]]) {
    await client.request('setMyName',{language_code,name:copy.name});
    await client.request('setMyShortDescription',{language_code,short_description:copy.short_description});
    await client.request('setMyDescription',{language_code,description:copy.description});
    const labels=language_code==='zh'?['开始使用','通知设置与钱包绑定','切换语言','暂停 Telegram 通知','使用帮助']:
      ['Get started','Notification settings and wallet connections','Change language','Pause Telegram notifications','Help'];
    await client.request('setMyCommands',{language_code,commands:['start','settings','language','stop','help'].map((command,i)=>({command,description:labels[i]}))});
  }
  await client.request('setWebhook',{url:endpoint,secret_token:config.webhookSecret,
    allowed_updates:['message','callback_query'],max_connections:4,drop_pending_updates:false});
  const info=await client.request('getWebhookInfo',{});
  if(info?.url!==endpoint)throw new Error('Webhook confirmation did not match.');
  return {username:bot.username,webhook:endpoint,pendingUpdates:info.pending_update_count??null};
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config=notificationConfiguration();
    if(!config)throw new Error('Enable and configure notifications before running setup.');
    const result=await configureNotificationBot(config);console.log(JSON.stringify(result));
  }catch {console.error('Notification bot configuration failed. Check private configuration and endpoint availability.');process.exitCode=1;}
}
