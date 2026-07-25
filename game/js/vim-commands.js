// Vim 命令集 —— 模态编辑：normal / insert / command(:)
// 未在 vim 中时，vim <文件> 打开编辑器，其余命令委托 linuxExecute。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

export function vimExecute(input) {
  input = input.trim();
  if (!input) return;
  const e = E();

  // ── 未在 vim 中 ──
  if (!e.vim) {
    const base = input.split(/\s/)[0];
    if (base === 'vim' || base === 'vi') {
      printCmd(input);
      app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
      track('vim'); e.used.add('vim');
      const file = tokenize(input)[1];
      if (!file) { print('用法: vim <文件名>', 'err'); sfx('err-syntax'); after(false); return; }
      e.openVim(file);
      sfx('ui-open');
      print(`── 打开 ${file} ──`, 'head');
      print('模式: NORMAL · i 插入 / o 下方新行 / dd 删行 / yy 复制 / p 粘贴 / :wq 保存退出', 'info');
      after(true); return;
    }
    if (base === 'help') { printCmd(input); showVimHelp(); return; }
    linuxExecute(input);
    return;
  }

  // ── 在 vim 中：作为按键处理 ──
  const v = e.vim;
  printCmd(input);

  // Esc
  if (/^(esc|<esc>|\x1b)$/i.test(input)) {
    if (v.mode === 'insert') { v.mode = 'normal'; v.msg = ''; print('-- NORMAL --', 'info'); }
    after(true); return;
  }

  if (v.mode === 'insert') {
    insertInput(v, input);
    sfx('file-write');
    after(true); return;
  }

  // 命令模式（以 : 开头）
  if (input.startsWith(':')) {
    handleCommand(v, input.slice(1), e);
    return;
  }

  // 查找
  if (input.startsWith('/')) {
    v.search = input.slice(1);
    const found = findSearch(v, 1);
    v.msg = found ? `/${v.search} → 第 ${v.row + 1} 行` : `未找到: ${v.search}`;
    print(v.msg, found ? 'ok' : 'err');
    track('/'); e.used.add('vim-search');
    after(true); return;
  }
  if (input === 'n' || input === 'N') {
    if (!v.search) { print('E35: 无搜索模式（先用 /模式 搜索）', 'err'); after(false); return; }
    findSearch(v, input === 'n' ? 1 : -1);
    v.msg = `第 ${v.row + 1} 行`;
    after(true); return;
  }

  // NORMAL 模式按键
  handleNormal(v, input, e);
}

/* ============ 插入模式：每行输入作为新行 ============ */
function insertInput(v, text) {
  if ((v.lines[v.row] || '').trim() === '') {
    v.lines[v.row] = text;           // 填充空行
  } else {
    v.lines.splice(v.row + 1, 0, text);
    v.row++;
  }
  v.col = text.length;
  v.modified = true;
}

/* ============ NORMAL 模式 ============ */
function handleNormal(v, input, e) {
  let s = input.trim();
  const m = s.match(/^(\d*)(.*)$/);
  let count = parseInt(m[1]) || 1;
  let cmd = m[2];
  if (!cmd) { after(false); return; }

  // 多字符命令
  if (cmd === 'gg') { v.row = count > 1 ? count - 1 : 0; v.col = 0; clamp(v); v.msg = `第 ${v.row + 1} 行`; after(true); return; }
  if (cmd === 'dd') {
    const del = v.lines.splice(v.row, count);
    if (!v.lines.length) v.lines = [''];
    v.yank = del; v.modified = true; v.col = 0; clamp(v);
    v.msg = `删除 ${del.length} 行`; sfx('file-delete'); track('dd'); e.used.add('vim-dd'); after(true); return;
  }
  if (cmd === 'yy') {
    v.yank = v.lines.slice(v.row, v.row + count);
    v.msg = `复制 ${v.yank.length} 行`; sfx('file-copy'); track('yy'); e.used.add('vim-yy'); after(true); return;
  }
  if (cmd === 'cc') {
    v.yank = v.lines.splice(v.row, count);
    if (!v.lines.length) v.lines = [''];
    v.lines.splice(v.row, 0, '');
    v.col = 0; v.modified = true; v.mode = 'insert';
    v.msg = '-- INSERT --'; sfx('file-delete'); track('cc'); e.used.add('vim-cc'); after(true); return;
  }

  // 单字符命令（count 生效）
  for (let i = 0; i < count; i++) {
    if (!applyKey(v, cmd, e)) break;
  }
  clamp(v);
  after(true);
}

function applyKey(v, cmd, e) {
  const line = () => v.lines[v.row] || '';
  switch (cmd) {
    case 'h': v.col = Math.max(0, v.col - 1); return true;
    case 'l': v.col = Math.min(Math.max(0, line().length - 1), v.col + 1); return true;
    case 'j': if (v.row < v.lines.length - 1) v.row++; return true;
    case 'k': if (v.row > 0) v.row--; return true;
    case '0': v.col = 0; return true;
    case '$': v.col = Math.max(0, line().length - 1); return true;
    case '^': v.col = line().search(/\S/); if (v.col < 0) v.col = 0; return true;
    case 'G': v.row = v.lines.length - 1; return true;
    case 'w': { const idx = line().slice(v.col + 1).search(/\S/); v.col = idx >= 0 ? v.col + 1 + idx : line().length; return true; }
    case 'x': {
      const l = line();
      if (l.length) { v.lines[v.row] = l.slice(0, v.col) + l.slice(v.col + 1); v.modified = true; sfx('file-delete'); track('x'); e.used.add('vim-x'); }
      return true;
    }
    case 'D': { v.yank = [line().slice(v.col)]; v.lines[v.row] = line().slice(0, v.col); v.modified = true; sfx('file-delete'); track('D'); e.used.add('vim-D'); return true; }
    case 'p': {
      if (!v.yank.length) { v.msg = '寄存器为空（先 yy 复制）'; return false; }
      v.lines.splice(v.row + 1, 0, ...v.yank);
      v.row += v.yank.length; v.modified = true; v.msg = `粘贴 ${v.yank.length} 行`;
      sfx('file-copy'); track('p'); e.used.add('vim-p'); return true;
    }
    case 'P': {
      if (!v.yank.length) { v.msg = '寄存器为空（先 yy 复制）'; return false; }
      v.lines.splice(v.row, 0, ...v.yank); v.modified = true;
      sfx('file-copy'); track('P'); e.used.add('vim-P'); return true;
    }
    case 'i': v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); return true;
    case 'a': v.col = Math.min(line().length, v.col + 1); v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); return true;
    case 'I': v.col = 0; v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); return true;
    case 'A': v.col = line().length; v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); return true;
    case 'o': v.lines.splice(v.row + 1, 0, ''); v.row++; v.col = 0; v.mode = 'insert'; v.modified = true; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); return true;
    case 'O': v.lines.splice(v.row, 0, ''); v.col = 0; v.mode = 'insert'; v.modified = true; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); return true;
    default:
      v.msg = `未知按键: ${cmd}`;
      return false;
  }
}

/* ============ 命令模式 ============ */
function handleCommand(v, cmd, e) {
  cmd = cmd.trim();
  let m;
  // :wq / :x / ZZ
  if (cmd === 'wq' || cmd === 'x') {
    e.saveVim();
    const f = v.file;
    e.closeVim();
    sfx('file-write');
    print(`"${e.basename(f)}" 已保存并退出`, 'ok');
    track(':wq'); e.used.add('vim-wq'); e.lastOut = 'saved'; after(true); return;
  }
  if (cmd === 'w') {
    e.saveVim();
    print(`"${e.basename(v.file)}" ${v.lines.length}L, ${v.lines.join('\n').length}C 已写入`, 'ok');
    sfx('file-write'); track(':w'); e.used.add('vim-w'); after(true); return;
  }
  if (cmd === 'q') {
    if (v.modified) { print('E37: 未保存更改（用 :wq 保存或 :q! 放弃）', 'err'); sfx('err-syntax'); after(false); return; }
    e.closeVim(); print('已退出 vim', 'info'); sfx('ui-close'); track(':q'); e.used.add('vim-q'); after(true); return;
  }
  if (cmd === 'q!') {
    e.closeVim(); print('已放弃更改并退出', 'info'); sfx('ui-close'); track(':q!'); e.used.add('vim-q'); after(true); return;
  }
  // :%s/old/new/g 与 :s/old/new/g
  if ((m = cmd.match(/^%?s\/(.*)\/(.*)\/(g?)$/))) {
    const [, pat, rep, g] = m;
    const whole = cmd.startsWith('%');
    let n = 0;
    const re = new RegExp(escapeRe(pat), g === 'g' ? 'g' : '');
    if (whole) {
      v.lines = v.lines.map(l => { const nl = l.replace(re, rep); if (nl !== l) n++; return nl; });
    } else {
      const nl = (v.lines[v.row] || '').replace(re, rep);
      if (nl !== v.lines[v.row]) n = 1;
      v.lines[v.row] = nl;
    }
    v.modified = true;
    print(`${n} 处替换`, 'ok'); sfx('file-write'); track(':s'); e.used.add('vim-sub'); after(true); return;
  }
  // :set number / nonumber
  if ((m = cmd.match(/^set\s+(number|nu|nonumber|nonu)$/))) {
    v.number = m[1] === 'number' || m[1] === 'nu';
    print(v.number ? '已显示行号' : '已隐藏行号', 'info'); after(true); return;
  }
  // :e file
  if ((m = cmd.match(/^e(?:dit)?\s+(\S+)$/))) {
    if (v.modified) { print('E37: 未保存更改（先 :w）', 'err'); after(false); return; }
    e.openVim(m[1]);
    print(`── 打开 ${m[1]} ──`, 'head'); track(':e'); e.used.add('vim-e'); after(true); return;
  }
  // :N 跳转行号
  if ((m = cmd.match(/^(\d+)$/))) {
    v.row = Math.min(parseInt(m[1]) - 1, v.lines.length - 1); v.col = 0; clamp(v);
    v.msg = `第 ${v.row + 1} 行`; after(true); return;
  }
  print(`E492: 不是编辑器命令: ${cmd}`, 'err'); sfx('err-syntax'); after(false);
}

/* ============ 查找 ============ */
function findSearch(v, dir) {
  const n = v.lines.length;
  for (let step = 1; step <= n; step++) {
    const r = (v.row + dir * step + n * step) % n;
    const idx = (v.lines[r] || '').indexOf(v.search);
    if (idx >= 0) { v.row = r; v.col = idx; return true; }
  }
  return false;
}

function clamp(v) {
  v.row = Math.max(0, Math.min(v.row, v.lines.length - 1));
  const len = (v.lines[v.row] || '').length;
  v.col = Math.max(0, Math.min(v.col, Math.max(0, len - 1)));
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function showVimHelp() {
  ['── 打开 / 退出 ──',
    '  vim <文件> · :w 保存 · :q 退出 · :wq 保存退出 · :q! 放弃退出',
    '── 模式切换 ──',
    '  i 光标前插入 · a 光标后插入 · o 下方新行 · O 上方新行 · Esc 回到 NORMAL',
    '── 移动（NORMAL）──',
    '  h j k l 左右上下 · 0 行首 · $ 行尾 · gg 文件头 · G 文件尾 · 3G 第3行',
    '── 编辑（NORMAL）──',
    '  x 删字符 · dd 删行 · 3dd 删3行 · yy 复制行 · p 粘贴 · D 删到行尾 · cc 改行',
    '── 查找替换 ──',
    '  /模式 搜索 · n 下一个 · :s/旧/新/g 替换本行 · :%s/旧/新/g 替换全文',
    '── 其余 ──',
    '  :set number 显示行号 · :e 文件 切换文件 · ls / cat 照常可用',
  ].forEach(l => print(l, 'info'));
}
