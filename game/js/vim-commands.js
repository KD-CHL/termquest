// Vim 命令集 —— 模态编辑：normal / insert / visual / command(:)
// 未在 vim 中时，vim <文件> 打开编辑器，其余命令委托 linuxExecute。
// 第 2 轮增强：可视模式、计数前缀、寄存器和标记、. 重复、缩进/合并/格式化、
//   屏幕移动 H/M/L、翻页 kd/ku、段落 {/}、括号匹配 %、:g/:v/:r/:!/:noh/:bn/:bp 等。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

// 可视模式估计的屏幕高度（H/M/L 与翻页用）
const SCREEN_H = 20;

// . 重复：记录上一次"编辑动作"的按键序列（含插入文本与 Esc）
let lastEdit = null;   // 例如 ['dd'] 或 ['cw', 'blue', 'Esc']
let _rec = null;       // 正在录制的序列（null = 未录制）

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
      print('模式: NORMAL · i 插入 / o 下方新行 / v 可视 / dd 删行 / yy 复制 / p 粘贴 / :wq 保存退出', 'info');
      after(true); return;
    }
    if (base === 'help') { printCmd(input); showVimHelp(); return; }
    linuxExecute(input);
    return;
  }

  // ── 在 vim 中：作为按键处理 ──
  const v = e.vim;
  printCmd(input);

  // Esc —— 退出插入 / 可视模式
  if (/^(esc|<esc>|\x1b)$/i.test(input)) {
    if (v.mode === 'insert') {
      v.mode = 'normal'; v.insertCol = null; v.msg = '';
      finishRecording();
      clamp(v); print('-- NORMAL --', 'info');
    } else if (v.mode === 'visual') {
      v.mode = 'normal'; v.visual = null; v.msg = '';
      clamp(v); print('-- NORMAL --', 'info');
    }
    after(true); return;
  }

  if (v.mode === 'insert') {
    recordStep(input);
    insertInput(v, input, e);
    sfx('file-write');
    after(true); return;
  }

  if (v.mode === 'visual') {
    handleVisual(v, input, e);
    return;
  }

  // 命令模式（以 : 开头）
  if (input.startsWith(':')) {
    finishRecording();
    handleCommand(v, input.slice(1), e);
    return;
  }

  // 查找：/向下  ?向上  ·  \c 前缀忽略大小写
  if (input.startsWith('/') || input.startsWith('?')) {
    const dir = input.startsWith('/') ? 1 : -1;
    let pat = input.slice(1);
    let caseSensitive = true;
    if (pat.startsWith('\\c')) { caseSensitive = false; pat = pat.slice(2); }
    v.search = pat; v.searchDir = dir; v.searchCase = caseSensitive;
    const found = findSearch(v, dir);
    v.msg = found ? `${input[0]}${v.search} → 第 ${v.row + 1} 行` : `未找到: ${v.search}`;
    print(v.msg, found ? 'ok' : 'err');
    track('/'); e.used.add('vim-search');
    after(true); return;
  }
  if (input === 'n' || input === 'N') {
    if (!v.search) { print('E35: 无搜索模式（先用 /模式 搜索）', 'err'); after(false); return; }
    const dir = input === 'n' ? (v.searchDir || 1) : -(v.searchDir || 1);
    const found = findSearch(v, dir);
    v.msg = found ? `第 ${v.row + 1} 行` : `未找到: ${v.search}`;
    print(v.msg, found ? 'ok' : 'err');
    track('/'); e.used.add('vim-search');
    after(true); return;
  }

  // NORMAL 模式按键
  handleNormal(v, input, e);
}

/* ============ 插入模式：每行输入作为新行 ============ */
function insertInput(v, text, e) {
  e.pushUndo();
  if (v.insertCol != null) {
    // cw / c$ / s 后的行内续写：在 insertCol 处拼接
    const l = v.lines[v.row] || '';
    const c = Math.min(v.insertCol, l.length);
    v.lines[v.row] = l.slice(0, c) + text + l.slice(c);
    v.insertCol = c + text.length;
    v.col = v.insertCol;
  } else {
    if ((v.lines[v.row] || '').trim() === '') {
      v.lines[v.row] = text;           // 填充空行
    } else {
      v.lines.splice(v.row + 1, 0, text);
      v.row++;
    }
    v.col = text.length;
  }
  v.modified = true;
}

/* ============ . 重复录制 ============ */
function startRecording() { _rec = []; }
function recordStep(input) { if (_rec) _rec.push(input); }
function finishRecording() {
  if (_rec && _rec.length) lastEdit = _rec.slice();
  _rec = null;
}
// 重放 lastEdit（replay 标记防止再次录制）
function replayEdit(v, e, times) {
  if (!lastEdit) { print('E33: 无可重复的编辑动作', 'err'); v.msg = '无可重复动作'; after(false); return; }
  for (let t = 0; t < times; t++) {
    for (const step of lastEdit) {
      if (!e.vim) break;
      if (v.mode === 'insert') {
        if (/^(esc|<esc>|\x1b)$/i.test(step)) { v.mode = 'normal'; v.insertCol = null; clamp(v); }
        else insertInput(v, step, e);
      } else {
        handleNormal(v, step, e, true);
      }
    }
  }
  after(true);
}

/* ============ 可视模式 ============ */
function handleVisual(v, input, e) {
  const m = input.match(/^(\d*)([A-Za-z$^{}%].?)$/);
  const count = m ? (parseInt(m[1]) || 1) : 1;
  const cmd = m ? m[2] : input;

  // 移动类按键：扩展选区
  if (/^[hjklwbe0$^G{}%]$/.test(cmd) || cmd === 'gg') {
    if (cmd === 'gg') { v.row = count > 1 ? count - 1 : 0; v.col = 0; }
    else if (cmd === 'G') { v.row = count > 1 ? Math.min(count, v.lines.length) - 1 : v.lines.length - 1; v.col = 0; }
    else { for (let i = 0; i < count; i++) applyKey(v, cmd, e); }
    clamp(v); visSync(v);
    after(true); return;
  }

  const [r0, r1] = visRange(v);

  if (cmd === 'd' || cmd === 'x') {          // 删除选区
    e.pushUndo();
    if (v.visualLine) {
      const del = v.lines.splice(r0, r1 - r0 + 1);
      if (!v.lines.length) v.lines = [''];
      v.yank = del; setRegister(v, v._reg, del);
      v.row = Math.min(r0, v.lines.length - 1); v.col = 0;
      v.msg = `删除 ${del.length} 行`;
    } else {
      const a = v.visual, b = { row: v.row, col: v.col };
      const [s, en] = orderPts(a, b);
      const del = deleteCharRange(v, s, en);
      v.yank = del; setRegister(v, v._reg, del);
      v.row = s.row; v.col = s.col;
      v.msg = '已删除选区';
    }
    v.modified = true; v.mode = 'normal'; v.visual = null; v._reg = null;
    clamp(v); sfx('file-delete'); track('v-d'); e.used.add('vim-visual');
    after(true); return;
  }

  if (cmd === 'y') {                          // 复制选区
    if (v.visualLine) {
      v.yank = v.lines.slice(r0, r1 + 1);
      setRegister(v, v._reg, v.yank);
      v.msg = `复制 ${v.yank.length} 行`;
    } else {
      const a = v.visual, b = { row: v.row, col: v.col };
      const [s, en] = orderPts(a, b);
      const yk = yankCharRange(v, s, en);
      v.yank = yk; setRegister(v, v._reg, yk);
      v.msg = '已复制选区';
    }
    v.row = r0; v.col = 0;
    v.mode = 'normal'; v.visual = null; v._reg = null;
    clamp(v); sfx('file-copy'); track('v-y'); e.used.add('vim-visual');
    after(true); return;
  }

  if (cmd === '>' || cmd === '<' || cmd === '=') {   // 缩进 / 反缩进 / 格式化
    e.pushUndo();
    if (cmd === '>') { for (let r = r0; r <= r1; r++) v.lines[r] = '  ' + (v.lines[r] || ''); }
    else if (cmd === '<') { for (let r = r0; r <= r1; r++) v.lines[r] = (v.lines[r] || '').replace(/^ {1,2}/, ''); }
    else {
      for (let r = r0; r <= r1; r++) {
        v.lines[r] = (v.lines[r] || '').replace(/\s+$/, '').replace(/ {2,}/g, ' ');
      }
    }
    v.modified = true; v.row = r0; v.col = 0;
    v.mode = 'normal'; v.visual = null;
    clamp(v); sfx('file-write'); track('v-' + cmd); e.used.add('vim-visual');
    v.msg = cmd === '>' ? '已缩进' : cmd === '<' ? '已反缩进' : '已格式化';
    after(true); return;
  }

  // v / V 退出可视；其余按键仅移动光标
  if (cmd === 'v' || cmd === 'V') {
    v.mode = 'normal'; v.visual = null; v.msg = ''; clamp(v); print('-- NORMAL --', 'info'); after(true); return;
  }
  visSync(v);
  v.msg = `可视模式：移动扩展选区，d 删除 / y 复制 / > < 缩进`;
  after(true);
}

// 可视范围（行号，含端点）
function visRange(v) {
  const a = v.visual.row, b = v.row;
  return a <= b ? [a, b] : [b, a];
}
function orderPts(a, b) {
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) return [a, b];
  return [b, a];
}
// 删除字符可视选区 [s, en]（含端点），返回被删行数组
function deleteCharRange(v, s, en) {
  if (s.row === en.row) {
    const l = v.lines[s.row] || '';
    const del = l.slice(s.col, en.col + 1);
    v.lines[s.row] = l.slice(0, s.col) + l.slice(en.col + 1);
    return [del];
  }
  const first = v.lines[s.row] || '';
  const last = v.lines[en.row] || '';
  const head = first.slice(0, s.col);
  const tail = last.slice(en.col + 1);
  const del = [first.slice(s.col), ...v.lines.slice(s.row + 1, en.row), last.slice(0, en.col + 1)];
  v.lines.splice(s.row, en.row - s.row + 1, head + tail);
  return del;
}
// 复制字符可视选区（不修改缓冲）
function yankCharRange(v, s, en) {
  if (s.row === en.row) return [(v.lines[s.row] || '').slice(s.col, en.col + 1)];
  const first = v.lines[s.row] || '';
  const last = v.lines[en.row] || '';
  return [first.slice(s.col), ...v.lines.slice(s.row + 1, en.row), last.slice(0, en.col + 1)];
}
// 光标移动后保持可视锚点有效
function visSync(v) { if (!v.visual) v.visual = { row: v.row, col: v.col }; }

/* ============ NORMAL 模式 ============ */
function handleNormal(v, input, e, replay) {
  let s = input.trim();

  // 寄存器前缀 "a（如 "ayy / "ap / "add）
  let reg = null;
  const rm = s.match(/^"([a-zA-Z0-9])(.*)$/);
  if (rm) { reg = rm[1]; s = rm[2]; }
  v._reg = reg;

  const m = s.match(/^(\d*)(.*)$/);
  let count = parseInt(m[1]) || 1;
  let cmd = m[2];
  if (!cmd) {
    // 单独的 0 是"行首"移动，不是计数前缀（修复过的 bug，勿回归）
    if (m[1] === '0') { v.col = 0; v.msg = '行首'; after(true); return; }
    after(false); return;
  }

  // ── 多字符命令 ──
  if (cmd === 'gg') { v.row = count > 1 ? count - 1 : 0; v.col = 0; clamp(v); v.msg = `第 ${v.row + 1} 行`; after(true); return; }
  if (cmd === 'G') { v.row = count > 1 ? Math.min(count, v.lines.length) - 1 : v.lines.length - 1; v.col = 0; clamp(v); v.msg = `第 ${v.row + 1} 行`; after(true); return; }
  if (cmd === 'ZZ') { saveAndQuit(v, e); return; }
  if (cmd === 'ZQ') { e.closeVim(); print('已放弃更改并退出', 'info'); sfx('ui-close'); track(':q!'); e.used.add('vim-q'); after(true); return; }

  if (cmd === 'u') {
    if (e.undoVim()) {
      v.msg = '已撤销';
      print('已撤销上一步', 'ok'); sfx('ui-close'); track('u'); e.used.add('vim-u');
    } else {
      v.msg = '无可撤销的操作';
      print('无可撤销的操作（没有更早的快照）', 'err');
    }
    after(true); return;
  }

  if (cmd === 'dd') {
    e.pushUndo();
    const del = v.lines.splice(v.row, count);
    if (!v.lines.length) v.lines = [''];
    v.yank = del; setRegister(v, reg, del); v.modified = true; v.col = 0; clamp(v);
    v.msg = `删除 ${del.length} 行`; sfx('file-delete'); track('dd'); e.used.add('vim-dd');
    if (!replay) lastEdit = [input];
    after(true); return;
  }
  if (cmd === 'yy') {
    v.yank = v.lines.slice(v.row, v.row + count);
    setRegister(v, reg, v.yank);
    v.msg = `复制 ${v.yank.length} 行`; sfx('file-copy'); track('yy'); e.used.add('vim-yy'); after(true); return;
  }
  if (cmd === 'cc') {
    e.pushUndo();
    v.yank = v.lines.splice(v.row, count);
    if (!v.lines.length) v.lines = [''];
    v.lines.splice(v.row, 0, '');
    v.col = 0; v.modified = true; v.mode = 'insert';
    v.msg = '-- INSERT --'; sfx('file-delete'); track('cc'); e.used.add('vim-cc');
    if (!replay) startRecording();
    print('-- INSERT --', 'info'); after(true); return;
  }

  // D —— 删到行尾（count 可删多行尾）
  if (cmd === 'D') {
    const l = v.lines[v.row] || '';
    e.pushUndo();
    const first = l.slice(v.col);
    v.lines[v.row] = l.slice(0, v.col);
    const extra = count > 1 ? v.lines.splice(v.row + 1, count - 1) : [];
    const del = [first, ...extra];
    v.yank = del; setRegister(v, reg, del); v.modified = true; clamp(v);
    v.msg = '删除到行尾'; sfx('file-delete'); track('D'); e.used.add('vim-D');
    if (!replay) lastEdit = [input];
    after(true); return;
  }
  // C —— 改到行尾（删到行尾并进入插入模式）
  if (cmd === 'C') {
    const l = v.lines[v.row] || '';
    e.pushUndo();
    const first = l.slice(v.col);
    v.lines[v.row] = l.slice(0, v.col);
    const extra = count > 1 ? v.lines.splice(v.row + 1, count - 1) : [];
    v.yank = [first, ...extra]; setRegister(v, reg, v.yank);
    v.insertCol = v.col; v.modified = true; v.mode = 'insert';
    v.msg = '-- INSERT --'; sfx('file-delete'); track('C'); e.used.add('vim-C');
    if (!replay) startRecording();
    print('-- INSERT --', 'info'); after(true); return;
  }

  // J —— 合并行（把下方 count 行并入当前行，以单空格相连）
  if (cmd === 'J') {
    e.pushUndo();
    let joined = 0;
    for (let i = 0; i < count && v.row < v.lines.length - 1; i++) {
      const cur = (v.lines[v.row] || '').replace(/\s+$/, '');
      const nxt = (v.lines[v.row + 1] || '').replace(/^\s+/, '');
      v.lines[v.row] = nxt ? cur + ' ' + nxt : cur;
      v.lines.splice(v.row + 1, 1);
      joined++;
    }
    v.modified = true; clamp(v);
    v.msg = joined ? `合并 ${joined + 1} 行` : '下方没有可合并的行';
    sfx('file-delete'); track('J'); e.used.add('vim-J');
    if (!replay) lastEdit = [input];
    after(true); return;
  }

  // . —— 重复上一次编辑动作
  if (cmd === '.') { replayEdit(v, e, count); return; }

  // m{字符} —— 设置标记
  if (cmd[0] === 'm' && cmd.length >= 2 && /^[a-zA-Z]$/.test(cmd[1])) {
    v.marks[cmd[1]] = { row: v.row, col: v.col };
    v.msg = `标记 ${cmd[1]} = 第 ${v.row + 1} 行`; track('m'); e.used.add('vim-mark');
    after(true); return;
  }
  // '{字符} / `{字符} —— 跳到标记
  if ((cmd[0] === "'" || cmd[0] === '`') && cmd.length >= 2) {
    const mk = v.marks[cmd[1]];
    if (mk) { v.row = Math.min(mk.row, v.lines.length - 1); v.col = mk.col; clamp(v); v.msg = `跳到标记 ${cmd[1]}`; }
    else { v.msg = `标记 ${cmd[1]} 未定义`; print(`标记 ${cmd[1]} 未定义（先用 m${cmd[1]} 设置）`, 'err'); }
    track("'"); e.used.add('vim-mark');
    after(true); return;
  }

  // >> / << —— 缩进 / 反缩进当前行（count 生效）
  if (cmd === '>>' || cmd === '<<') {
    e.pushUndo();
    const n = Math.min(count, v.lines.length - v.row);
    for (let i = 0; i < n; i++) {
      const r = v.row + i;
      v.lines[r] = cmd === '>>' ? '  ' + (v.lines[r] || '') : (v.lines[r] || '').replace(/^ {1,2}/, '');
    }
    v.modified = true; v.col = 0; clamp(v);
    v.msg = cmd === '>>' ? `缩进 ${n} 行` : `反缩进 ${n} 行`;
    sfx('file-write'); track(cmd); e.used.add('vim-indent');
    if (!replay) lastEdit = [input];
    after(true); return;
  }
  // == —— 格式化当前行（简化：去行尾空白、压缩连续空格）
  if (cmd === '==') {
    e.pushUndo();
    const n = Math.min(count, v.lines.length - v.row);
    for (let i = 0; i < n; i++) {
      const r = v.row + i;
      v.lines[r] = (v.lines[r] || '').replace(/\s+$/, '').replace(/ {2,}/g, ' ');
    }
    v.modified = true; v.col = 0; clamp(v);
    v.msg = `格式化 ${n} 行`; sfx('file-write'); track('=='); e.used.add('vim-indent');
    if (!replay) lastEdit = [input];
    after(true); return;
  }

  // 屏幕移动 H / M / L（估计窗口 SCREEN_H 行）
  if (cmd === 'H') { v.row = 0; v.col = 0; clamp(v); v.msg = '屏幕顶部'; after(true); return; }
  if (cmd === 'M') { v.row = Math.min(Math.floor(SCREEN_H / 2), v.lines.length - 1); v.col = 0; clamp(v); v.msg = '屏幕中部'; after(true); return; }
  if (cmd === 'L') { v.row = Math.min(SCREEN_H - 1, v.lines.length - 1); v.col = 0; clamp(v); v.msg = '屏幕底部'; after(true); return; }
  // 翻页 Ctrl-d / Ctrl-u（别名 kd / ku，半页）
  if (cmd === 'kd' || cmd === 'jd') { v.row = Math.min(v.row + Math.floor(SCREEN_H / 2), v.lines.length - 1); clamp(v); v.msg = '下翻半页'; after(true); return; }
  if (cmd === 'ku' || cmd === 'ju') { v.row = Math.max(v.row - Math.floor(SCREEN_H / 2), 0); clamp(v); v.msg = '上翻半页'; after(true); return; }
  // 段落 { / }（以空行为段落边界）
  if (cmd === '}') {
    let r = v.row + 1;
    while (r < v.lines.length && (v.lines[r] || '').trim() === '') r++;
    while (r < v.lines.length && (v.lines[r] || '').trim() !== '') r++;
    v.row = Math.min(r, v.lines.length - 1); v.col = 0; clamp(v); v.msg = '下一段'; after(true); return;
  }
  if (cmd === '{') {
    let r = v.row - 1;
    while (r >= 0 && (v.lines[r] || '').trim() === '') r--;
    while (r >= 0 && (v.lines[r] || '').trim() !== '') r--;
    v.row = Math.max(r + 1, 0); v.col = 0; clamp(v); v.msg = '上一段'; after(true); return;
  }
  // % —— 括号匹配 ( ) [ ] { }
  if (cmd === '%') { jumpMatch(v); v.msg = '括号匹配'; after(true); return; }

  // 可视模式入口 v / V
  if (cmd === 'v') { v.mode = 'visual'; v.visualLine = false; v.visual = { row: v.row, col: v.col }; v.msg = '-- VISUAL --'; print('-- VISUAL --', 'info'); after(true); return; }
  if (cmd === 'V') { v.mode = 'visual'; v.visualLine = true; v.visual = { row: v.row, col: 0 }; v.msg = '-- VISUAL LINE --'; print('-- VISUAL LINE --', 'info'); after(true); return; }

  // r{字符} —— 替换光标处字符（保持 NORMAL 模式），count 生效
  if (cmd === 'r') { v.msg = '用法: r{字符}'; print('用法: r{字符}（如 rx 把光标处字符换成 x）', 'info'); after(false); return; }
  if (cmd[0] === 'r' && cmd.length >= 2) {
    const ch = cmd[1];
    const l = v.lines[v.row] || '';
    if (l.length) {
      e.pushUndo();
      const n = Math.min(count, l.length - v.col);
      v.lines[v.row] = l.slice(0, v.col) + ch.repeat(n) + l.slice(v.col + n);
      v.modified = true; clamp(v);
      v.msg = `替换 ${n} 个字符`; sfx('file-delete'); track('r'); e.used.add('vim-r');
      if (!replay) lastEdit = [input];
    }
    after(true); return;
  }

  // 操作符 + 动作：dw / d$ / d2w / cw / c$ / c2w / de / db / d0 / d^ / d%（简化词 = 连续非空白）
  let m2;
  if ((m2 = cmd.match(/^([dc])(\d*)(w|e|b|\$|0|\^|%)$/))) {
    const [, op, mc, motion] = m2;
    const mcount = parseInt(mc) || 1;
    const l = v.lines[v.row] || '';
    let end = v.col;
    if (motion === '$') end = l.length;
    else if (motion === '0') end = 0;
    else if (motion === '^') { end = l.search(/\S/); if (end < 0) end = 0; }
    else if (motion === '%') { const t = matchCol(v); end = t >= 0 ? t + 1 : v.col; }
    else if (motion === 'b') { for (let i = 0; i < mcount; i++) end = wordStart(l, end); }
    else if (motion === 'e') { for (let i = 0; i < mcount; i++) end = wordEnd(l, end) + 1; }
    else { for (let i = 0; i < mcount; i++) end = wordStart(l, end, true); } // w
    const from = Math.min(v.col, end), to = Math.max(v.col, end);
    if (from !== to) {
      e.pushUndo();
      const deleted = l.slice(from, to);
      v.yank = [deleted]; setRegister(v, reg, v.yank);
      v.lines[v.row] = l.slice(0, from) + l.slice(to);
      v.col = from; v.modified = true; sfx('file-delete'); track(cmd); e.used.add('vim-' + cmd);
      if (op === 'c') {
        v.insertCol = from; v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info');
        if (!replay) startRecording();
      } else {
        v.msg = `删除 "${deleted}"`;
        if (!replay) lastEdit = [input];
      }
      clamp(v);
    } else {
      v.msg = '此处没有可删除的内容';
    }
    after(true); return;
  }

  // 缩进 / 格式化 + 动作：>j / >w / >G / <j / =G 等（行级操作）
  if ((m2 = cmd.match(/^([><=])(\d*)([jkwG$]|gg)?$/))) {
    const [, op, mc, motion] = m2;
    const mcount = parseInt(mc) || 1;
    let r0 = v.row, r1 = v.row;
    if (motion === 'j') r1 = Math.min(v.row + mcount, v.lines.length - 1);
    else if (motion === 'k') r0 = Math.max(v.row - mcount, 0);
    else if (motion === 'G' || motion === '$') r1 = v.lines.length - 1;
    else if (motion === 'gg') r0 = 0;
    // 无动作（> / < / =）：仅当前行
    e.pushUndo();
    for (let r = r0; r <= r1; r++) {
      if (op === '>') v.lines[r] = '  ' + (v.lines[r] || '');
      else if (op === '<') v.lines[r] = (v.lines[r] || '').replace(/^ {1,2}/, '');
      else v.lines[r] = (v.lines[r] || '').replace(/\s+$/, '').replace(/ {2,}/g, ' ');
    }
    v.modified = true; v.row = r0; v.col = 0; clamp(v);
    v.msg = op === '>' ? `缩进 ${r1 - r0 + 1} 行` : op === '<' ? `反缩进 ${r1 - r0 + 1} 行` : `格式化 ${r1 - r0 + 1} 行`;
    sfx('file-write'); track(op); e.used.add('vim-indent');
    if (!replay) lastEdit = [input];
    after(true); return;
  }

  // 单字符命令（count 生效）
  for (let i = 0; i < count; i++) {
    if (!applyKey(v, cmd, e, replay)) break;
  }
  clamp(v);
  after(true);
}

// 词首（简化词 = 连续非空白）。next=true 取下一个词首（w 动作）
function wordStart(l, col, next) {
  let i = col;
  if (next) {
    if (i < l.length && !/\s/.test(l[i])) { while (i < l.length && !/\s/.test(l[i])) i++; }
    while (i < l.length && /\s/.test(l[i])) i++;
  } else {
    i = col - 1;
    while (i >= 0 && /\s/.test(l[i])) i--;
    while (i >= 0 && !/\s/.test(l[i])) i--;
    i = i + 1;
  }
  return i;
}
// 词尾（e 动作），返回词尾字符下标
function wordEnd(l, col) {
  let i = col + 1;
  while (i < l.length && /\s/.test(l[i])) i++;
  while (i < l.length && !/\s/.test(l[i])) i++;
  return Math.max(col, i - 1);
}
// 括号匹配：返回配对括号下标，找不到 -1
function matchCol(v) {
  const l = v.lines[v.row] || '';
  const pairs = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };
  let found = -1;
  for (let i = v.col; i < l.length; i++) {
    if (pairs[l[i]]) { found = i; break; }
  }
  if (found < 0) return -1;
  const open = l[found];
  const close = pairs[open];
  const forward = open === '(' || open === '[' || open === '{';
  let depth = 0;
  if (forward) {
    for (let i = found; i < l.length; i++) {
      if (l[i] === open) depth++;
      else if (l[i] === close) { depth--; if (depth === 0) return i; }
    }
  } else {
    for (let i = found; i >= 0; i--) {
      if (l[i] === open) depth++;
      else if (l[i] === close) { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}
function jumpMatch(v) {
  const t = matchCol(v);
  if (t >= 0) v.col = t;
  else v.msg = '未找到配对括号';
}

function applyKey(v, cmd, e, replay) {
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
    case 'b': { // 上一个词首（简化词 = 连续非空白）
      const l = line();
      let i = v.col - 1;
      while (i >= 0 && /\s/.test(l[i])) i--;
      while (i >= 0 && !/\s/.test(l[i])) i--;
      v.col = i + 1; return true;
    }
    case 'e': { // 下一个词尾
      const l = line();
      let i = v.col + 1;
      while (i < l.length && /\s/.test(l[i])) i++;
      while (i < l.length && !/\s/.test(l[i])) i++;
      v.col = Math.max(v.col, i - 1); return true;
    }
    case 'x': {
      const l = line();
      if (l.length) { e.pushUndo(); v.lines[v.row] = l.slice(0, v.col) + l.slice(v.col + 1); v.modified = true; sfx('file-delete'); track('x'); e.used.add('vim-x'); if (!replay) lastEdit = [cmd]; }
      return true;
    }
    case 's': { // 删字符并进入插入模式（行内续写）
      const l = line();
      if (l.length) { e.pushUndo(); v.yank = [l[v.col]]; setRegister(v, v._reg, v.yank); v.lines[v.row] = l.slice(0, v.col) + l.slice(v.col + 1); v.modified = true; sfx('file-delete'); track('s'); e.used.add('vim-s'); }
      v.insertCol = v.col; v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info');
      if (!replay) startRecording();
      return true;
    }
    case 'p': {
      const rg = getRegister(v, v._reg);
      if (!rg || !rg.length) { v.msg = '寄存器为空（先 yy 复制）'; return false; }
      e.pushUndo();
      v.lines.splice(v.row + 1, 0, ...rg);
      v.row += rg.length; v.modified = true; v.msg = `粘贴 ${rg.length} 行`;
      sfx('file-copy'); track('p'); e.used.add('vim-p'); if (!replay) lastEdit = [cmd]; return true;
    }
    case 'P': {
      const rg = getRegister(v, v._reg);
      if (!rg || !rg.length) { v.msg = '寄存器为空（先 yy 复制）'; return false; }
      e.pushUndo();
      v.lines.splice(v.row, 0, ...rg); v.modified = true;
      sfx('file-copy'); track('P'); e.used.add('vim-P'); if (!replay) lastEdit = [cmd]; return true;
    }
    case 'i': v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); if (!replay) startRecording(); return true;
    case 'a': v.col = Math.min(line().length, v.col + 1); v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); if (!replay) startRecording(); return true;
    case 'I': v.col = 0; v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); if (!replay) startRecording(); return true;
    case 'A': v.col = line().length; v.mode = 'insert'; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); if (!replay) startRecording(); return true;
    case 'o': e.pushUndo(); v.lines.splice(v.row + 1, 0, ''); v.row++; v.col = 0; v.mode = 'insert'; v.modified = true; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); if (!replay) startRecording(); return true;
    case 'O': e.pushUndo(); v.lines.splice(v.row, 0, ''); v.col = 0; v.mode = 'insert'; v.modified = true; v.msg = '-- INSERT --'; print('-- INSERT --', 'info'); if (!replay) startRecording(); return true;
    default:
      v.msg = `未知按键: ${cmd}`;
      return false;
  }
}

// 命名寄存器读写（reg 为空时回退默认 yank）
function setRegister(v, reg, lines) {
  if (reg && /^[a-zA-Z0-9]$/.test(reg)) v.registers[reg.toLowerCase()] = lines.slice();
}
function getRegister(v, reg) {
  if (reg && /^[a-zA-Z0-9]$/.test(reg) && v.registers[reg.toLowerCase()]) return v.registers[reg.toLowerCase()];
  return v.yank;
}

/* ============ 命令模式 ============ */
function handleCommand(v, cmd, e) {
  cmd = cmd.trim();
  let m;
  // :wq / :wq! / :x / ZZ —— 保存并退出
  if (cmd === 'wq' || cmd === 'x' || cmd === 'wq!') { saveAndQuit(v, e); return; }
  if (cmd === 'w') {
    e.saveVim();
    print(`"${e.basename(v.file)}" ${v.lines.length}L, ${v.lines.join('\n').length}C 已写入`, 'ok');
    sfx('file-write'); track(':w'); e.used.add('vim-w'); after(true); return;
  }
  // :w <file> / :w! <file> —— 另存为：缓冲区写入指定路径，继续编辑当前文件
  if ((m = cmd.match(/^w!?\s+(\S+)$/))) {
    const path = e.resolvePath(m[1]);
    const r = e.writeFile(path, v.lines.join('\n') + '\n');
    if (r && r.err) { print(r.err, 'err'); sfx('err-file'); after(false); return; }
    print(`"${e.basename(path)}" ${v.lines.length}L 已另存（继续编辑 "${e.basename(v.file)}"）`, 'ok');
    sfx('file-write'); track(':w'); e.used.add('vim-w'); after(true); return;
  }
  if (cmd === 'q') {
    if (v.modified) { print('E37: 未保存更改（用 :wq 保存或 :q! 放弃）', 'err'); sfx('err-syntax'); after(false); return; }
    e.closeVim(); print('已退出 vim', 'info'); sfx('ui-close'); track(':q'); e.used.add('vim-q'); after(true); return;
  }
  if (cmd === 'q!' || cmd === 'qall!' || cmd === 'qa!') {
    e.closeVim(); print('已放弃更改并退出', 'info'); sfx('ui-close'); track(':q!'); e.used.add('vim-q'); after(true); return;
  }
  // :s/旧/新/  ·  :%s/旧/新/g  ·  :N,Ms/旧/新/gi  ·  :%s/旧/新/gc（确认模拟）
  //   范围 = 行 N..M（% 全文）；标志 g 行内全部 / i 忽略大小写 / c 确认（模拟为提示后替换）
  if ((m = cmd.match(/^(%|\d+\s*,\s*\d+)?s\/(.*)\/(.*)\/([gic]*)$/))) {
    const [, range, pat, rep, flags] = m;
    const reFlags = (flags.includes('g') ? 'g' : '') + (flags.includes('i') ? 'i' : '');
    const confirm = flags.includes('c');
    const re = new RegExp(escapeRe(pat), reFlags);
    e.pushUndo();
    let n = 0;
    const doLine = (r) => {
      const nl = (v.lines[r] || '').replace(re, rep);
      if (nl !== v.lines[r]) { v.lines[r] = nl; n++; }
    };
    if (range === '%') {
      v.lines = v.lines.map(l => { const nl = l.replace(re, rep); if (nl !== l) n++; return nl; });
    } else if (range) {
      const [a, b] = range.split(',').map(x => parseInt(x.trim()));
      const from = Math.max(1, a), to = Math.min(v.lines.length, b);
      for (let r = from - 1; r < to; r++) doLine(r);
    } else {
      doLine(v.row);
    }
    if (confirm && n > 0) print(`确认替换：模拟逐一确认，共替换 ${n} 处（y/a 全部接受）`, 'info');
    if (n > 0) v.modified = true; else v.undo.pop(); // 无变化不占撤销快照
    print(`${n} 处替换`, 'ok'); sfx('file-write'); track(':s'); e.used.add('vim-sub'); after(true); return;
  }
  // :set number/nu/nonumber/nonu/number!/rnu/relativenumber/nornu/ic/noic
  if ((m = cmd.match(/^set\s+(number!|number|nu!|nu|nonumber|nonu|relativenumber|rnu|nornu|ignorecase|ic|noic)$/))) {
    const opt = m[1];
    if (opt === 'number' || opt === 'nu') v.number = true;
    else if (opt === 'nonumber' || opt === 'nonu') v.number = false;
    else if (opt === 'number!' || opt === 'nu!') v.number = !v.number;
    else if (opt === 'relativenumber' || opt === 'rnu') v.rnu = true;
    else if (opt === 'nornu') v.rnu = false;
    else if (opt === 'ignorecase' || opt === 'ic') v.searchCase = false;
    else if (opt === 'noic') v.searchCase = true;
    print(`已设置 ${opt}（行号: ${v.number ? '开' : '关'} · 相对行号: ${v.rnu ? '开' : '关'}）`, 'info');
    track(':set'); after(true); return;
  }
  // :e file —— 切换/打开文件（加入缓冲区列表）
  if ((m = cmd.match(/^e(?:dit)?\s+(\S+)$/))) {
    if (v.modified) { print('E37: 未保存更改（先 :w）', 'err'); after(false); return; }
    const buffers = v.buffers.slice();
    const bufferState = v.bufferState;
    e.saveBuffer();
    e.openVim(m[1]);
    const nv = e.vim;
    nv.buffers = buffers;
    nv.bufferState = bufferState;
    if (!nv.buffers.includes(nv.file)) nv.buffers.push(nv.file);
    print(`── 打开 ${m[1]} ──`, 'head'); track(':e'); e.used.add('vim-e'); after(true); return;
  }
  // :bn / :bp —— 下一个 / 上一个缓冲区
  if (cmd === 'bn' || cmd === 'bnext') { nextBuffer(v, e, 1); return; }
  if (cmd === 'bp' || cmd === 'bprev' || cmd === 'bprevious') { nextBuffer(v, e, -1); return; }
  // :N 跳转行号
  if ((m = cmd.match(/^(\d+)$/))) {
    v.row = Math.min(parseInt(m[1]) - 1, v.lines.length - 1); v.col = 0; clamp(v);
    v.msg = `第 ${v.row + 1} 行`; after(true); return;
  }
  // :g/模式/d 删除匹配行 · :v/模式/d 删除不匹配行（:g!/模式/d 同 :v）
  if ((m = cmd.match(/^g!\s*\/(.*)\/([dl]?)$/)) || (m = cmd.match(/^g\s*\/(.*)\/([dl]?)$/)) || (m = cmd.match(/^v\s*\/(.*)\/([dl]?)$/))) {
    const isV = cmd[0] === 'v' || cmd.startsWith('g!');
    const pat = m[1];
    const re = new RegExp(escapeRe(pat));
    e.pushUndo();
    const before = v.lines.length;
    v.lines = v.lines.filter(l => (isV ? !re.test(l) : re.test(l)) === false);
    if (!v.lines.length) v.lines = [''];
    const removed = before - v.lines.length;
    v.modified = true; clamp(v);
    print(`${isV ? ':v' : ':g'} 删除 ${removed} 行`, 'ok');
    sfx('file-delete'); track(isV ? ':v' : ':g'); e.used.add('vim-global'); after(true); return;
  }
  // :r 文件 —— 在当前行后读入文件内容
  if ((m = cmd.match(/^r(?:ead)?\s+(\S+)$/))) {
    const r = e.readFile(m[1]);
    if (!r.ok) { print(r.err || `无法读取 ${m[1]}`, 'err'); sfx('err-file'); after(false); return; }
    let ins = r.content.split('\n');
    if (ins[ins.length - 1] === '') ins.pop();
    e.pushUndo();
    v.lines.splice(v.row + 1, 0, ...ins);
    v.modified = true; clamp(v);
    print(`已读入 ${ins.length} 行（来自 ${e.basename(m[1])}）`, 'ok');
    sfx('file-write'); track(':r'); e.used.add('vim-read'); after(true); return;
  }
  // :r! cmd —— 读入外部命令输出
  if ((m = cmd.match(/^r(?:ead)?!\s*(.+)$/))) {
    const out = captureLinux(m[1], e);
    e.pushUndo();
    v.lines.splice(v.row + 1, 0, ...out);
    v.modified = true; clamp(v);
    print(`已读入 ${out.length} 行命令输出`, 'ok');
    sfx('file-write'); track(':r!'); e.used.add('vim-read'); after(true); return;
  }
  // :!cmd —— 执行外部命令（简化：委托 linux 命令层）
  if ((m = cmd.match(/^!\s*(.+)$/))) {
    print(`:!${m[1]}`, 'info');
    linuxExecute(m[1]);
    track(':!'); e.used.add('vim-shell'); after(true); return;
  }
  // :noh / :nohlsearch —— 清除搜索高亮提示
  if (cmd === 'noh' || cmd === 'nohlsearch') {
    v.msg = ''; print('已清除搜索高亮', 'info'); track(':noh'); after(true); return;
  }
  print(`E492: 不是编辑器命令: ${cmd}`, 'err'); sfx('err-syntax'); after(false);
}

// :wq / ZZ 共用：保存并退出
function saveAndQuit(v, e) {
  e.saveVim();
  const f = v.file;
  e.closeVim();
  sfx('file-write');
  print(`"${e.basename(f)}" 已保存并退出`, 'ok');
  track(':wq'); e.used.add('vim-wq'); e.lastOut = 'saved'; after(true);
}

// :bn / :bp —— 在缓冲区列表中循环切换
function nextBuffer(v, e, dir) {
  const list = v.buffers && v.buffers.length ? v.buffers : [v.file];
  let idx = list.indexOf(v.file);
  if (idx < 0) idx = 0;
  const nidx = (idx + dir + list.length) % list.length;
  e.saveBuffer();
  e.switchBuffer(list[nidx]);
  print(`缓冲区 ${e.basename(e.vim.file)}（${nidx + 1}/${list.length}）`, 'info');
  track(dir > 0 ? ':bn' : ':bp'); e.used.add('vim-buffer'); after(true);
}

// 执行一条 linux 命令并捕获其输出行（用于 :r!）
// linuxExecute(input, engineOverride) 会把 stdout 写进 engine.lastOut，借此捕获
function captureLinux(cmdline, e) {
  const prev = e.lastOut;
  try { linuxExecute(cmdline, e); } catch (err) { /* 健壮：吞掉异常 */ }
  const txt = (e.lastOut == null ? '' : String(e.lastOut));
  e.lastOut = prev;
  const lines = txt.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/* ============ 查找 ============ */
function findSearch(v, dir) {
  const n = v.lines.length;
  const pat = v.search || '';
  const cs = v.searchCase !== false;
  for (let step = 1; step <= n; step++) {
    const r = (v.row + dir * step + n * step) % n;
    const line = v.lines[r] || '';
    const idx = cs ? line.indexOf(pat) : line.toLowerCase().indexOf(pat.toLowerCase());
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
    '  vim <文件> · :w 保存 · :w <文件> 另存为 · :q 退出 · :wq / :x / ZZ 保存退出 · :q! / ZQ 放弃退出',
    '── 模式切换 ──',
    '  i 光标前插入 · a 光标后插入 · I 行首插入 · A 行尾插入',
    '  o 下方新行 · O 上方新行 · v 字符可视 · V 行可视 · Esc 回到 NORMAL',
    '── 移动（NORMAL）──',
    '  h j k l 左右上下 · 0 行首 · $ 行尾 · ^ 首个非空 · gg 文件头 · G 文件尾 · 5G 第5行',
    '  w 下一词 · b 上一词首 · e 下一词尾 · { } 段落 · % 括号匹配',
    '  H/M/L 屏幕顶/中/底 · kd/ku 下/上翻半页 · 计数前缀 3j 5w 2yy',
    '── 编辑（NORMAL）──',
    '  x 删字符 · s 删字符并插入 · r{字符} 替换字符 · J 合并行 · . 重复上一编辑',
    '  dd 删行 · 3dd 删3行 · D 删到行尾 · dw/d$ 删词/到行尾',
    '  cc 改行 · C 改到行尾 · cw/c$ 改词/到行尾 · c2w 改2个词',
    '  yy 复制行 · p/P 粘贴 · >> << 缩进 · == 格式化 · u 撤销',
    '  "ayy 复制到寄存器a · "ap 从a粘贴 · ma 设标记 · \'a 跳标记',
    '── 可视模式 ──',
    '  v/V 进入 · 移动扩展选区 · d 删除 · y 复制 · > < 缩进 · = 格式化',
    '── 查找替换 ──',
    '  /模式 向下搜索 · ?模式 向上搜索 · \\c模式 忽略大小写 · n/N 下/上一个匹配',
    '  :s/旧/新/g 替换本行 · :%s/旧/新/g 全文 · :2,4s/旧/新/gi 范围(i 忽略大小写)',
    '  :%s/旧/新/gc 逐一确认（模拟）',
    '── : 命令 ──',
    '  :e 文件 切换 · :bn/:bp 下/上一个缓冲区 · :N 跳到第N行',
    '  :g/模式/d 删匹配行 · :v/模式/d 删不匹配行 · :r 文件 读入 · :r! cmd 读命令输出',
    '  :!cmd 执行外部命令 · :noh 清除高亮 · :set nu/rnu/nonu/number! · ls / cat 照常可用',
  ].forEach(l => print(l, 'info'));
}
