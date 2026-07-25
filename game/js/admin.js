// 管理面板 —— 仅 admin 可访问：用户统计 / 进度一览 / 角色管理 / 删除用户
import { requireAdmin, getToken, logout } from './auth.js';
import { ALL_LEVELS } from './modules.js';

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
  return data;
}

const TOTAL_LEVELS = ALL_LEVELS.length, MAX_STARS = TOTAL_LEVELS * 3;
let me = null;
let allUsers = [];

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function stars(u) { return (u.progress?.levelStars || []).reduce((a, b) => a + b, 0); }
function doneCount(u) { return (u.progress?.levelStars || []).filter(s => s > 0).length; }

function renderStats() {
  const players = allUsers.filter(u => u.role === 'player').length;
  const admins = allUsers.filter(u => u.role === 'admin').length;
  const totalStars = allUsers.reduce((a, u) => a + stars(u), 0);
  const totalCmds = allUsers.reduce((a, u) => a + (u.progress?.totalCmds || 0), 0);
  document.getElementById('stats').innerHTML = [
    ['👥', allUsers.length, '总用户'],
    ['🎮', players, '玩家'],
    ['🛡️', admins, '管理员'],
    ['⭐', totalStars, '累计星星'],
    ['⌨️', totalCmds, '累计命令'],
  ].map(([icon, v, label]) =>
    `<div class="stat-card"><div class="sc-icon">${icon}</div><b>${v}</b><span>${label}</span></div>`).join('');
}

function renderTable() {
  const tbody = document.getElementById('userRows');
  if (!allUsers.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">暂无用户</td></tr>'; return; }
  tbody.innerHTML = allUsers.map(u => {
    const s = stars(u), done = doneCount(u);
    const pct = Math.round(s / MAX_STARS * 100);
    const isSelf = u.id === me.id;
    return `<tr>
      <td class="u-name">${esc(u.username)}${isSelf ? ' <span class="me-tag">我</span>' : ''}</td>
      <td><span class="role-badge ${u.role}">${u.role === 'admin' ? '管理员' : '玩家'}</span></td>
      <td>${done}/${TOTAL_LEVELS}</td>
      <td class="u-stars">${'★'.repeat(Math.min(s, 5))}${s > 5 ? '…' : ''} <b>${s}</b></td>
      <td>
        <div class="prog"><div class="prog-fill" style="width:${pct}%"></div></div>
      </td>
      <td>${u.progress?.totalCmds || 0}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td class="u-actions">
        ${isSelf ? '<span class="dim">—</span>' : `
          <button class="mini-btn" onclick="toggleRole('${u.id}','${u.role === 'admin' ? 'player' : 'admin'}')">${u.role === 'admin' ? '设为玩家' : '设为管理员'}</button>
          <button class="mini-btn danger" onclick="removeUser('${u.id}','${esc(u.username)}')">删除</button>`}
      </td>
    </tr>`;
  }).join('');
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function load() {
  try {
    const data = await api('/api/admin/users');
    allUsers = data.users;
    renderStats(); renderTable();
  } catch (e) {
    document.getElementById('userRows').innerHTML = `<tr><td colspan="8" class="empty">加载失败：${esc(e.message)}</td></tr>`;
  }
}

window.toggleRole = async function (id, newRole) {
  try { await api(`/api/admin/users/${id}/role`, { method: 'POST', body: { role: newRole } }); load(); }
  catch (e) { alert(e.message); }
};

window.removeUser = async function (id, name) {
  if (!confirm(`确定删除用户「${name}」？此操作不可恢复。`)) return;
  try { await api(`/api/admin/users/${id}`, { method: 'DELETE' }); load(); }
  catch (e) { alert(e.message); }
};

window.adminLogout = async function () {
  await logout();
  location.href = './login.html';
};

(async function init() {
  me = await requireAdmin();
  if (!me) return;
  document.getElementById('adminName').textContent = me.username;
  load();
})();
