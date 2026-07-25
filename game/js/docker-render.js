// Docker 模块渲染 —— 容器表 + 镜像层 + 本地文件树 + SSH 状态
import { app } from './state.js';
import { updatePrompt } from './terminal.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function dockerRender() {
  const e = app.engine;
  if (!e || !e.containers) return;
  renderContainers(e);
  renderImages(e);
  renderTree(e);
  updatePrompt();
}

function renderContainers(e) {
  const box = document.getElementById('dockerBox');
  if (!box) return;
  const ssh = e.sshHost
    ? `<div class="ssh-banner">🔗 SSH 会话：${esc(e.sshHost)}（输入 <b>exit</b> 断开）</div>` : '';
  if (!e.containers.length) {
    box.innerHTML = ssh + '<div class="empty-note">没有容器 —— docker run / docker-compose up 创建一个</div>';
    return;
  }
  const rows = e.containers.map(c => {
    const run = c.status === 'running';
    return `<div class="proc-row">
      <span class="proc-pid">${c.id.slice(0, 6)}</span>
      <span class="proc-name">${esc(c.name)}</span>
      <span class="proc-state ${run ? 'run' : 'slp'}">${run ? 'Up' : 'Exited'}</span>
      <span class="proc-cpu">${esc(c.ports.join(',') || c.image.split(':')[0].slice(-8))}</span>
    </div>`;
  }).join('');
  box.innerHTML = ssh +
    `<div class="proc-head"><span>ID</span><span>名称</span><span>状态</span><span>端口/镜像</span></div>` + rows;
}

function renderImages(e) {
  const box = document.getElementById('dockerImages');
  if (!box) return;
  if (!e.images.length) {
    box.innerHTML = '<div class="empty-note">没有镜像 —— docker pull 或 docker build 创建</div>';
    return;
  }
  box.innerHTML = e.images.map(i =>
    `<div class="img-item">
      <div class="img-name">📦 ${esc(i.repo)}<span class="img-tag">:${esc(i.tag)}</span>
        <span class="img-meta">${i.id.slice(0, 6)} · ${i.size}MB</span></div>
      <div class="img-layers">${i.layers.map(l => `<span class="img-layer">${esc(l)}</span>`).join('')}</div>
    </div>`
  ).join('');
}

function renderTree(e) {
  const box = document.getElementById('dockerTree');
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
