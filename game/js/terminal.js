// 终端输出 —— 负责把命令与结果渲染到左侧终端区域
import { G, app } from './state.js';

const termEl = document.getElementById('terminal');

export function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function promptText() {
  const mod = app.currentModule;
  if (mod && mod.prompt) return mod.prompt(app.engine || G);
  return `termquest (${G.headBranch || 'detached'}) $`;
}

export function printCmd(s) {
  termEl.insertAdjacentHTML('beforeend',
    `<div class="line cmd"><span class="prompt">${esc(promptText())}</span> ${esc(s)}</div>`);
  scrollT();
}

export function print(s, cls) {
  termEl.insertAdjacentHTML('beforeend', `<div class="line ${cls || 'out'}">${esc(s)}</div>`);
  scrollT();
}

export function scrollT() {
  termEl.scrollTop = termEl.scrollHeight;
}

export function clearTerm() {
  termEl.innerHTML = '';
}

export function updatePrompt() {
  document.getElementById('promptLabel').textContent = promptText();
}
