// Linux 模块渲染 —— 文件树面板 + 进程表面板
import { app } from './state.js';
import { updatePrompt } from './terminal.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function linuxRender() {
  const e = app.engine;
  if (!e || !e.root) return;
  renderFileTree(e);
  renderProcTable(e);
  updatePrompt();
}

function renderFileTree(e) {
  const box = document.getElementById('linuxTree');
  if (!box) return;
  const lines = e.treeLines(e.cwd, 3);
  const cwdShort = e.cwd.replace(e.env.HOME, '~');
  if (!lines.length) {
    box.innerHTML = `<div class="empty-note">${esc(cwdShort)} 是空目录</div>`;
    return;
  }
  box.innerHTML =
    `<div class="tree-cwd">📂 ${esc(cwdShort)}</div>` +
    `<pre class="tree-pre">${lines.map(l => esc(l)).join('\n')}</pre>`;
}

function renderProcTable(e) {
  const box = document.getElementById('linuxProcs');
  if (!box) return;
  if (!e.procs.length) {
    box.innerHTML = '<div class="empty-note">没有运行中的进程</div>';
    return;
  }
  const rows = e.procs.map(p => {
    const stateCls = p.state === 'R' ? 'run' : p.state === 'Z' ? 'zom' : 'slp';
    const owner = p.name === 'init' || p.name === 'sshd' ? 'root' : 'user';
    return `<div class="proc-row">
      <span class="proc-pid">${p.pid}</span>
      <span class="proc-name">${esc(p.name)}</span>
      <span class="proc-state ${stateCls}">${p.state}</span>
      <span class="proc-cpu">${p.cpu}%</span>
    </div>`;
  }).join('');
  box.innerHTML =
    `<div class="proc-head"><span>PID</span><span>命令</span><span>状态</span><span>CPU</span></div>` + rows +
    (e.jobs.length ? `<div class="proc-jobs">${e.jobs.map(j => `[${j.jid}] ${esc(j.cmd)} (${j.state})`).join('<br>')}</div>` : '');
}
