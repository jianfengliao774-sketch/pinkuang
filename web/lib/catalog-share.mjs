import { validatePublicBaseUrl } from './project-share.mjs';

export function createCatalogShare({ publicBaseUrl, locale = 'zh' } = {}) {
  const base = validatePublicBaseUrl(publicBaseUrl);
  if (!base) return null;
  const target = new URL(base);
  if (target.origin === 'https://bemine.cc.cd') target.pathname = '/';
  target.hash = 'pools';
  const url = target.href;
  const title = locale === 'en' ? 'Better together · BEMine' : '爱“拼”才会赢 · BEMine';
  const text = locale === 'en' ? 'Build, buy, or own a miner together~' : '矿机除了打和买，还可以拼~';
  const composer = endpoint => {
    const link = new URL(endpoint);
    link.searchParams.set('url', url);
    link.searchParams.set('text', `${title}\n${text}`);
    return link.href;
  };
  return { title, text, url, copyText: `${title}\n${text}\n${url}`,
    telegramUrl: composer('https://t.me/share/url'), xUrl: composer('https://x.com/intent/tweet') };
}
