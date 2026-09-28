import { timingSafeEqual } from 'node:crypto';
import { NotificationStore } from './store.mjs';
import { createNotificationService } from './service.mjs';
import { TelegramClient } from './telegram.mjs';
import { createNotificationSource, createNotificationWorker } from './delivery.mjs';
import { notificationConfiguration } from './config.mjs';
import { createCommunitySource, createCommunityWorker } from './community.mjs';
import { verifyCommunityDestination } from './community-config.mjs';

/** An optional alert service must never prevent the transaction journal from starting. */
export async function startOptionalNotifications(env, { configure = notificationConfiguration, create = createNotificationRuntime, onStatus = () => {} } = {}) {
  let runtime;
  try {
    const config = configure(env);
    if (!config) return null;
    runtime = create(config, { onStatus });
    await runtime.start();
    return runtime;
  } catch {
    try { await runtime?.close(); } catch { /* preserve the independent wallet service */ }
    try { onStatus({ status: 'startup_unavailable' }); } catch {}
    return null;
  }
}

/** One notification runtime per journal process; database leases coordinate accidental overlaps. */
export function createNotificationRuntime(config, { now = Date.now, store: injectedStore, telegram: injectedTelegram,
  source: injectedSource, communitySource: injectedCommunitySource, communityWorker: injectedCommunityWorker,
  onStatus = () => {}, intervalMs = 10_000 } = {}) {
  if (!config) return null;
  const store = injectedStore ?? new NotificationStore(config.dbPath, { encryptionKey:config.encryptionKey,now });
  const telegram = injectedTelegram ?? new TelegramClient({token:config.token});
  const service = createNotificationService({store,telegram,botUsername:config.botUsername,publicBaseUrl:config.publicBaseUrl});
  const source = injectedSource ?? createNotificationSource({baseUrl:config.indexUrl});
  const worker = createNotificationWorker({store,source,sender:telegram,factory:config.factory,market:config.market,
    publicBaseUrl:config.publicBaseUrl,now});
  let communityWorker = null;
  if (config.community) {
    try {
      communityWorker = injectedCommunityWorker ?? createCommunityWorker({store,
        source: injectedCommunitySource ?? createCommunitySource({baseUrl:config.indexUrl}), sender:telegram,
        factory:config.factory, market:config.market, publicBaseUrl:config.publicBaseUrl,community:config.community,now});
    } catch { try { onStatus({status:'community_configuration_unavailable'}); } catch {} }
  }
  let timer=null, running=null, stopped=false, verified=false, botId=null, communityCheckedAt=null;
  const inFlight=new Set();
  const secret=Buffer.from(config.webhookSecret);
  const safeStatus = data => { try { onStatus(data); } catch { /* telemetry cannot interrupt delivery */ } };
  function acceptsWebhook(value) {
    if (!verified || typeof value!=='string' || value.length>128) return false;
    const candidate=Buffer.from(value);return candidate.length===secret.length && timingSafeEqual(candidate,secret);
  }
  async function verifyIdentity() {
    const bot=await telegram.request('getMe',{});
    if (bot?.is_bot!==true || bot.username!==config.botUsername) throw new Error('Notification bot identity does not match the configured bot.');
    verified=true;
    botId=bot.id;
  }
  async function runCommunity() {
    if (!communityWorker) return;
    try {
      if (communityCheckedAt === null || now() - communityCheckedAt >= 60_000) {
        await verifyCommunityDestination(telegram,config.community,botId);
        communityCheckedAt=now();
      }
      const result=await communityWorker.tick();
      safeStatus({status:`community_${result.blocked ? 'delivery_blocked' : result.status}`,
        sourceBlock:result.sourceBlock??null,sent:result.sent??0,edited:result.edited??0,retried:result.retried??0});
    } catch { communityCheckedAt=null;safeStatus({status:'community_source_or_delivery_unavailable'}); }
  }
  async function run() {
    if (stopped || !verified || running) return;
    running=(async()=>{
      try { await service.flushBotReplies?.(); } catch { safeStatus({status:'bot_replies_pending'}); }
      await Promise.allSettled([
        (async()=>{try { const result=await worker.tick();safeStatus({status:result.status,sourceBlock:result.sourceBlock??null}); }
          catch { safeStatus({status:'source_or_delivery_unavailable'}); }})(),
        runCommunity(),
      ]);
    })();
    try { await running; } finally { running=null;if(!stopped)timer=setTimeout(run,intervalMs); }
  }
  return {
    capabilities:()=>({enabled:verified&&!stopped,botUsername:config.botUsername}),
    acceptsWebhook,
    async handleWallet(input) {
      if (!verified || stopped) return {status:503,body:{error:'Notifications are temporarily unavailable.'}};
      return service.handleWallet(input);
    },
    async handleTelegramUpdate(update) {
      if (stopped || !verified) throw new Error('Notifications are unavailable.');
      const task=service.handleTelegramUpdate(update);inFlight.add(task);
      try { return await task; } finally { inFlight.delete(task); }
    },
    async start() { if(stopped)throw new Error('Notifications are closed.');await verifyIdentity();
      if(config.communityUnavailable)safeStatus({status:'community_configuration_unavailable'});void run(); },
    async close() {
      stopped=true;clearTimeout(timer);await Promise.allSettled([...(running?[running]:[]),...inFlight]);
      store.close();secret.fill(0);
    },
  };
}
