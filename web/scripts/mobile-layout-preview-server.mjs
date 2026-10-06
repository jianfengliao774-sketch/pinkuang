/** Isolated local preview: no upstream proxy, keys, wallet signing or transaction methods. */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMobileLayoutPreviewFixture, PREVIEW_BASE_PATH, PREVIEW_RPC_METHODS, previewJson } from './mobile-layout-preview-fixture.mjs';
import { BEM_ADDRESS, BEM_POOL, WBNB_USDT_POOL } from '../lib/bem-price.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ico': 'image/x-icon' };
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'none'";
const walletScript = account => `<script>(()=>{const listeners=new Map(),account=${JSON.stringify(account)};const wallet={isMetaMask:true,isConnected:()=>true,request:async(input)=>{if(input?.method==='eth_accounts'||input?.method==='eth_requestAccounts')return[account];if(input?.method==='eth_chainId')return'0x38';const error=Error('效果预览禁止签名、交易及钱包管理。');error.code=4001;throw error;},on:(event,fn)=>{if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(fn);},removeListener:(event,fn)=>listeners.get(event)?.delete(fn)};Object.defineProperty(window,'ethereum',{value:wallet,writable:false,configurable:false});window.__BEMINE_EFFECT_PREVIEW__={account,readOnly:true,synthetic:true};window.addEventListener('eip6963:requestProvider',()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{info:{uuid:'f691b890-a837-4591-8cba-abfd641e9c16',name:'效果预览钱包',icon:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2264%22 height=%2264%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2216%22 fill=%22%23224337%22/%3E%3Cpath d=%22M16 22h32v24H16z%22 fill=%22%23d7bd83%22/%3E%3C/svg%3E',rdns:'local.bemine.preview'},provider:wallet}})));})();</script>`;
const frameClientScript = `
const phone=document.querySelector('.preview-phone'),frame=document.querySelector('iframe'),status=document.querySelector('.preview-label');
for(const button of document.querySelectorAll('[data-width]'))button.onclick=()=>{phone.style.width=Number(button.dataset.width)+parseFloat(getComputedStyle(phone).borderLeftWidth)*2+'px';for(const b of document.querySelectorAll('[data-width]'))b.setAttribute('aria-pressed',String(b===button));};
const waitFor=async(get)=>{const started=Date.now();while(Date.now()-started<4500){const result=get();if(result)return result;await new Promise(resolve=>setTimeout(resolve,40));}throw Error('示例持仓暂不可用');};
async function openExampleAccountPage(route){
 const win=frame.contentWindow;if(new URL(frame.src).origin!==location.origin||!win.__BEMINE_EFFECT_PREVIEW__?.synthetic||!win.__BEMINE_EFFECT_PREVIEW__?.readOnly)throw Error('仅支持本地示例钱包');
 const doc=win.document;
 const headerWallet=pattern=>[...doc.querySelectorAll('header button[aria-label]')].find(button=>pattern.test(button.getAttribute('aria-label')));
 if(!headerWallet(/^(?:打开钱包信息：|Open wallet details:)/)){
  status.textContent='正在加载示例权益…';
  const connect=await waitFor(()=>{const button=headerWallet(/^(?:连接钱包|Connect wallet)$/);return button&&!button.disabled?button:null;});connect.click();
  const example=await waitFor(()=>[...doc.querySelectorAll('[role="dialog"] button')].find(button=> /^(?:连接|Connect) 效果预览钱包$/.test(button.getAttribute('aria-label'))&&!button.disabled));example.click();
  await waitFor(()=>headerWallet(/^(?:打开钱包信息：|Open wallet details:)/));
 }
 win.location.hash=route;status.textContent='效果预览 · 合成账户与金额 · 无签名和交易';
}
for(const button of document.querySelectorAll('[data-route]'))button.onclick=async()=>{button.disabled=true;try{if(['overview','rewards','governance'].includes(button.dataset.route))await openExampleAccountPage(button.dataset.route);else frame.contentWindow.location.hash=button.dataset.route;}catch{status.textContent='示例持仓暂不可用，请刷新预览后重试。';}finally{button.disabled=false;}};
`;
const frameHtml = () => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>拼矿手机效果预览</title><style>*{box-sizing:border-box}body{margin:0;background:#f6f5ef;color:#293930;font:15px system-ui,sans-serif}.preview-shell{max-width:1080px;margin:auto;padding:24px 16px}.preview-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}h1{font-size:23px;margin:0 0 6px}p{margin:0;color:#647163;line-height:1.6}.preview-controls{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}button,a{border:1px solid #dadfd4;border-radius:9px;background:#fff;color:#315541;padding:10px 14px;font:inherit;text-decoration:none;cursor:pointer}button[aria-pressed=true]{background:#244337;color:#e1c58b;border-color:#b99c5e}.preview-phone{width:406px;max-width:100%;margin:auto;border:8px solid #233e32;border-radius:30px;overflow:hidden;box-shadow:0 18px 45px #233e3221;background:white}.preview-phone iframe{display:block;width:100%;height:844px;border:0;background:#f6f5ef}.preview-label{margin:12px auto;text-align:center;font-size:13px;color:#6a735f}@media(max-width:460px){.preview-shell{padding:16px 6px}.preview-phone{border-width:3px;border-radius:15px}}</style></head><body><main class="preview-shell"><header class="preview-heading"><div><h1>拼矿手机效果预览</h1><p>示例数据 · 仅供查看页面效果 · 正式钱包不要连接</p></div><a href="${PREVIEW_BASE_PATH}/#pools" target="_blank" rel="noopener">打开实际页面</a></header><nav class="preview-controls" aria-label="预览尺寸"><button data-width="320">320</button><button data-width="390" aria-pressed="true">390</button><button data-width="430">430</button><button data-route="pools">参与拼矿</button><button data-route="overview">我的资产</button><button data-route="market">矿机转让</button><button data-route="rewards">收益中心</button><button data-route="governance">共同决策</button><button data-route="records">公开记录</button></nav><div class="preview-phone"><iframe title="拼矿手机预览" src="${PREVIEW_BASE_PATH}/#pools" sandbox="allow-scripts allow-same-origin allow-popups"></iframe></div><p class="preview-label" aria-live="polite">效果预览 · 合成账户与金额 · 无签名和交易</p></main><script>${frameClientScript}</script></body></html>`;

export async function createMobileLayoutPreviewServer({ root = process.env.BEMINE_PREVIEW_ROOT
  || fileURLToPath(new URL('../out/', import.meta.url)), port = Number(process.env.BEMINE_PREVIEW_PORT || 3218),
  fixture = createMobileLayoutPreviewFixture() } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error('Preview port must be 1–65535.');
  root = await realpath(resolve(root));
  if (!(await stat(join(root, 'index.html'))).isFile()) throw Error('Preview requires the completed local web/out build.');
  const streams = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', csp); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    const send = (code, value, type = 'application/json; charset=utf-8') => {
      res.statusCode = code; res.setHeader('Content-Type', type);
      res.end(req.method === 'HEAD' ? undefined : type.startsWith('application/json') ? previewJson(value) : value);
    };
    try {
      if (!req.url || req.url.length > 4096) return send(400, { error: 'Invalid preview URL.' });
      const url = new URL(req.url, `http://127.0.0.1:${port}`), path = url.pathname;
      if (url.origin !== `http://127.0.0.1:${port}`) return send(403, { error: 'Only local preview paths are allowed.' });
      const apiPath = path.startsWith(PREVIEW_BASE_PATH + '/') ? path.slice(PREVIEW_BASE_PATH.length) : path;
      if (apiPath === '/api/rpc') {
        if (req.method !== 'POST') return send(405, { error: 'Preview RPC reads use POST.' });
        let bytes = 0, parts = []; for await (const part of req) { bytes += part.length;
          if (bytes > 65536) return send(413, { error: 'Preview RPC request is too large.' }); parts.push(part); }
        const input = JSON.parse(Buffer.concat(parts).toString());
        if (!input || Array.isArray(input) || !PREVIEW_RPC_METHODS.includes(input.method)
          || /send|sign|wallet_/i.test(input.method)) {
          fixture.trace.refused.push(`rpc:${input?.method}`);
          return send(403, { jsonrpc: '2.0', id: input?.id ?? null, error: { code: -32601, message: '效果预览禁止签名和交易。' } });
        }
        return send(200, { jsonrpc: '2.0', id: input.id ?? null, result: await fixture.rpc(input) });
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        fixture.trace.refused.push(`${req.method}:${apiPath}`); return send(405, { error: '效果预览仅允许读取，禁止写入。' });
      }
      if (path === '/__preview/status') return send(200, { synthetic: true, readOnly: true, root,
        basePath: PREVIEW_BASE_PATH, account: fixture.account, manifestSha: fixture.manifestSha,
        label: fixture.label, broadcastCount: 0, trace: fixture.trace });
      if (path === '/preview.html') return send(200, frameHtml(), 'text/html; charset=utf-8');
      if (path === '/' || path === PREVIEW_BASE_PATH) { res.statusCode = 302;
        res.setHeader('Location', path === '/' ? '/preview.html' : PREVIEW_BASE_PATH + '/'); return res.end(); }
      if (apiPath.startsWith('/api/journal/')) return send(200, fixture.journal(url.href));
      if (apiPath === '/api/chain-index/v1/display/events') {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.write('retry: 15000\nevent: update\nid: preview-static\ndata: {"revision":"preview-static","topics":[]}\n\n');
        streams.add(res); res.once('close', () => streams.delete(res)); return;
      }
      if (apiPath.startsWith('/api/chain-index/')) return send(200, await fixture.index(url.href));
      if (apiPath.startsWith('/firsto-api/v1/')) return send(200, fixture.firsto(url.href));
      if (/^\/data\/frontend-manifest(?:\.v[45])?\.json$/.test(apiPath)) return send(200, fixture.manifest);
      if (apiPath === '/data/bem-price.json') return send(200, { status: 'ok', chainId: 56,
        tokenAddress: BEM_ADDRESS, poolAddress: BEM_POOL, conversionPoolAddress: WBNB_USDT_POOL,
        source: 'PancakeSwap V3', quoteCurrency: 'USDT', priceUsdt: 45.43002,
        updatedAt: new Date().toISOString(), synthetic: true });
      if (apiPath.startsWith('/api/') || apiPath.startsWith('/firsto-api/')) return send(404, { error: 'Unknown local fixture read.' });
      let relative = decodeURIComponent(apiPath).replace(/^\/+/, '');
      if (!relative) relative = 'index.html';
      let file = resolve(root, relative);
      if (file !== root && !file.startsWith(root + sep)) return send(403, { error: 'Invalid local asset path.' });
      try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); }
      catch { if (!extname(file)) file += '.html'; }
      const canonical = await realpath(file);
      if (!canonical.startsWith(root + sep)) return send(403, { error: 'Asset escapes the preview build.' });
      let body = await readFile(canonical), type = types[extname(canonical)] || 'application/octet-stream';
      if (type.startsWith('text/html')) {
        body = body.toString().replace('<head>', '<head>' + walletScript(fixture.account));
        body = body.replace('</body>', '<aside style="position:fixed;bottom:5px;left:5px;z-index:99999;max-width:90vw;padding:4px 8px;border-radius:6px;background:#244337;color:#e1c58b;font:11px system-ui;pointer-events:none">效果预览 · 示例数据 · 正式钱包不要连接</aside></body>');
      }
      return send(200, body, type);
    } catch (error) { return send(400, { error: error.message || 'Local preview read failed.' }); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  const close = async () => { for (const res of streams) res.end(); server.closeAllConnections();
    await new Promise(resolveClose => server.close(resolveClose)); };
  return { server, close, fixture, root, port, base: `http://127.0.0.1:${port}${PREVIEW_BASE_PATH}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stop = setTimeout(() => process.exit(124), 28_000);
  const preview = await createMobileLayoutPreviewServer();
  console.log(JSON.stringify({ label: preview.fixture.label, preview: `http://127.0.0.1:${preview.port}/preview.html`,
    actualPage: preview.base + '/#pools', root: preview.root, lifetimeSeconds: 28, broadcastCount: 0 }));
  const quit = async () => { clearTimeout(stop); await preview.close(); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, quit);
}
