import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { communityConfiguration } from './community-config.mjs';

function secretFile(path, label) {
  if (!path || !isAbsolute(path)) throw new Error(`${label} requires an absolute secret-file path.`);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || (info.mode & 0o077))
    throw new Error(`${label} must be a private regular file (0600).`);
  return readFileSync(path, 'utf8').trim();
}
function address(value, label) {
  if (!/^0x[0-9a-f]{40}$/i.test(value ?? '') || /^0x0{40}$/i.test(value)) throw new Error(`Invalid ${label}.`);
  return value.toLowerCase();
}
function publicUrl(value, origin) {
  let url; try { url = new URL(value); } catch { throw new Error('A public notification website URL is required.'); }
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || url.protocol !== 'https:' || !url.pathname.endsWith('/'))
    throw new Error('Notification links must use the exact journal origin and a website path ending in /.');
  return url.href;
}
/** Disabled unless explicitly enabled. Keys and tokens are never public config or command arguments. */
export function notificationConfiguration(env = process.env) {
  if (env.BEMINE_NOTIFICATIONS_ENABLED !== '1') return null;
  const token = secretFile(env.BEMINE_TELEGRAM_TOKEN_FILE, 'Telegram token');
  if (!/^\d{5,20}:[A-Za-z0-9_-]{25,100}$/.test(token)) throw new Error('Invalid Telegram token format.');
  const encryptionKey = secretFile(env.BEMINE_NOTIFICATION_KEY_FILE, 'Notification encryption key');
  if (!/^[a-f\d]{64}$/i.test(encryptionKey)) throw new Error('Notification key must contain 32 bytes encoded as hex.');
  const webhookSecret = secretFile(env.BEMINE_TELEGRAM_WEBHOOK_SECRET_FILE, 'Webhook secret');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(webhookSecret)) throw new Error('Webhook secret must contain 32-128 URL-safe characters.');
  const dbPath = env.BEMINE_NOTIFICATION_DB;
  if (!dbPath || !isAbsolute(dbPath)) throw new Error('An absolute persistent notification database path is required.');
  const factory = address(env.BEMINE_NOTIFICATION_FACTORY, 'notification factory');
  const market = address(env.BEMINE_NOTIFICATION_MARKET, 'notification market');
  const allowed = (env.BEMINE_JOURNAL_FACTORIES || '').split(',').map(x=>x.trim().toLowerCase());
  if (!allowed.includes(factory) || factory===market) throw new Error('Notification deployment is outside the wallet service allowlist.');
  const botUsername = env.BEMINE_TELEGRAM_BOT_USERNAME || 'BEMineNotifyBot';
  if (botUsername !== 'BEMineNotifyBot') throw new Error('The configured notification bot must be BEMineNotifyBot.');
  const publicBaseUrl = publicUrl(env.BEMINE_NOTIFICATION_PUBLIC_URL, env.DEPLOYMENT_JOURNAL_ORIGIN);
  let indexUrl; try { indexUrl = new URL(env.BEMINE_NOTIFICATION_INDEX_URL || env.BEMINE_INDEX_URL || 'http://127.0.0.1:4180'); }
  catch { throw new Error('Invalid private notification index URL.'); }
  if (!['127.0.0.1','localhost','[::1]'].includes(indexUrl.hostname) || indexUrl.protocol!=='http:' || indexUrl.username || indexUrl.password || indexUrl.search || indexUrl.hash || indexUrl.pathname!=='/')
    throw new Error('Notification worker must use a loopback index service.');
  let community = null, communityUnavailable = false;
  try { community = communityConfiguration(env, publicBaseUrl); }
  catch { communityUnavailable = true; }
  return { token, encryptionKey, webhookSecret, dbPath, factory, market, botUsername, publicBaseUrl,
    indexUrl:indexUrl.origin, community, communityUnavailable };
}
