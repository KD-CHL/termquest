// 三个数据面板 —— 排行榜 / 个人统计 / 成就墙
// 都以模态框形式打开，数据来自后端（排行榜）或本地 app 状态（统计/成就）。
import { app } from './state.js';
import { ALL_LEVELS, getModules } from './modules.js';
import { getToken } from './auth.js';
import { ACHIEVEMENTS, computeUnlocked } from './achievements.js';
import { showToast } from './ui.js';
import { sfx } from './effects.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function api(path) {
  const headers = {};
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(path, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('请求失败 (' + res.status + ')'));
  return data;
}

const open = id => { sfx('ui-open'); document.getElementById(id).classList.add('show'); };
const close = id => { sfx('ui-close'); document.getElementById(id).classList.remove('show'); };

/* ============ 排行榜 ============ */
export function openLeaderboard() {
  open('lbOverlay');
  const body = document.getElementById('lbBody');
  body.innerHTML = '<div class="pm-loading">加载中…</div>';
  api('/api/leaderboard').then(({ leaderboard, myRank }) => {
    if (!leaderboard.length) { body.innerHTML = '<div class="pm-empty">还没有玩家上榜</div>'; return; }
    const medals = ['🥇', '🥈', '🥉'];
    body.innerHTML = `
      <div class="lb-my">我的排名：<b>第 ${myRank} 名</b></div>
      <table class="lb-table"><thead><tr><th>#</th><th>玩家</th><th>星星</th><th>通关</th><th>命令数</th></tr></thead><tbody>
      ${leaderboard.map((r, i) => `
        <tr class="${app.currentUser && r.id === app.currentUser.id ? 'me' : ''}">
          <td class="lb-rank">${medals[i] || i + 1}</td>
          <td class="lb-name">${esc(r.username)}</td>
          <td class="lb-stars">★ ${r.stars}</td>
          <td>${r.done}/${ALL_LEVELS.length}</td>
          <td class="lb-dim">${r.totalCmds}</td>
        </tr>`).join('')}
      </tbody></table>`;
  }).catch(e => { body.innerHTML = `<div class="pm-empty">加载失败：${esc(e.message)}</div>`; });
}
export function closeLeaderboard() { close('lbOverlay'); }

/* ============ 个人统计 ============ */
export function openStats() {
  open('statsOverlay');
  const u = app.currentUser;
  document.getElementById('statsUser').textContent = u ? `玩家：${u.username}` : '';
  const body = document.getElementById('statsBody');

  const done = app.levelStars.filter(s => s > 0).length;
  const stars = app.levelStars.reduce((a, b) => a + b, 0);
  const maxStars = ALL_LEVELS.length * 3;
  const pct = Math.round(done / ALL_LEVELS.length * 100);

  // 进度环（SVG）
  const R = 52, C = 2 * Math.PI * R;
  const ring = `
    <div class="st-ring">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--border)" stroke-width="10"/>
        <circle cx="70" cy="70" r="${R}" fill="none" stroke="url(#g)" stroke-width="10" stroke-linecap="round"
          stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct / 100)}" transform="rotate(-90 70 70)"/>
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3fb950"/><stop offset="100%" stop-color="#2dd4bf"/>
        </linearGradient></defs>
      </svg>
      <div class="st-ring-txt"><b>${pct}%</b><span>通关进度</span></div>
    </div>`;

  // 各模块进度
  const moduleRows = getModules().map(m => {
    const slice = app.levelStars.slice(m.offset, m.offset + m.levels.length);
    const mDone = slice.filter(s => s > 0).length;
    const w = Math.round(mDone / m.levels.length * 100);
    return `<div class="st-stage">
      <span class="st-name">${m.icon} ${esc(m.name)}</span>
      <div class="st-bar"><div class="st-fill" style="width:${w}%;background:linear-gradient(90deg,${m.color},${m.color}99)"></div></div>
      <span class="st-val">${mDone}/${m.levels.length}</span>
    </div>`;
  }).join('');

  // 各阶段星级分布
  const stages = [...new Set(ALL_LEVELS.map(l => l.stage))];
  const stageRows = stages.map(st => {
    const idx = ALL_LEVELS.map((l, i) => (l.stage === st ? i : -1)).filter(i => i >= 0);
    const got = idx.reduce((a, i) => a + (app.levelStars[i] || 0), 0);
    const total = idx.length * 3;
    const w = Math.round(got / total * 100);
    return `<div class="st-stage">
      <span class="st-name">${esc(st)}</span>
      <div class="st-bar"><div class="st-fill" style="width:${w}%"></div></div>
      <span class="st-val">${got}/${total}</span>
    </div>`;
  }).join('');

  // 命令频次 Top 8
  const usage = Object.entries(app.cmdUsage).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxUse = usage.length ? usage[0][1] : 1;
  const usageRows = usage.length
    ? usage.map(([cmd, n]) => `<div class="st-cmd">
        <span class="st-cmd-name">${esc(cmd)}</span>
        <div class="st-bar"><div class="st-fill alt" style="width:${Math.round(n / maxUse * 100)}%"></div></div>
        <span class="st-val">${n}</span>
      </div>`).join('')
    : '<div class="pm-empty">还没有命令记录，快去敲几条吧</div>';

  body.innerHTML = `
    <div class="st-top">
      ${ring}
      <div class="st-nums">
        <div class="st-num"><b>${done}/${ALL_LEVELS.length}</b><span>已通关</span></div>
        <div class="st-num"><b>${stars}/${maxStars}</b><span>星星</span></div>
        <div class="st-num"><b>${app.totalCmds}</b><span>累计命令</span></div>
        <div class="st-num"><b>${computeUnlocked({ levelStars: app.levelStars, totalCmds: app.totalCmds, cmdUsage: app.cmdUsage }).length}/${ACHIEVEMENTS.length}</b><span>成就</span></div>
      </div>
    </div>
    <h4 class="st-h">模块进度</h4>${moduleRows}
    <h4 class="st-h">各阶段星级</h4>${stageRows}
    <h4 class="st-h">常用命令 Top 8</h4>${usageRows}`;
}
export function closeStats() { close('statsOverlay'); }

/* ============ 成就墙 ============ */
export function openAchievements() {
  open('achOverlay');
  const unlocked = new Set(computeUnlocked({ levelStars: app.levelStars, totalCmds: app.totalCmds, cmdUsage: app.cmdUsage }));
  document.getElementById('achSub').textContent = `已解锁 ${unlocked.size} / ${ACHIEVEMENTS.length} 枚徽章`;
  document.getElementById('achBody').innerHTML = ACHIEVEMENTS.map(a => {
    const on = unlocked.has(a.id);
    return `<div class="ach-card ${on ? 'on' : ''}">
      <div class="ach-icon">${on ? a.icon : '🔒'}</div>
      <b>${esc(a.title)}</b>
      <span>${esc(a.desc)}</span>
    </div>`;
  }).join('');
}
export function closeAchievements() { close('achOverlay'); }
