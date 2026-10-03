import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Wallet } from 'ethers';

const HOST = '127.0.0.1';
const TTL_MS = 15 * 60_000;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const REMOTE = `import os,re,stat,sys
directory='/etc/pinkuang'
os.makedirs(directory,mode=0o700,exist_ok=True)
info=os.lstat(directory)
if not stat.S_ISDIR(info.st_mode) or info.st_uid!=0 or info.st_mode&0o077:
    raise SystemExit('private credential directory is invalid')
data=sys.stdin.buffer.read(80)
if len(data)!=67 or data[-1]!=10 or not re.fullmatch(rb'0x[0-9a-fA-F]{64}',data[:-1]):
    raise SystemExit('invalid credential format')
path=directory+'/keeper.key'
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:
    os.write(fd,data)
    os.fsync(fd)
finally:
    os.close(fd)
fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
try: os.fsync(fd)
finally: os.close(fd)
print('saved')`;

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const safeError = value => String(value ?? '').replace(/0x[0-9a-f]{64,}/ig, '[redacted]').slice(0, 200);
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function saveCredentialViaSsh(key, {
  sshKey = resolve(process.env.HOME ?? '', '.ssh/chouj-digitalocean-ed25519'),
  host = '144.126.242.139', spawnImpl = spawn,
} = {}) {
  if (!KEY.test(key)) return Promise.reject(new Error('私钥格式不正确。'));
  return new Promise((resolveSave, rejectSave) => {
    const command = `python3 -c ${quote(REMOTE)}`;
    const child = spawnImpl('ssh', ['-T', '-i', sshKey, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', `root@${host}`, command],
    { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGTERM'), 20_000);
    let stderr = '', stdout = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-500); });
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-100); });
    child.on('error', error => { clearTimeout(timer); rejectSave(new Error(safeError(error.message))); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim() === 'saved') resolveSave();
      else rejectSave(new Error(stderr.includes('File exists') ? '服务器已有 Gas 钱包凭据，未覆盖。' : `服务器保存失败：${safeError(stderr) || 'SSH 不可用'}`));
    });
    child.stdin.on('error', () => {});
    const bytes = Buffer.from(`${key}\n`);
    child.stdin.end(bytes, () => bytes.fill(0));
  });
}

function page(content, nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BEMine · Gas 钱包录入</title><style nonce="${nonce}">:root{color-scheme:light}body{margin:0;background:#f6f4ef;color:#243b32;font:16px -apple-system,BlinkMacSystemFont,"Noto Sans SC",sans-serif}main{max-width:560px;margin:8vh auto;padding:32px;border:1px solid #dddcd4;border-radius:18px;background:white;box-shadow:0 18px 50px #182d2110}h1{font-size:27px;margin:0 0 12px}p{line-height:1.7;color:#56665d}label{display:block;font-weight:600;margin:28px 0 10px}input{width:100%;box-sizing:border-box;padding:14px;border:1px solid #b9c6ba;border-radius:9px;font:16px monospace}button{width:100%;margin-top:22px;padding:14px;background:#d8ba82;border:0;border-radius:9px;font-size:16px;font-weight:600;cursor:pointer}.note{padding:15px;background:#f1f4eb;border-radius:9px;font-size:14px}.address{overflow-wrap:anywhere;font-family:monospace;color:#183f31}small{color:#78847c}</style></head><body><main>${content}</main></body></html>`;
}

export async function createSetupServer({ saveCredential = saveCredentialViaSsh, ttlMs = TTL_MS, port = 0,
  onSaved = () => {}, onExpired = () => {} } = {}) {
  const token = randomBytes(32).toString('hex'), formToken = randomBytes(32).toString('hex');
  const nonce = randomBytes(16).toString('base64');
  const path = `/setup/${token}`;
  let used = false, busy = false, attempts = 0, origin;
  const server = createServer(async (req, res) => {
    const headers = { 'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` };
    const send = (code, html) => { res.writeHead(code, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(html, nonce)); };
    if (req.headers.host !== origin.slice(7).toLowerCase() || req.url !== path) return send(404, '<h1>页面不可用</h1>');
    if (used || attempts >= 5) return send(410, '<h1>录入页已关闭</h1>');
    if (req.method === 'GET') return send(200, `<h1>录入专用 Gas 钱包</h1><p>这是仅在本机打开的一次性页面。私钥通过 SSH 写入服务器的受限文件；本页面不设置浏览器存储，也不向公开网站发送。</p><div class="note">请使用<strong>专用 Gas 钱包</strong>，不要输入合约部署／升级硬件钱包的私钥。保存不会立即购机；我们会先核对公开地址与余额。</div><form method="post" action="${path}" autocomplete="off"><input type="hidden" name="formToken" value="${formToken}"><label for="key">Gas 钱包私钥</label><input id="key" name="key" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" maxlength="66" minlength="66" pattern="0x[0-9a-fA-F]{64}" required><button type="submit">安全保存到服务器</button></form><p><small>页面 15 分钟后失效；提交后不会回显私钥。</small></p>`);
    if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded' || busy) return send(403, '<h1>请求未通过验证</h1>');
    if (Number(req.headers['content-length'] ?? 0) > 256) return send(413, '<h1>输入过长</h1>');
    busy = true;
    let body = Buffer.alloc(0);
    try {
      for await (const chunk of req) {
        if (body.length + chunk.length > 256) return send(413, '<h1>输入过长</h1>');
        body = Buffer.concat([body, chunk]);
      }
      const fields = new URLSearchParams(body.toString('utf8'));
      const key = fields.get('key');
      attempts += 1;
      if (fields.size !== 2 || fields.get('formToken') !== formToken) return send(403, '<h1>请求未通过验证</h1>');
      if (!KEY.test(key ?? '')) return send(400, '<h1>私钥格式不正确</h1><p>请返回后重试。</p>');
      const address = new Wallet(key).address;
      await saveCredential(key);
      used = true;
      send(200, `<h1>已安全保存</h1><p>Gas 钱包公开地址：</p><p class="address">${escapeHtml(address)}</p><div class="note">请核对这是否为你的专用 Gas 钱包。网页不会显示私钥；自动购机服务目前仍未启用。</div><p>请只告诉我“已保存”和这个<strong>公开地址</strong>，不要发送私钥。</p>`);
      onSaved(address);
      setTimeout(() => server.close(), 250).unref();
    } catch (error) {
      send(503, `<h1>未保存</h1><p>${escapeHtml(safeError(error.message))}</p><p>请返回后重试，不要把私钥发到聊天中。</p>`);
    } finally { body.fill(0); busy = false; }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 15_000;
  server.maxRequestsPerSocket = 10;
  await new Promise((resolveListen, rejectListen) => server.once('error', rejectListen).listen(port, HOST, resolveListen));
  const address = server.address();
  origin = `http://${HOST}:${address.port}`;
  const timer = setTimeout(() => { server.close(); onExpired(); }, ttlMs);
  timer.unref();
  server.once('close', () => clearTimeout(timer));
  return { url: origin + path, close: () => server.close(), address };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createSetupServer({ onSaved: address => console.log(`Gas wallet public address saved: ${address}`),
    onExpired: () => console.log('Local setup page expired.') })
    .then(result => console.log(`Open this one-time local page: ${result.url}`))
    .catch(error => { console.error(safeError(error.message)); process.exitCode = 1; });
}
