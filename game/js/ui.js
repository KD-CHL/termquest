// 界面编排 —— 屏幕切换 / 关卡生命周期 / 过关弹窗 / 速查表 / 自由模式
// 这里注入 app.afterCommand 钩子，把"命令执行后该做什么"交给 ui 决定，
// 让 commands.js 保持对界面与关卡判定的零依赖。
import { app } from './state.js';
import { ALL_LEVELS, getCurrentModule, getModules, moduleUnlockedCount, moduleForLevel } from './modules.js';
import { updateCmdCount } from './render.js';
import { print, esc, clearTerm } from './terminal.js';
import { sfxClick, sfxWin, confettiBurst, sfx } from './effects.js';
import { saveProgress } from './store.js';
import { detectNewAchievements, unlockedCountAch } from './achievements.js';

// 顶部轻提示（成就解锁等）
let toastTimer = null;
export function showToast(msg) {
  const t = document.getElementById('toast');
  t.innerHTML = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// 命令执行后的统一回调：渲染面板，必要时检查过关
app.afterCommand = (shouldCheck) => {
  const mod = getCurrentModule();
  if (mod.render) mod.render();
  if (shouldCheck) checkLevel();
};

export function showScreen(name) {
  document.getElementById('screen-home').hidden = name !== 'home';
  document.getElementById('screen-game').hidden = name !== 'game';
}

export function goHome() {
  sfxClick(); app.sandbox = false; showScreen('home'); renderHome();
}

export function renderHome() {
  const done = app.levelStars.filter(s => s > 0).length;
  const stars = app.levelStars.reduce((a, b) => a + b, 0);
  document.getElementById('statDone').textContent = `${done}/${ALL_LEVELS.length}`;
  document.getElementById('statStars').textContent = stars;
  document.getElementById('statCmds').textContent = app.totalCmds;
  document.getElementById('totalStars').textContent = stars;
  document.getElementById('maxStars').textContent = ALL_LEVELS.length * 3;
  const achEl = document.getElementById('achCount');
  if (achEl) achEl.textContent = `已解锁 ${unlockedCountAch()} 枚`;

  // 模块选择器
  const modules = getModules();
  const curMod = getCurrentModule();
  let modHtml = '<div class="module-selector">';
  modules.forEach(m => {
    const active = m.id === curMod.id;
    const mDone = app.levelStars.slice(m.offset, m.offset + m.levels.length).filter(s => s > 0).length;
    modHtml += `<button class="module-card ${active ? 'active' : ''}" style="--mc:${m.color}" onclick="selectModule('${m.id}')">
      <span class="mc-icon">${m.icon}</span><b>${m.name}</b>
      <span class="mc-sub">${mDone}/${m.levels.length} 关</span></button>`;
  });
  modHtml += '</div>';

  // 当前模块的关卡列表
  const mod = curMod;
  const unlocked = moduleUnlockedCount(mod);
  const stages = [...new Set(mod.levels.map(l => l.stage))];
  let html = modHtml;
  stages.forEach(st => {
    html += `<div class="stage-block"><div class="stage-head"><span class="num">${st.split(' ')[0]}</span><h2>${st.split(' ')[1]}</h2><span class="line"></span></div><div class="level-grid">`;
    mod.levels.forEach((lv, li) => {
      if (lv.stage !== st) return;
      const gi = mod.offset + li; // 全局索引
      const locked = li >= unlocked;
      const s = app.levelStars[gi];
      html += `<div class="level-card ${locked ? 'locked' : ''}" onclick="${locked ? '' : `startLevel(${gi})`}">
        ${locked ? '<span class="lc-lock">🔒</span>' : ''}
        <div class="lc-top"><span class="lc-num">LEVEL ${String(li + 1).padStart(2, '0')}</span>
        <span class="lc-stars">${'<span class="star-on">★</span>'.repeat(s)}${'<span class="star-off">★</span>'.repeat(3 - s)}</span></div>
        <h3>${esc(lv.title)}</h3><p>${esc(lv.desc.replace(/<[^>]+>/g, '')).slice(0, 46)}…</p></div>`;
    });
    html += '</div></div>';
  });
  document.getElementById('levelList').innerHTML = html;
}

// 切换模块
export function selectModule(id) {
  const mod = getModules().find(m => m.id === id);
  if (!mod) return;
  app.currentModule = mod;
  app.engine = mod.engine;
  sfx('ui-tab');
  renderHome();
  renderSheet();
}

export function startLevel(i) {
  sfxClick(); app.sandbox = false; app.currentLevel = i; loadLevel(i); showScreen('game');
}

export function loadLevel(i) {
  app.currentLevel = i; const lv = ALL_LEVELS[i];
  const mod = moduleForLevel(i);
  app.currentModule = mod; app.engine = mod.engine;
  lv.setup(app.engine); app.engine.used = new Set(); app.cmdCount = 0; app.levelDoneFlags[i] = false;
  document.getElementById('gbStage').textContent = lv.id;
  document.getElementById('gbTitle').textContent = `第 ${i + 1} 关 · ${lv.title}`;
  document.getElementById('missionTitle').textContent = lv.title;
  document.getElementById('missionDesc').innerHTML = lv.desc;
  document.getElementById('parCount').textContent = lv.par;
  document.getElementById('hintBox').style.display = 'none';
  document.getElementById('hintBox').innerHTML = lv.hints.map(h => '$ ' + esc(h)).join('<br>');
  buildRightPanels(mod);
  updateCmdCount(); mod.render();
  clearTerm();
  print(`═══ 第 ${i + 1} 关 · ${lv.title} ═══`, 'warn');
  print(`目标步数 par = ${lv.par}（用更少命令拿 3 星）`, 'head');
  print('输入 help 查看命令，Tab 自动补全', 'info');
}

// 自由模式：空仓库，随便玩，不计星级
export function startSandbox() {
  sfxClick();
  app.sandbox = true; app.cmdCount = 0;
  const mod = getCurrentModule();
  app.engine = mod.engine;
  app.engine.reset(); app.engine.used = new Set();
  document.getElementById('gbStage').textContent = '🧪';
  document.getElementById('gbTitle').textContent = '自由模式';
  document.getElementById('missionTitle').textContent = '自由模式';
  document.getElementById('missionDesc').innerHTML =
    '一个空仓库，随意练习所有命令：<code>commit</code>、<code>branch</code>、<code>merge</code>、<code>rebase</code>、<code>cherry-pick</code>、<code>stash</code>……' +
    '右侧实时可视化你的操作。进度不计入星级，点左上角返回关卡列表。';
  document.getElementById('parCount').textContent = '—';
  document.getElementById('hintBox').style.display = 'none';
  document.getElementById('hintBox').innerHTML = '';
  buildRightPanels(mod);
  updateCmdCount(); mod.render();
  clearTerm();
  print('═══ 自由模式 ═══', 'warn');
  print('空仓库已就绪，输入 help 查看命令', 'head');
  showScreen('game');
}

export function restartLevel() {
  if (app.sandbox) { startSandbox(); print('已重置为空仓库', 'warn'); return; }
  loadLevel(app.currentLevel); print('本关已重置', 'warn');
}

export function toggleHint() {
  const b = document.getElementById('hintBox');
  b.style.display = b.style.display === 'none' ? 'block' : 'none'; sfxClick();
}

export function starsFor(count, par) {
  if (count <= par) return 3; if (count <= par + 2) return 2; return 1;
}

export function checkLevel() {
  if (app.sandbox) return;                    // 自由模式不判关
  const lv = ALL_LEVELS[app.currentLevel];
  if (app.levelDoneFlags[app.currentLevel]) return;
  if (lv.check(app.engine)) {
    app.levelDoneFlags[app.currentLevel] = true;
    const s = starsFor(app.cmdCount, lv.par);
    app.levelStars[app.currentLevel] = Math.max(app.levelStars[app.currentLevel], s);
    app.totalCmds += app.cmdCount; saveProgress();
    // 过关后检测新成就
    const fresh = detectNewAchievements();
    if (fresh.length) {
      saveProgress();
      fresh.forEach((a, i) => setTimeout(() => { sfx('ui-achievement'); showToast(`🎖️ 解锁成就「${a.icon} ${a.title}」`); }, 900 + i * 1400));
    }
    setTimeout(() => showModal(lv, s), 380);
  }
}

export function showModal(lv, s) {
  const mod = getCurrentModule();
  const isLast = app.currentLevel === mod.offset + mod.levels.length - 1;
  document.getElementById('modalIcon').textContent = isLast ? '🏆' : '🎉';
  document.getElementById('modalTitle').textContent = isLast ? '恭喜本模块全部通关！' : '过关！';
  document.getElementById('modalStars').innerHTML = '<span class="star-on">' + '★'.repeat(s) + '</span><span class="star-off">' + '★'.repeat(3 - s) + '</span>';
  document.getElementById('modalText').textContent = lv.done + `（本关用了 ${app.cmdCount} 步，par ${lv.par}）`;
  document.getElementById('modalBtn').textContent = isLast ? '🔁 重新挑战' : '下一关 →';
  document.getElementById('modal').classList.add('show');
  sfxWin(); confettiBurst();
}

export function closeModal() {
  document.getElementById('modal').classList.remove('show');
}

export function nextLevel() {
  closeModal();
  const mod = getCurrentModule();
  if (app.currentLevel >= mod.offset + mod.levels.length - 1) { goHome(); return; }
  startLevel(app.currentLevel + 1);
}

/* ============ 右侧面板动态构建 ============ */
export function buildRightPanels(mod) {
  const col = document.querySelector('.col-right');
  if (!col) return;
  col.innerHTML = mod.panels.map(p =>
    `<div class="panel ${p.grow ? 'grow' : ''}">
      <div class="panel-h"><span class="ph-dot" style="background:${p.dot}"></span> ${p.title}</div>
      <div class="panel-body" id="${p.id}" ${p.maxHeight ? `style="max-height:${p.maxHeight}"` : ''}></div>
    </div>`
  ).join('');
}

/* ============ 速查表 ============ */
export function renderSheet() {
  const mod = getCurrentModule();
  const sheet = mod.sheet || [];
  document.getElementById('sheetGrid').innerHTML = sheet.map(([t, cmds]) =>
    `<div class="sh-group"><h4>${t}</h4>${cmds.map(c => {
      const sp = c.indexOf(' '); const name = sp > 0 ? c.slice(0, sp) : c; const arg = sp > 0 ? c.slice(sp) : '';
      return `<div class="sh-cmd"><span class="c">${esc(name)}</span><span class="d">${esc(arg)}</span></div>`;
    }).join('')}</div>`).join('');
}

export function toggleSheet() {
  const o = document.getElementById('sheetOverlay');
  o.classList.toggle('show'); sfxClick();
}
