// GitHub 仓库存储 —— 未配置 Upstash Redis 时的兜底持久化
// 用 GITHUB_DATA_TOKEN 通过 Contents API 把数据 JSON 存进私有仓库
// （默认 KD-CHL/termquest-data）。Vercel 上直连 api.github.com，
// 本地开发自动复用 github.js 的 CONNECT 代理隧道。
//
// 并发策略：Contents API 更新需携带最新 blob sha，冲突（422/409）时
// 重新拉取 sha 再重试一次，语义上等价于"最后写入者胜"——与 Redis
// 整键 SET 的语义一致，对本项目的数据规模完全够用。
import { httpsJson } from './github.js';

const OWNER = process.env.GITHUB_DATA_OWNER || 'KD-CHL';
const REPO = process.env.GITHUB_DATA_REPO || 'termquest-data';
const BRANCH = 'main';
const API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';

const shaCache = new Map(); // key → 最近一次读/写的 blob sha

function auth() {
  return { Authorization: 'Bearer ' + process.env.GITHUB_DATA_TOKEN };
}

// 'gitgame:users' → 'gitgame-users.json'（避免文件名里的冒号）
function fileOf(key) {
  return encodeURIComponent(key.replace(/:/g, '-')) + '.json';
}

function apiUrl(key) {
  return `${API_BASE}/repos/${OWNER}/${REPO}/contents/${fileOf(key)}?ref=${BRANCH}`;
}

export async function kvGet(key) {
  const res = await httpsJson(apiUrl(key), { headers: auth() });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error('GitHub 存储读取失败 (' + res.status + ')');
  shaCache.set(key, res.data.sha);
  return JSON.parse(Buffer.from(res.data.content || '', 'base64').toString('utf8'));
}

export async function kvSet(key, value) {
  const body = {
    message: 'chore(data): update ' + fileOf(key),
    content: Buffer.from(JSON.stringify(value)).toString('base64'),
    branch: BRANCH,
  };
  const cached = shaCache.get(key);
  if (cached) body.sha = cached;

  let res = await httpsJson(apiUrl(key), { method: 'PUT', headers: auth(), body });
  if (res.status === 422 || res.status === 409) {
    // sha 过期（存在并发写入）：拉取最新 sha 后重试一次
    const cur = await httpsJson(apiUrl(key), { headers: auth() });
    if (cur.status === 200) {
      body.sha = cur.data.sha;
      res = await httpsJson(apiUrl(key), { method: 'PUT', headers: auth(), body });
    }
  }
  if (res.status !== 200 && res.status !== 201)
    throw new Error('GitHub 存储写入失败 (' + res.status + ')');
  if (res.data && res.data.content && res.data.content.sha)
    shaCache.set(key, res.data.content.sha);
}
