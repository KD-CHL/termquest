// Kubernetes 模块渲染 —— Pod 列表 + Deployment/Service + 节点
import { app } from './state.js';
import { updatePrompt } from './terminal.js';

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function k8sRender() {
  const e = app.engine;
  if (!e || !e.pods) return;
  renderPods(e);
  renderDeploys(e);
  renderNodes(e);
  updatePrompt();
}

function renderPods(e) {
  const box = document.getElementById('k8sBox');
  if (!box) return;
  if (!e.pods.length) {
    box.innerHTML = '<div class="empty-note">没有 Pod —— kubectl create deployment / apply 创建一个</div>';
    return;
  }
  const rows = e.pods.map(p => {
    const ok = p.status === 'Running';
    const warn = /Crash|Error|ImagePull/.test(p.status);
    return `<div class="proc-row">
      <span class="proc-pid">${esc(p.name.slice(-8))}</span>
      <span class="proc-name">${esc(p.name)}</span>
      <span class="proc-state ${ok ? 'run' : warn ? 'err' : 'slp'}">${esc(p.status)}</span>
      <span class="proc-cpu">${esc(p.ready)} · ${esc(p.node)}</span>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="proc-head"><span>ID</span><span>Pod</span><span>状态</span><span>就绪/节点</span></div>` + rows;
}

function renderDeploys(e) {
  const box = document.getElementById('k8sDeploys');
  if (!box) return;
  const parts = [];
  if (e.deployments.length) {
    parts.push('<div class="tree-cwd">☸ Deployments</div>');
    parts.push(e.deployments.map(d => {
      const ready = e.podsOfDeployment(d.name, d.namespace).filter(p => p.status === 'Running').length;
      return `<div class="img-item"><div class="img-name">🚀 ${esc(d.name)} <span class="img-meta">${ready}/${d.replicas} · ${esc(d.image)}</span></div></div>`;
    }).join(''));
  }
  if (e.services.length) {
    parts.push('<div class="tree-cwd">🔗 Services</div>');
    parts.push(e.services.map(s =>
      `<div class="img-item"><div class="img-name">🌐 ${esc(s.name)} <span class="img-meta">${esc(s.type)} · ${s.port}→${esc(s.selector)}</span></div></div>`
    ).join(''));
  }
  box.innerHTML = parts.length ? parts.join('') : '<div class="empty-note">没有 Deployment / Service</div>';
}

function renderNodes(e) {
  const box = document.getElementById('k8sNodes');
  if (!box) return;
  box.innerHTML = e.nodes.map(n =>
    `<div class="proc-row">
      <span class="proc-name">${esc(n.name)}</span>
      <span class="proc-state ${n.status === 'Ready' ? 'run' : 'err'}">${esc(n.status)}</span>
      <span class="proc-cpu">${esc(n.roles)} · ${n.cpu}C/${n.mem}</span>
    </div>`
  ).join('');
}
