// GitHub OAuth 后端 —— code 换 token、拉取用户信息
// HTTP 客户端用全局 fetch（底层即 undici）。
// 注意：不能用 node:http 裸请求 GitHub —— 其请求指纹会被 GitHub WAF 拦截
// （返回 "Whoa there! You have sent an invalid request" HTML 400），fetch 则正常。
// 本地开发若配置了 HTTPS_PROXY 且安装了 undici 包会走 ProxyAgent；否则直连
// （Vercel 上无代理环境变量，始终直连）。
import crypto from 'node:crypto';

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
export const githubEnabled = () => Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);

function getProxy() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

// 发起 HTTPS 请求并解析 JSON（代理为尽力而为：undici 不可用时自动直连）
export async function httpsJson(urlStr, { method = 'GET', headers = {}, body } = {}) {
  const reqHeaders = {
    'User-Agent': 'termquest-server',
    'Accept': 'application/vnd.github+json',
    ...headers,
  };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    reqHeaders['Content-Type'] = 'application/json';
  }

  const options = { method, headers: reqHeaders };
  if (payload !== undefined) options.body = payload;

  const proxy = getProxy();
  if (proxy) {
    try {
      // 拼接 specifier 避免打包器静态解析这个可选依赖
      const undici = await import('und' + 'ici');
      options.dispatcher = new undici.ProxyAgent({ uri: proxy });
    } catch { /* undici 未安装 → 直连 */ }
  }

  const res = await fetch(urlStr, options);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = text; }
  return { status: res.status, data };
}

// 用授权码换取访问令牌
export async function exchangeCode(code) {
  const res = await httpsJson('https://github.com/login/oauth/access_token', {
    method: 'POST',
    body: { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
  });
  if (res.status !== 200 || res.data.error)
    throw new Error(res.data.error_description || res.data.error || 'code 交换失败');
  return res.data.access_token;
}

// 用访问令牌拉取 GitHub 用户信息
export async function fetchGithubUser(accessToken) {
  const res = await httpsJson('https://api.github.com/user', {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (res.status !== 200 || !res.data.login)
    throw new Error('获取 GitHub 用户信息失败 (' + res.status + ')');
  return res.data; // {id, login, name, avatar_url, ...}
}

export function newUserId() { return 'u_' + crypto.randomBytes(8).toString('hex'); }
