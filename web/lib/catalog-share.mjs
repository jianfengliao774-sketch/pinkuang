import { validatePublicBaseUrl } from './project-share.mjs';

export function createCatalogShare({ publicBaseUrl, locale = 'zh' } = {}) {
  const base = validatePublicBaseUrl(publicBaseUrl);
  if (!base) return null;
  const target = new URL(base);
  if (target.origin === 'https://bemine.cc.cd') target.pathname = '/';
  target.hash = 'pools';
  const url = target.href;
  const title = locale === 'en' ? 'Join a pool · BEMine' : '参与拼矿 · BEMine';
  const text = locale === 'en' ? 'Start with one share. Own BEM miners together.' : '从一份开始，共持 BEM 矿机。';
  const composer = endpoint => {
    const link = new URL(endpoint);
    link.searchParams.set('url', url);
    link.searchParams.set('text', `${title}\n${text}`);
    return link.href;
  };
  return { title, text, url, copyText: `${title}\n${text}\n${url}`,
    telegramUrl: composer('https://t.me/share/url'), xUrl: composer('https://x.com/intent/tweet') };
}
