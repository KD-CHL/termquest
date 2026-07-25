// 数据库模块渲染 —— SQL 表结构/数据 + Redis 键值状态
import { app } from './state.js';
import { updatePrompt } from './terminal.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function dbRender() {
  const e = app.engine;
  if (!e || !e.databases) return;
  renderTables(e);
  renderRedis(e);
  updatePrompt();
}

function renderTables(e) {
  const box = document.getElementById('dbTables');
  if (!box) return;
  const session = e.sqlSession
    ? `<div class="ssh-banner">🗄️ SQLite 会话：${esc(e.sqlSession)}（<b>.quit</b> 退出）</div>` : '';
  const dbNames = Object.keys(e.databases);
  if (!dbNames.length) {
    box.innerHTML = session + '<div class="empty-note">还没有数据库 —— sqlite3 <库名> 创建一个</div>';
    return;
  }
  const parts = [session];
  for (const dbName of dbNames) {
    const tables = e.databases[dbName].tables;
    const tNames = Object.keys(tables);
    parts.push(`<div class="tree-cwd">💾 ${esc(dbName)}</div>`);
    if (!tNames.length) { parts.push('<div class="empty-note">（空库，无表）</div>'); continue; }
    for (const tn of tNames) {
      const t = tables[tn];
      parts.push(`<div class="img-item"><div class="img-name">📋 ${esc(tn)} <span class="img-meta">${t.rows.length} 行 · ${t.cols.join(', ')}</span></div></div>`);
    }
  }
  box.innerHTML = parts.join('');
}

function renderRedis(e) {
  const box = document.getElementById('dbRedis');
  if (!box) return;
  const session = e.redisSession
    ? `<div class="ssh-banner">🔴 Redis 会话中（<b>exit</b> 退出）</div>` : '';
  const R = e.redis;
  const keys = [...Object.keys(R.kv), ...Object.keys(R.lists), ...Object.keys(R.hashes)];
  if (!keys.length) {
    box.innerHTML = session + '<div class="empty-note">Redis 是空的 —— redis-cli 后 SET / LPUSH / HSET</div>';
    return;
  }
  const rows = [];
  for (const k of Object.keys(R.kv)) rows.push(kvRow('str', k, `"${R.kv[k].value}"`));
  for (const k of Object.keys(R.lists)) rows.push(kvRow('list', k, `[${R.lists[k].join(', ')}]`));
  for (const k of Object.keys(R.hashes)) {
    const fields = Object.entries(R.hashes[k]).map(([f, v]) => `${f}=${v}`).join(' ');
    rows.push(kvRow('hash', k, fields));
  }
  box.innerHTML = session + rows.join('');
}

function kvRow(type, key, val) {
  const color = type === 'str' ? 'var(--green)' : type === 'list' ? 'var(--blue)' : 'var(--amber)';
  return `<div class="proc-row">
    <span class="proc-state run" style="color:${color}">${type}</span>
    <span class="proc-name">${esc(key)}</span>
    <span class="proc-cpu">${esc(val)}</span>
  </div>`;
}
