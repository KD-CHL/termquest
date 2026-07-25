// Vim 模块渲染 —— 编辑器缓冲区面板（带光标与行号）+ 文件树
import { app } from './state.js';
import { updatePrompt } from './terminal.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function vimRender() {
  const e = app.engine;
  if (!e || !e.root) return;
  renderBuffer(e);
  renderTree(e);
  updatePrompt();
}

function renderBuffer(e) {
  const box = document.getElementById('vimBox');
  if (!box) return;
  const v = e.vim;
  if (!v) {
    box.innerHTML = '<div class="empty-note">未打开 vim —— 输入 <b>vim 文件名</b> 开始编辑</div>';
    return;
  }
  const modeTag = v.mode === 'insert'
    ? '<span class="vim-mode ins">-- INSERT --</span>'
    : '<span class="vim-mode">-- NORMAL --</span>';
  const lines = v.lines.map((l, i) => {
    const num = v.number ? `<span class="vim-ln">${String(i + 1).padStart(3)} </span>` : '';
    let text = esc(l) || '<span class="vim-tilde">~</span>';
    if (i === v.row) {
      // 高亮光标所在行，并用 ▍ 标记光标列
      const before = esc(l.slice(0, v.col));
      const cur = esc(l.slice(v.col, v.col + 1)) || ' ';
      const after = esc(l.slice(v.col + 1));
      text = `${before}<span class="vim-cursor">${cur}</span>${after}`;
    }
    return `<div class="vim-line ${i === v.row ? 'cur' : ''}">${num}${text}</div>`;
  }).join('');
  const status = `${esc(e.basename(v.file))}${v.modified ? ' [+]' : ''}  ${v.lines.length} 行 · 光标 ${v.row + 1},${v.col + 1}`;
  box.innerHTML =
    `<div class="vim-head">📝 ${esc(e.basename(v.file))} ${modeTag}</div>` +
    `<div class="vim-body">${lines}</div>` +
    `<div class="vim-status">${status}${v.msg ? ' · ' + esc(v.msg) : ''}</div>`;
}

function renderTree(e) {
  const box = document.getElementById('vimTree');
  if (!box) return;
  const lines = e.treeLines(e.cwd, 3);
  const cwdShort = e.cwd.replace(e.env.HOME, '~');
  if (!lines.length) { box.innerHTML = `<div class="empty-note">${esc(cwdShort)} 是空目录</div>`; return; }
  box.innerHTML =
    `<div class="tree-cwd">📂 ${esc(cwdShort)}</div>` +
    `<pre class="tree-pre">${lines.map(l => esc(l)).join('\n')}</pre>`;
}
