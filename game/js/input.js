// 输入交互 —— 命令补全 / 历史记录 / 快捷键
import { G, app } from './state.js';
import { getCurrentModule } from './modules.js';
import { esc } from './terminal.js';
import { toggleSheet } from './ui.js';

let input, sg;
let sgList = [], sgIdx = -1;
const history = []; let histIdx = -1;

function buildSuggestions(v) {
  const mod = getCurrentModule();
  const cmds = mod.cmds || [];
  const engine = app.engine || G;
  const files = engine.files ? Object.keys(engine.files).map(f => 'cat ' + f).concat(Object.keys(engine.files)) : [];
  const pool = [...cmds, ...files];
  if (!v.trim()) return [];
  return pool.filter(c => c.startsWith(v) && c !== v).slice(0, 6);
}

function renderSuggest() {
  if (!sgList.length) { sg.classList.remove('show'); return; }
  sg.innerHTML = sgList.map((c, i) =>
    `<div class="sg-item ${i === sgIdx ? 'active' : ''}" onmousedown="applySuggest(${i})">${esc(c)}<span class="sg-hint">Tab</span></div>`).join('');
  sg.classList.add('show');
}

export function applySuggest(i) {
  input.value = sgList[i]; sg.classList.remove('show'); input.focus();
}

export function initInput() {
  input = document.getElementById('cmdInput');
  sg = document.getElementById('suggest');

  input.addEventListener('input', () => {
    sgList = buildSuggestions(input.value); sgIdx = sgList.length ? 0 : -1; renderSuggest();
  });
  input.addEventListener('blur', () => setTimeout(() => sg.classList.remove('show'), 150));

  input.addEventListener('keydown', e => {
    if (e.key === 'Tab') { e.preventDefault(); if (sgList.length) applySuggest(sgIdx < 0 ? 0 : sgIdx); return; }
    if (e.key === 'Escape') { sg.classList.remove('show'); return; }
    if (sg.classList.contains('show') && sgList.length > 1 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      sgIdx = e.key === 'ArrowDown' ? (sgIdx + 1) % sgList.length : (sgIdx - 1 + sgList.length) % sgList.length;
      renderSuggest(); return;
    }
    if (e.key === 'Enter') {
      const v = input.value;
      if (v.trim()) { history.unshift(v); histIdx = -1; sg.classList.remove('show'); getCurrentModule().execute(v); }
      input.value = ''; return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histIdx < history.length - 1) { histIdx++; input.value = history[histIdx]; sg.classList.remove('show'); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx > 0) { histIdx--; input.value = history[histIdx]; } else { histIdx = -1; input.value = ''; }
      sg.classList.remove('show');
    }
  });

  // 游戏界面按 ? 打开速查表
  document.addEventListener('keydown', e => {
    if (e.key === '?' && !document.getElementById('screen-game').hidden && document.activeElement !== input) toggleSheet();
  });

  // 点击空白处自动聚焦输入框
  document.addEventListener('click', e => {
    if (!e.target.closest('button') && !e.target.closest('.overlay') && document.activeElement !== input
      && !document.getElementById('screen-game').hidden) input.focus();
  });
}
