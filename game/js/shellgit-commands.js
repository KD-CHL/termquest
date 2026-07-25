// Shell + Git 混合命令集 —— 在 git 仓库里做文本处理 / 脚本自动化
// 共享 GitEngine（G）：shell 命令直接操作 G.files（扁平文件映射），
// git 命令委托给 commands.js 的 gitExecute。
// 第 2 轮增强：补齐文本/文件/内建命令，并内置脚本解释器
//   （变量赋值与展开、$()、if/for/while/case、函数、位置参数、$?）。
import { G, app } from './state.js';
import { execute as gitExecute, tokenize } from './commands.js';
import { print, printCmd, clearTerm } from './terminal.js';
import { sfx } from './effects.js';
import { parsePipeline } from './fs.js';

function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

// 模块级状态：上一条命令退出码、当前脚本环境、别名表
let LAST_EXIT = 0;
let CUR_ENV = null;
const aliases = {};

// 这些命令由本模块处理，其余交给 gitExecute（git / help 等）
// 注意：不要把无处理器的命令放进 SHELL_HANDLED（曾误收 'append'，已移除使其自然落回 gitExecute）
const SHELL_HANDLED = new Set([
  // 文本处理
  'grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail',
  'cut', 'tr', 'paste', 'join', 'comm', 'tee', 'column', 'rev', 'tac',
  'find', 'xargs', 'diff', 'nl', 'md5sum', 'printf', 'seq', 'shuf',
  // 文件操作
  'ls', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'chmod', 'pwd',
  // shell 内建 / 杂项
  'echo', 'cat', 'test', '[', 'expr', 'bc', 'read', 'source', '.',
  'alias', 'unalias', 'type', 'which', 'clear', 'true', 'false',
  'export', 'unset', 'sleep', 'basename', 'dirname', 'date', 'whoami',
  'hostname', 'uname', 'env',
  // 脚本
  'bash', 'sh', 'vim',
]);

export function shellgitExecute(input) {
  input = input.trim();
  if (!input) return;
  const base = input.split(/\s/)[0];
  if (SHELL_HANDLED.has(base)) {
    printCmd(input);
    if (!app.inScript) { app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount(); }
    handleShell(input, base);
  } else {
    gitExecute(input);
  }
}

// ── 管道执行核心 ──
// runPipeline：执行一行（可含管道/重定向），不打印，返回 {out, err, sfx, exit, mutated, redirect}
function runPipeline(input) {
  const { stages, redirect } = parsePipeline(input);
  let stdin = '';
  let last = { out: [], err: null, sfx: null, exit: 0, mutated: false };
  let mutated = false;
  for (let i = 0; i < stages.length; i++) {
    last = runShellStage(stages[i], stdin);
    if (last.mutated) mutated = true;
    if (last.err) return { out: [], err: last.err, sfx: last.sfx || 'err-file', exit: last.exit || 1, mutated, redirect };
    last.out = (last.out || []).map(String);
    stdin = last.out.join('\n');
    if (i < stages.length - 1) sfx('pipe-tick');
  }
  if (redirect.file) {
    const content = stdin + (stdin ? '\n' : '');
    G.files[redirect.file] = redirect.type === '>>' ? (G.files[redirect.file] || '') + content : content;
    sfx('file-write');
    return { out: [], err: null, sfx: 'file-write', exit: 0, mutated: true, redirect };
  }
  return { out: (last.out || []).map(String), err: null, sfx: last.sfx, exit: last.exit || 0, mutated, redirect };
}

// 交互入口：执行并打印结果
function handleShell(input) {
  const r = runPipeline(input);
  LAST_EXIT = r.exit || 0;
  if (r.err) { print([].concat(r.err).join('\n'), 'err'); sfx(r.sfx || 'err-file'); after(false); return; }
  if (r.out.length) r.out.forEach(l => print(l, 'out'));
  if (r.sfx) sfx(r.sfx);
  after(r.mutated !== false);
}

// 命令替换 $(...)：静默执行并取 stdout 文本
function captureShell(input) {
  const r = runPipeline(input);
  if (r.err) return '';
  return (r.out || []).join('\n').replace(/\n+$/, '');
}

function runShellStage(stage, stdin) {
  const t = tokenize(stage);
  const cmd = t[0];
  const args = t.slice(1);
  track(cmd);
  G.used.add(cmd);

  const fn = SHELL[cmd];
  if (!fn) {
    // 非 shell 内建（git 子命令 / help 等）委托给 gitExecute（它自行打印输出）
    gitExecute(stage);
    return { out: [], err: null, sfx: null, exit: LAST_EXIT || 0, mutated: true };
  }
  const r = fn(args, stdin) || {};
  if (r.exit === undefined) r.exit = r.err ? 1 : 0;
  return r;
}

// 读取文件内容（G.files 扁平映射）
function readF(name) {
  if (G.files[name] === undefined) return null;
  return G.files[name];
}

// ── 通用工具 ──
const ESCMAP = { n: '\n', t: '\t', r: '\r', '0': '\0', b: '\b', f: '\f', v: '\v' };
function escChar(c) { return ESCMAP[c] !== undefined ? ESCMAP[c] : c; }
function globMatch(pat, str) {
  const re = '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  try { return new RegExp(re).test(str); } catch { return false; }
}
function inputLines(stdin) { return stdin ? stdin.split('\n') : []; }
function nonFlag(a) { return a.filter(x => !x.startsWith('-')); }

// ── MD5（紧凑实现，用于 md5sum）──
function md5(str) {
  function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function fF(x, y, z) { return (x & y) | ((~x) & z); }
  function fG(x, y, z) { return (x & z) | (y & (~z)); }
  function fH(x, y, z) { return x ^ y ^ z; }
  function fI(x, y, z) { return y ^ (x | (~z)); }
  function utf8(s) {
    s = String(s).replace(/\r\n/g, '\n');
    let out = '';
    for (let n = 0; n < s.length; n++) {
      const c = s.charCodeAt(n);
      if (c < 128) out += String.fromCharCode(c);
      else if (c < 2048) { out += String.fromCharCode(192 | (c >> 6)); out += String.fromCharCode(128 | (c & 63)); }
      else { out += String.fromCharCode(224 | (c >> 12)); out += String.fromCharCode(128 | ((c >> 6) & 63)); out += String.fromCharCode(128 | (c & 63)); }
    }
    return out;
  }
  const bytes = utf8(str);
  const x = [];
  for (let i = 0; i < bytes.length * 8; i += 8) x[i >> 5] |= (bytes.charCodeAt(i / 8) & 0xff) << (i % 32);
  const len = bytes.length * 8;
  x[len >> 5] |= 0x80 << (len % 32);
  x[(((len + 64) >>> 9) << 4) + 14] = len;
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const T = [];
  for (let i = 0; i < 64; i++) T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let k = 0; k < x.length; k += 16) {
    const w = [];
    for (let i = 0; i < 16; i++) w[i] = x[k + i] || 0;
    let reg = [a, b, c, d];
    for (let i = 0; i < 64; i++) {
      let f, gi;
      if (i < 16) { f = fF(reg[1], reg[2], reg[3]); gi = i; }
      else if (i < 32) { f = fG(reg[1], reg[2], reg[3]); gi = (5 * i + 1) % 16; }
      else if (i < 48) { f = fH(reg[1], reg[2], reg[3]); gi = (3 * i + 5) % 16; }
      else { f = fI(reg[1], reg[2], reg[3]); gi = (7 * i) % 16; }
      const tmp = add32(rl(add32(add32(reg[0], f), add32(w[gi], T[i])), S[i]), reg[1]);
      reg = [reg[3], tmp, reg[1], reg[2]];
    }
    a = add32(a, reg[0]); b = add32(b, reg[1]); c = add32(c, reg[2]); d = add32(d, reg[3]);
  }
  function hex(n) {
    let s = '';
    for (let j = 0; j < 4; j++) s += ('0' + ((n >> (j * 8)) & 0xff).toString(16)).slice(-2);
    return s;
  }
  return hex(a) + hex(b) + hex(c) + hex(d);
}

// ── LCS diff（用于 diff 命令）──
function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: ' ', v: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', v: a[i] }); i++; }
    else { out.push({ t: '+', v: b[j] }); j++; }
  }
  while (i < n) out.push({ t: '-', v: a[i++] });
  while (j < m) out.push({ t: '+', v: b[j++] });
  return out;
}

// ── 安全算术（bc / expr / $(( )) / test 数值比较）──
function arithEval(expr) {
  const s = String(expr).replace(/\$\{?(\w+)\}?|\b([A-Za-z_]\w*)\b/g, (m, dn, bn) => {
    if (dn !== undefined) return CUR_ENV ? getVar(dn) : '';
    if (CUR_ENV && CUR_ENV.vars[bn] !== undefined) return CUR_ENV.vars[bn];
    return m;
  });
  const toks = s.match(/\d+\.?\d*|[+\-*/%<>=!&|^~()]+|\s+/g) || [];
  let p = 0;
  const peek = () => toks[p];
  const eat = () => toks[p++];
  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function factor() {
    while (peek() && /^\s+$/.test(peek())) eat();
    let t = eat();
    if (t === undefined) return 0;
    if (/^\s+$/.test(t)) t = eat();
    if (t === '(') { const v = ternary(); if (peek() === ')') eat(); return v; }
    if (t === '-') return -factor();
    if (t === '+') return factor();
    if (t === '~') return ~num(factor());
    if (t === '!') return factor() ? 0 : 1;
    return num(t);
  }
  function mul() {
    let v = factor();
    for (;;) {
      while (peek() && /^\s+$/.test(peek())) eat();
      const t = peek();
      if (t === '*' || t === '/' || t === '%') { eat(); const r = factor(); v = t === '*' ? v * r : t === '/' ? v / r : v % r; }
      else break;
    }
    return v;
  }
  function add() {
    let v = mul();
    for (;;) {
      while (peek() && /^\s+$/.test(peek())) eat();
      const t = peek();
      if (t === '+' || t === '-') { eat(); const r = mul(); v = t === '+' ? v + r : v - r; }
      else break;
    }
    return v;
  }
  function cmp() {
    let v = add();
    while (peek() && /^\s+$/.test(peek())) eat();
    const t = peek();
    if (t === '<' || t === '>' || t === '<=' || t === '>=') { eat(); const r = add(); v = t === '<' ? (v < r ? 1 : 0) : t === '>' ? (v > r ? 1 : 0) : t === '<=' ? (v <= r ? 1 : 0) : (v >= r ? 1 : 0); }
    return v;
  }
  function eq() {
    let v = cmp();
    while (peek() && /^\s+$/.test(peek())) eat();
    const t = peek();
    if (t === '==' || t === '!=') { eat(); const r = cmp(); v = t === '==' ? (v === r ? 1 : 0) : (v !== r ? 1 : 0); }
    return v;
  }
  function band() { let v = eq(); while (peek() === '&') { eat(); v = v & eq(); } return v; }
  function bxor() { let v = band(); while (peek() === '^') { eat(); v = v ^ band(); } return v; }
  function bor() { let v = bxor(); while (peek() === '|') { eat(); v = v | bxor(); } return v; }
  function land() { let v = bor(); while (peek() === '&&') { eat(); const r = bor(); v = (v && r) ? 1 : 0; } return v; }
  function lor() { let v = land(); while (peek() === '||') { eat(); const r = land(); v = (v || r) ? 1 : 0; } return v; }
  function ternary() {
    let v = lor();
    while (peek() && /^\s+$/.test(peek())) eat();
    if (peek() === '?') { eat(); const a = ternary(); if (peek() === ':') eat(); const b = ternary(); v = v ? a : b; }
    return v;
  }
  try { return ternary(); } catch { return 0; }
}
function formatBc(v) { return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10); }
function bcEval(expr) { return formatBc(arithEval(expr)); }

// ── 变量与环境 ──
function getVar(name) {
  if (CUR_ENV && CUR_ENV.vars[name] !== undefined) return CUR_ENV.vars[name];
  return '';
}
function setVar(name, val) { if (CUR_ENV) CUR_ENV.vars[name] = val; }

// 展开 $VAR / ${VAR} / $(cmd) / $((arith)) / $? / $0..$9 / $@
function expandDollar(str, env) {
  let out = '';
  let i = 0;
  const e = env || CUR_ENV;
  while (i < str.length) {
    const ch = str[i];
    if (ch !== '$') { out += ch; i++; continue; }
    if (str[i + 1] === '(') {
      if (str[i + 2] === '(') {
        const end = str.indexOf('))', i + 3);
        if (end < 0) { out += ch; i++; continue; }
        out += formatBc(arithEval(str.slice(i + 3, end)));
        i = end + 2; continue;
      }
      let depth = 1, j = i + 2;
      while (j < str.length && depth > 0) { if (str[j] === '(') depth++; else if (str[j] === ')') depth--; if (depth === 0) break; j++; }
      if (depth !== 0) { out += ch; i++; continue; }
      out += captureShell(str.slice(i + 2, j));
      i = j + 1; continue;
    }
    if (str[i + 1] === '{') {
      const end = str.indexOf('}', i + 2);
      if (end < 0) { out += ch; i++; continue; }
      out += getVar(str.slice(i + 2, end));
      i = end + 1; continue;
    }
    const nm = str.slice(i + 1).match(/^[A-Za-z_]\w*/);
    if (nm) { out += getVar(nm[0]); i += 1 + nm[0].length; continue; }
    const nx = str[i + 1];
    if (nx === '?') { out += String(LAST_EXIT); i += 2; continue; }
    if (nx === '0') { out += (e && e.name) || 'bash'; i += 2; continue; }
    if (nx === '#') { out += String(e && e.pos ? e.pos.length : 0); i += 2; continue; }
    if (nx === '@' || nx === '*') { out += (e && e.pos ? e.pos.join(' ') : ''); i += 2; continue; }
    if (nx >= '1' && nx <= '9') { out += (e && e.pos ? (e.pos[parseInt(nx) - 1] || '') : ''); i += 2; continue; }
    out += ch; i++;
  }
  return out;
}

// 按引号感知展开并【保留引号】：单引号内原样保留（保护 awk '$2>28' 这类程序），
// 双引号内展开 $VAR/$() 但保留双引号本身，交由后续 tokenize 处理词边界。
function expand(s, env) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      let j = s.indexOf("'", i + 1);
      if (j < 0) j = s.length - 1;
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, buf = '';
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { buf += s[j] + s[j + 1]; j += 2; } else { buf += s[j]; j++; } }
      out += '"' + expandDollar(buf, env) + '"';
      i = j + 1; continue;
    }
    let j = i, buf = '';
    while (j < s.length && s[j] !== "'" && s[j] !== '"') { buf += s[j]; j++; }
    out += expandDollar(buf, env); i = j;
  }
  return out;
}

// 展开后再按空白切词（用于 for 列表 / 命令参数）
function splitWords(s, env) {
  const ex = expand(s, env);
  const toks = []; let c = '', q = null;
  for (const ch of ex) {
    if (q) { if (ch === q) q = null; else c += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ' ' || ch === '\t') { if (c) { toks.push(c); c = ''; } }
    else c += ch;
  }
  if (c) toks.push(c);
  return toks;
}

// ── 脚本解释器 ──
// 把脚本规范化为「一行一条语句」：拆分顶层 ; 与 ;;、把 { } 独立成行、
// 把 then/do/else/elif/fi/done/esac 等关键字独立成行；尊重引号与括号
// （保护 C 风格 for((...;...;...)) 与 $(...) 不被拆开）。
function normalizeCode(code) {
  const out = [];
  let cur = '';
  const flush = () => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  let q = null, paren = 0, varBrace = 0;
  const KW = new Set(['then', 'do', 'else', 'elif', 'fi', 'done', 'esac']);
  const isWord = c => /[A-Za-z0-9_]/.test(c);
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '\n') { flush(); continue; }
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '#') { while (i < code.length && code[i] !== '\n') i++; flush(); continue; }
    // ${VAR} / ${VAR:-x} 变量展开：整体保留，不被 { } 拆分逻辑切碎
    if (varBrace > 0) { cur += c; if (c === '{') varBrace++; else if (c === '}') varBrace--; continue; }
    if (c === '$' && code[i + 1] === '{') { cur += '${'; varBrace++; i++; continue; }
    if (c === '(') { paren++; cur += c; continue; }
    if (c === ')') { paren = Math.max(0, paren - 1); cur += c; continue; }
    if (paren > 0) { cur += c; continue; }
    if (c === ';') {
      if (code[i + 1] === ';') { flush(); out.push(';;'); i++; continue; }
      flush(); continue;
    }
    if (c === '{') { flush(); out.push('{'); continue; }
    if (c === '}') { flush(); out.push('}'); continue; }
    if (isWord(c) && (cur === '' || /\s$/.test(cur))) {
      const m = code.slice(i).match(/^[A-Za-z_]\w*/);
      const word = m ? m[0] : '';
      const after = code[i + word.length];
      const boundary = after === undefined || /[\s;)}|&]/.test(after);
      if (KW.has(word) && boundary && (cur === '' || /\s$/.test(cur))) {
        flush(); out.push(word); i += word.length - 1; continue;
      }
    }
    cur += c;
  }
  flush();
  return out;
}

function parseProgram(code) {
  const lines = typeof code === 'string' ? normalizeCode(code) : code;
  const st = { lines, i: 0 };
  const body = parseSeq(st, null);
  return body;
}
function peekLine(st) { return st.i < st.lines.length ? st.lines[st.i] : null; }
function peekWord(st) { const l = peekLine(st); return l === null ? null : firstWord(l); }
const CLOSE_KW = new Set(['fi', 'done', 'esac', 'else', 'elif', '}', ';;']);
function parseSeq(st, stopExtra) {
  const seq = [];
  for (;;) {
    const line = peekLine(st);
    if (line === null) break;
    const w = firstWord(line);
    if (CLOSE_KW.has(w)) break;
    if (stopExtra && stopExtra.has(w)) break;
    seq.push(parseStmt(st));
  }
  return seq;
}
function parseStmt(st) {
  const line = st.lines[st.i];
  const w = firstWord(line);
  if (w === 'if') return parseIf(st);
  if (w === 'for') return parseFor(st);
  if (w === 'while' || w === 'until') return parseWhile(st);
  if (w === 'case') return parseCase(st);
  if (isFuncDef(line)) return parseFunc(st);
  if (w === '{') { st.i++; const body = parseSeq(st, null); if (peekWord(st) === '}') st.i++; return { type: 'group', body }; }
  st.i++;
  return { type: 'cmd', line };
}
// 提取并解析写在关键字同一行上的条件（如 `if [ $x -gt 5 ]` / `while [ $n -lt 3 ]`）
function inlineCond(st, kwRegex) {
  const line = st.lines[st.i] || '';
  const rest = line.replace(kwRegex, '').trim();
  return rest ? parseProgram(rest) : [];
}
function parseIf(st) {
  let cond = inlineCond(st, /^if\b/);
  st.i++;
  const node = { type: 'if', branches: [], els: null };
  for (;;) {
    cond = cond.concat(parseSeq(st, new Set(['then', 'else', 'elif', 'fi'])));
    let body = [];
    const w = peekWord(st);
    if (w === 'then') { st.i++; body = parseSeq(st, new Set(['else', 'elif', 'fi'])); }
    node.branches.push({ cond, body });
    const nw = peekWord(st);
    if (nw === 'elif') { cond = inlineCond(st, /^elif\b/); st.i++; continue; }
    if (nw === 'else') { st.i++; node.els = parseSeq(st, new Set(['fi'])); if (peekWord(st) === 'fi') st.i++; break; }
    if (nw === 'fi') { st.i++; break; }
    break;
  }
  return node;
}
function parseFor(st) {
  const line = st.lines[st.i]; st.i++;
  const node = { type: 'for', var: '', list: null, body: [], cstyle: null };
  const cm = line.match(/^for\s*\(\s*\((.*)\)\s*\)\s*$/);
  if (cm) {
    const parts = cm[1].split(';').map(s => s.trim());
    node.cstyle = { init: parts[0] || '', cond: parts[1] || '', step: parts[2] || '' };
  } else {
    const m = line.match(/^for\s+([A-Za-z_]\w*)(?:\s+in\s*(.*))?$/);
    node.var = m ? m[1] : 'i';
    node.list = m && m[2] !== undefined ? m[2] : null;
  }
  if (peekWord(st) === 'do') st.i++;
  node.body = parseSeq(st, new Set(['done']));
  if (peekWord(st) === 'done') st.i++;
  return node;
}
function parseWhile(st) {
  const kind = firstWord(st.lines[st.i]);
  let cond = inlineCond(st, /^(while|until)\b/);
  st.i++;
  cond = cond.concat(parseSeq(st, new Set(['do'])));
  let body = [];
  if (peekWord(st) === 'do') { st.i++; body = parseSeq(st, new Set(['done'])); }
  if (peekWord(st) === 'done') st.i++;
  return { type: 'while', kind, cond, body };
}
function parseCase(st) {
  const line = st.lines[st.i]; st.i++;
  const m = line.match(/^case\s+(.*?)\s+in$/);
  const word = m ? m[1] : '';
  const clauses = [];
  for (;;) {
    const l = peekLine(st);
    if (l === null) break;
    const w = firstWord(l);
    if (w === 'esac') { st.i++; break; }
    if (l.trim() === ';;') { st.i++; continue; }
    const cm = l.match(/^(.*?)\)\s*(.*)$/);
    if (!cm) { st.i++; continue; }
    const patterns = cm[1].replace(/^\(/, '').split('|').map(s => s.trim());
    const first = cm[2];
    st.i++;
    const bodyLines = [];
    if (first.trim()) bodyLines.push(first);
    while (peekLine(st) !== null && peekWord(st) !== 'esac') {
      const pl = peekLine(st);
      if (pl.trim() === ';;') { st.i++; break; }
      bodyLines.push(pl); st.i++;
    }
    clauses.push({ patterns, body: parseProgram(bodyLines) });
  }
  return { type: 'case', word, clauses };
}
function isFuncDef(line) {
  return /^(function\s+[A-Za-z_]\w*|[A-Za-z_]\w*\s*\(\s*\))/.test(line);
}
function parseFunc(st) {
  const line = st.lines[st.i]; st.i++;
  const m = line.match(/^(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\s*\))?/);
  const name = m ? m[1] : 'f';
  let body = [];
  const nw = peekWord(st);
  if (nw === '{') { st.i++; body = parseSeq(st, null); if (peekWord(st) === '}') st.i++; }
  else body = [parseStmt(st)];
  return { type: 'func', name, body };
}
function firstWord(line) { const m = line.match(/^\s*(\S+)/); return m ? m[1] : ''; }

// ── 语句执行 ──
const FLOW = {}; // break/continue/return/exit 信号
function execStmts(stmts, env) {
  for (const s of stmts) { const sig = execStmt(s, env); if (sig) return sig; }
  return null;
}
function execStmt(node, env) {
  switch (node.type) {
    case 'cmd': return execCmd(node.line, env);
    case 'group': return execStmts(node.body, env);
    case 'if': return execIf(node, env);
    case 'for': return execFor(node, env);
    case 'while': return execWhile(node, env);
    case 'case': return execCase(node, env);
    case 'func': env.funcs[node.name] = node.body; return null;
    default: return null;
  }
}
function execIf(node, env) {
  for (const br of node.branches) {
    if (evalCondition(br.cond, env)) return execStmts(br.body, env);
  }
  if (node.els) return execStmts(node.els, env);
  return null;
}
function execFor(node, env) {
  let items;
  if (node.cstyle) {
    const { init, cond, step } = node.cstyle;
    if (init) evalArithAssign(init, env);
    let guard = 0;
    while (guard++ < 10000 && (!cond || arithEval(substVars(cond, env)) !== 0)) {
      const sig = execStmts(node.body, env);
      if (sig === FLOW) { if (CUR_ENV._flow === 'break') { CUR_ENV._flow = null; break; } if (CUR_ENV._flow === 'return' || CUR_ENV._flow === 'exit') return sig; CUR_ENV._flow = null; }
      if (step) evalArithAssign(step, env);
    }
    return null;
  }
  if (node.list === null) items = env.pos ? [...env.pos] : [];
  else items = splitWords(node.list, env);
  for (const it of items) {
    env.vars[node.var] = it;
    const sig = execStmts(node.body, env);
    if (sig === FLOW) {
      if (CUR_ENV._flow === 'break') { CUR_ENV._flow = null; break; }
      if (CUR_ENV._flow === 'return' || CUR_ENV._flow === 'exit') return sig;
      CUR_ENV._flow = null;
    }
  }
  return null;
}
function execWhile(node, env) {
  let guard = 0;
  for (;;) {
    if (guard++ > 10000) break;
    let c = evalCondition(node.cond, env);
    if (node.kind === 'until') c = !c;
    if (!c) break;
    const sig = execStmts(node.body, env);
    if (sig === FLOW) {
      if (CUR_ENV._flow === 'break') { CUR_ENV._flow = null; break; }
      if (CUR_ENV._flow === 'return' || CUR_ENV._flow === 'exit') return sig;
      CUR_ENV._flow = null;
    }
  }
  return null;
}
function execCase(node, env) {
  const val = expand(node.word, env);
  for (const cl of node.clauses) {
    if (cl.patterns.some(p => p === '*' || globMatch(p, val))) {
      const sig = execStmts(cl.body, env);
      if (sig) return sig;
      break;
    }
  }
  return null;
}
function callFunc(name, args, env) {
  const body = env.funcs[name];
  if (!body) return;
  const child = { vars: Object.create(env.vars), funcs: env.funcs, pos: args, exit: 0, name };
  Object.setPrototypeOf(child.vars, env.vars);
  const prev = CUR_ENV; CUR_ENV = child;
  try { execStmts(body, child); } finally { CUR_ENV = prev; }
  LAST_EXIT = child.exit || 0;
}
function evalCondition(stmts, env) {
  let ok = false;
  for (const s of stmts) {
    if (s.type === 'cmd') {
      const line = s.line.trim();
      const am = line.match(/^\[\[(.*)\]\]$/);
      if (am) { ok = !!evalCondExpr(am[1], env); continue; }
      const r = execCmd(line, env);
      if (r === FLOW) return false;
      ok = LAST_EXIT === 0;
    } else {
      const sig = execStmt(s, env);
      if (sig) return false;
      ok = LAST_EXIT === 0;
    }
  }
  return ok;
}
function substVars(s, env) { return expand(s, env); }
function evalCondExpr(inner, env) {
  const ex = expand(inner, env).trim();
  if (/^[+-]?\d/.test(ex) && /[<>=!]=?/.test(ex)) return arithEval(ex) !== 0;
  const m = ex.match(/^(.*?)\s*(==|!=|=~|-eq|-ne|-lt|-le|-gt|-ge)\s*(.*)$/);
  if (!m) return ex.length > 0;
  const l = m[1].trim(), op = m[2], r = m[3].trim();
  const ln = parseFloat(l), rn = parseFloat(r);
  const numeric = !isNaN(ln) && !isNaN(rn);
  switch (op) {
    case '==': return l === r;
    case '!=': return l !== r;
    case '=~': try { return new RegExp(r).test(l); } catch { return false; }
    case '-eq': return numeric && ln === rn;
    case '-ne': return numeric && ln !== rn;
    case '-lt': return numeric && ln < rn;
    case '-le': return numeric && ln <= rn;
    case '-gt': return numeric && ln > rn;
    case '-ge': return numeric && ln >= rn;
    default: return false;
  }
}
function evalArithAssign(expr, env) {
  const m = expr.match(/^\s*([A-Za-z_]\w*)\s*([-+*/]?=)\s*(.*)$/);
  if (!m) return arithEval(expr);
  const name = m[1], op = m[2], rhs = m[3];
  const cur = parseFloat(getVar(name)) || 0;
  let val;
  if (op === '=') val = arithEval(rhs);
  else if (op === '+=') val = cur + arithEval(rhs);
  else if (op === '-=') val = cur - arithEval(rhs);
  else if (op === '*=') val = cur * arithEval(rhs);
  else val = Math.trunc(cur / arithEval(rhs));
  setVar(name, formatBc(val));
  return val;
}
function applyAliases(line) {
  const w = firstWord(line);
  if (aliases[w]) return line.replace(/^\s*\S+/, aliases[w]);
  return line;
}
function processAssignValue(raw, env) {
  let v = raw;
  const am = v.match(/^\$\(\((.*)\)\)$/);
  if (am) return formatBc(arithEval(am[1]));
  const cm = v.match(/^\$\((?!\()(.*)\)$/);
  if (cm) return captureShell(cm[1]);
  v = expand(v, env);
  const sm = v.match(/^([A-Za-z_]\w*)([+\-])=(.*)$/);
  if (sm) {
    const cur = getVar(sm[1]);
    return sm[2] === '+' ? cur + sm[3] : cur.replace(new RegExp(sm[3].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
  }
  return v;
}
function execCmd(rawLine, env) {
  let line = applyAliases(String(rawLine).trim());
  if (!line || line.startsWith('#')) return null;
  const wm = line.match(/^([A-Za-z_]\w*)=(.*)$/);
  if (wm && !/\s/.test(wm[1])) {
    setVar(wm[1], processAssignValue(wm[2], env));
    return null;
  }
  const w = firstWord(line);
  const rest = line.slice(w.length).trim();
  if (w === 'break') { CUR_ENV._flow = 'break'; return FLOW; }
  if (w === 'continue') { CUR_ENV._flow = 'continue'; return FLOW; }
  if (w === 'return') { CUR_ENV._flow = 'return'; CUR_ENV.exit = rest ? (parseInt(expand(rest, env)) || 0) : 0; LAST_EXIT = CUR_ENV.exit; return FLOW; }
  if (w === 'exit') { CUR_ENV._flow = 'exit'; CUR_ENV.exit = rest ? (parseInt(expand(rest, env)) || 0) : 0; LAST_EXIT = CUR_ENV.exit; return FLOW; }
  if (w === 'local' || w === 'export' || w === 'declare' || w === 'readonly') {
    for (const part of rest.split(/\s+/)) {
      const m = part.match(/^([A-Za-z_]\w*)=(.*)$/);
      if (m) setVar(m[1], processAssignValue(m[2], env));
    }
    return null;
  }
  if (w === 'unset') { for (const n of rest.split(/\s+/)) if (env.vars[n] !== undefined) delete env.vars[n]; return null; }
  if (w === 'read') {
    const names = rest.split(/\s+/).filter(x => x && !x.startsWith('-'));
    const stdin = '';
    const val = stdin.split('\n')[0] !== undefined ? stdin.split('\n')[0] : '';
    if (names.length) setVar(names[0], val || 'input');
    return null;
  }
  if (env.funcs && env.funcs[w]) {
    callFunc(w, splitWords(rest, env), env);
    return null;
  }
  const exline = expand(line, env);
  const r = runPipeline(exline);
  LAST_EXIT = r.exit || 0;
  if (env) env.exit = LAST_EXIT;
  if (r.err) { print([].concat(r.err).join('\n'), 'err'); sfx(r.sfx || 'err-file'); }
  else if (r.out && r.out.length) r.out.forEach(l => print(l, 'out'));
  return null;
}
function runScript(code, baseEnv) {
  const prevEnv = CUR_ENV;
  const prevScript = app.inScript;
  const env = baseEnv || { vars: {}, funcs: {}, pos: [], exit: 0, name: 'bash' };
  CUR_ENV = env;
  app.inScript = true;
  try {
    const stmts = parseProgram(code);
    execStmts(stmts, env);
  } catch (e) {
    print(`bash: 脚本执行出错（已忽略）`, 'err');
  } finally {
    CUR_ENV = prevEnv;
    app.inScript = prevScript;
  }
  LAST_EXIT = env.exit || 0;
}

// ── test / [ 条件求值 ──
function testEval(args) {
  const a = args.map(x => String(x).replace(/^["']|["']$/g, ''));
  const isNum = s => s !== '' && !isNaN(Number(s));
  let expr = a;
  if (expr[0] === '[') expr = expr.slice(1);
  if (expr.length >= 2 && expr[expr.length - 1] === ']') expr = expr.slice(0, -1);
  const neg = expr[0] === '!';
  if (neg) expr = expr.slice(1);
  let res;
  const n = expr.length;
  if (n === 0) res = false;
  else if (n === 1) res = expr[0].length > 0;
  else if (n === 2) {
    const op = expr[0], v = expr[1];
    res = op === '-z' ? v.length === 0
      : op === '-n' ? v.length > 0
      : op === '-e' || op === '-f' ? G.files[v] !== undefined
      : op === '-d' ? false
      : op === '-s' ? (G.files[v] || '').length > 0
      : op === '-r' || op === '-w' || op === '-x' ? G.files[v] !== undefined
      : v.length > 0;
  } else if (n === 3) {
    const l = expr[0], op = expr[1], r = expr[2];
    const ln = Number(l), rn = Number(r);
    switch (op) {
      case '=': case '==': res = l === r; break;
      case '!=': res = l !== r; break;
      case '-eq': res = isNum(l) && isNum(r) && ln === rn; break;
      case '-ne': res = isNum(l) && isNum(r) && ln !== rn; break;
      case '-lt': res = isNum(l) && isNum(r) && ln < rn; break;
      case '-le': res = isNum(l) && isNum(r) && ln <= rn; break;
      case '-gt': res = isNum(l) && isNum(r) && ln > rn; break;
      case '-ge': res = isNum(l) && isNum(r) && ln >= rn; break;
      default: res = l.length > 0;
    }
  } else res = expr.join(' ').length > 0;
  return neg ? !res : res;
}

// ── 命令处理器 ──
const SHELL = {
  // ===== 文本处理 =====
  grep: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const rest = a.filter(x => !x.startsWith('-'));
    if (!rest.length) return { out: [], err: ['用法: grep [选项] 模式 [文件]'] };
    let pattern = rest[0].replace(/^["']|["']$/g, '');
    if (flags.includes('w')) pattern = `\\b(?:${pattern})\\b`;
    let lines, fname = '(stdin)';
    if (rest[1]) {
      const c = readF(rest[1]);
      if (c === null) return { out: [], err: [`grep: ${rest[1]}: 没有那个文件`] };
      lines = c.split('\n'); fname = rest[1];
    } else lines = stdin.split('\n');
    let re;
    try { re = new RegExp(pattern, flags.includes('i') ? 'i' : ''); }
    catch { return { out: [], err: [`grep: 无效的正则: ${pattern}`] }; }
    let matched = lines.map((l, i) => ({ l, i })).filter(({ l }) => re.test(l));
    if (flags.includes('v')) matched = lines.map((l, i) => ({ l, i })).filter(({ l }) => !re.test(l));
    const exit = matched.length ? 0 : 1;
    if (flags.includes('q')) return { out: [], mutated: false, exit };
    if (flags.includes('c')) return { out: [String(matched.length)], mutated: false, sfx: 'text-grep', exit };
    if (flags.includes('l')) return { out: matched.length ? [fname] : [], mutated: false, sfx: 'text-grep', exit };
    return { out: matched.map(({ l, i }) => flags.includes('n') ? `${i + 1}:${l}` : l), mutated: false, sfx: 'text-grep', exit };
  },

  sed: (a, stdin) => {
    // sed [-i] 's/旧/新/[g]' [文件] 或 sed [-i] 'N[,M]d' [文件]（删除第 N 行 / 第 N~M 行）
    const inplace = a.includes('-i');
    const rest = a.filter(x => x !== '-i');
    const expr = rest[0]?.replace(/^["']|["']$/g, '');
    const file = rest[1];
    const dm = expr ? expr.match(/^(\d+)(?:,(\d+))?d$/) : null;
    if (dm) {
      const s = parseInt(dm[1]), e2 = dm[2] ? parseInt(dm[2]) : s;
      const del = text => text.split('\n').filter((_, i) => i + 1 < s || i + 1 > e2).join('\n');
      if (file) {
        const c = readF(file);
        if (c === null) return { out: [], err: [`sed: ${file}: 没有那个文件`] };
        if (inplace) { G.files[file] = del(c); return { out: [], sfx: 'file-write' }; }
        return { out: del(c).split('\n'), mutated: false };
      }
      return { out: del(stdin).split('\n'), mutated: false };
    }
    if (!expr || !expr.startsWith('s/')) return { out: [], err: ['用法: sed [-i] \'s/旧/新/[g]\' [文件] 或 sed [-i] \'N[,M]d\' [文件]'] };
    const parts = expr.split('/');
    if (parts.length < 3) return { out: [], err: [`sed: 无效表达式: ${expr}`] };
    const [, pat, rep, g] = parts;
    let re;
    try { re = new RegExp(pat, g === 'g' ? 'g' : ''); }
    catch { return { out: [], err: [`sed: 无效的正则: ${pat}`] }; }
    if (file) {
      const c = readF(file);
      if (c === null) return { out: [], err: [`sed: ${file}: 没有那个文件`] };
      const out = c.split('\n').map(l => l.replace(re, rep));
      if (inplace) { G.files[file] = out.join('\n'); return { out: [], sfx: 'file-write' }; }
      return { out, mutated: false };
    }
    return { out: stdin.split('\n').map(l => l.replace(re, rep)), mutated: false };
  },

  awk: (a, stdin) => {
    // awk [-F 分隔符] '{print $N}' [文件] 或 awk -F, '$2 > 28 {print $1}' [文件]
    const args = [...a];
    let sep = null; // null = 默认按空白切分
    const fi = args.indexOf('-F');
    if (fi >= 0) { sep = String(args[fi + 1] ?? '').replace(/^["']|["']$/g, ''); args.splice(fi, 2); }
    const fj = args.findIndex(x => x.startsWith('-F') && x.length > 2); // -F, 连写形式
    if (fj >= 0) { sep = args[fj].slice(2); args.splice(fj, 1); }
    const prog = (args[0] || '').replace(/^["']+|["']+$/g, '');
    const file = args[1];
    let lines;
    if (file) {
      const c = readF(file);
      if (c === null) return { out: [], err: [`awk: ${file}: 没有那个文件`] };
      lines = c.split('\n').filter(l => l);
    } else lines = stdin.split('\n').filter(l => l);
    const fields = l => sep ? l.split(sep) : l.split(/\s+/).filter(Boolean);
    // 条件形式：$N 比较 值 [{动作}]（缺省动作打印整行）
    const cm = prog.match(/^\$(\d+)\s*(>=|<=|==|!=|>|<)\s*("[^"]*"|\S+)\s*(?:\{(.*)\})?$/);
    if (cm) {
      const n = parseInt(cm[1]), op = cm[2];
      const tv = cm[3].replace(/^"|"$/g, '');
      const body = cm[4] !== undefined ? cm[4].trim() : null;
      const tn = parseFloat(tv);
      const pass = l => {
        const fv = fields(l)[n - 1] ?? '';
        const fn = parseFloat(fv);
        const numeric = !isNaN(fn) && !isNaN(tn);
        const x = numeric ? fn : fv, y = numeric ? tn : tv;
        switch (op) {
          case '>': return x > y; case '<': return x < y;
          case '>=': return x >= y; case '<=': return x <= y;
          case '==': return x === y; default: return x !== y;
        }
      };
      const sel = lines.filter(pass);
      return {
        out: sel.map(l => {
          if (!body) return l;
          const bm = body.match(/print\s*(.*)/);
          if (!bm || !bm[1].trim()) return l;
          return bm[1].replace(/\$(\d+)/g, (_, d) => d === '0' ? l : (fields(l)[parseInt(d) - 1] || ''));
        }),
        mutated: false,
      };
    }
    const pm = prog.replace(/^\{|\}$/g, '').match(/print\s+(.*)/);
    if (!pm) return { out: [], err: ['用法: awk [-F 分隔符] \'{print $1}\' [文件] 或 \'$2 > N {print $1}\''] };
    return {
      out: lines.map(l => {
        const fs = fields(l);
        return pm[1].replace(/\$(\d+)/g, (_, n) => fs[parseInt(n) - 1] || '');
      }),
      mutated: false,
    };
  },

  sort: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const skip = new Set();
    let keyIdx = 0, sep = null;
    const ki = a.indexOf('-k');
    if (ki >= 0) { keyIdx = parseInt(a[ki + 1]) || 1; skip.add(ki); skip.add(ki + 1); }
    const ti = a.indexOf('-t');
    if (ti >= 0) { sep = a[ti + 1]; skip.add(ti); skip.add(ti + 1); }
    let file = null;
    a.forEach((x, i) => { if (!x.startsWith('-') && !skip.has(i) && file === null) file = x; });
    let lines = (file ? readF(file) || '' : stdin).split('\n').filter(l => l);
    if (keyIdx > 0) {
      const keyOf = l => {
        const parts = sep ? l.split(sep) : l.split(/\s+/).filter(Boolean);
        return parts[keyIdx - 1] ?? '';
      };
      lines.sort((x, y) => {
        const kx = keyOf(x), ky = keyOf(y);
        if (flags.includes('n')) return parseFloat(kx) - parseFloat(ky);
        return kx < ky ? -1 : kx > ky ? 1 : 0;
      });
    } else if (flags.includes('n')) lines.sort((x, y) => parseFloat(x) - parseFloat(y));
    else lines.sort();
    if (flags.includes('r')) lines.reverse();
    if (flags.includes('u')) lines = [...new Set(lines)];
    return { out: lines, mutated: false };
  },

  uniq: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const file = a.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const lines = text.split('\n');
    const groups = [];
    let prev = null, count = 0;
    for (const l of lines) { if (l === prev) count++; else { if (prev !== null) groups.push([prev, count]); prev = l; count = 1; } }
    if (prev !== null) groups.push([prev, count]);
    let gs = groups;
    if (flags.includes('d')) gs = gs.filter(([, c]) => c > 1);
    else if (flags.includes('u')) gs = gs.filter(([, c]) => c === 1);
    const out = gs.map(([l, c]) => flags.includes('c') ? `${String(c).padStart(4)} ${l}` : l);
    return { out, mutated: false };
  },

  wc: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const file = a.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const lines = text.split('\n').filter(l => l).length;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (flags.includes('l')) return { out: [String(lines)], mutated: false };
    if (flags.includes('w')) return { out: [String(words)], mutated: false };
    if (flags.includes('c')) return { out: [String(text.length)], mutated: false };
    return { out: [`  ${lines}  ${words} ${text.length}`], mutated: false };
  },

  head: (a, stdin) => {
    let n = 10; const args = [...a];
    const ni = args.indexOf('-n');
    if (ni >= 0) { n = parseInt(args[ni + 1]) || 10; args.splice(ni, 2); }
    else { const sm = args.findIndex(x => /^-\d+$/.test(x)); if (sm >= 0) { n = parseInt(args[sm].slice(1)) || 10; args.splice(sm, 1); } }
    const file = args.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    return { out: text.split('\n').slice(0, n), mutated: false };
  },

  tail: (a, stdin) => {
    let n = 10, from = null; const args = [...a];
    const ni = args.indexOf('-n');
    if (ni >= 0) {
      const v = args[ni + 1];
      if (typeof v === 'string' && v.startsWith('+')) from = Math.max(1, parseInt(v.slice(1)) || 1);
      else n = parseInt(v) || 10;
      args.splice(ni, 2);
    } else {
      const sm = args.findIndex(x => /^-\+?\d+$/.test(x));
      if (sm >= 0) { const v = args[sm]; if (v.startsWith('-+')) from = Math.max(1, parseInt(v.slice(2)) || 1); else n = parseInt(v.slice(1)) || 10; args.splice(sm, 1); }
    }
    const file = args.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const lines = text.split('\n');
    if (from !== null) return { out: lines.slice(from - 1), mutated: false };
    return { out: lines.slice(Math.max(0, lines.length - n)), mutated: false };
  },

  cut: (a, stdin) => {
    // cut -d 分隔符 -f 列表 [文件]（-f N / N-M / N,M）
    let d = '\t'; const args = [...a];
    const di = args.indexOf('-d');
    if (di >= 0) { d = String(args[di + 1] ?? '\t').replace(/^["']|["']$/g, ''); args.splice(di, 2); }
    const dj = args.findIndex(x => x.startsWith('-d') && x.length > 2);
    if (dj >= 0) { d = args[dj].slice(2); args.splice(dj, 1); }
    let fields = null;
    const fi = args.indexOf('-f');
    if (fi >= 0) { fields = args[fi + 1]; args.splice(fi, 2); }
    const fj = args.findIndex(x => x.startsWith('-f') && x.length > 2);
    if (fj >= 0) { fields = args[fj].slice(2); args.splice(fj, 1); }
    const ci = args.indexOf('-c');
    if (ci >= 0 && fields === null) { fields = args[ci + 1]; args.splice(ci, 2); }
    if (fields === null) return { out: [], err: ['用法: cut -d 分隔符 -f N[,N|M-N] [文件]'] };
    const file = args.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const sel = [];
    for (const part of String(fields).split(',')) {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) continue;
      const s = parseInt(m[1]), e2 = m[2] ? parseInt(m[2]) : s;
      for (let k = s; k <= e2; k++) if (!sel.includes(k)) sel.push(k);
    }
    const isChar = args.includes('-c') || ci >= 0;
    const out = text.split('\n').filter(l => l.length).map(l => {
      if (isChar) return sel.map(k => l[k - 1] || '').join('');
      const fs = l.split(d);
      return sel.map(k => fs[k - 1] ?? '').join(d);
    });
    return { out, mutated: false };
  },

  tr: (a, stdin) => {
    // tr [-d 集合] [-s 集合] [集合1 [集合2]]
    const del = a.includes('-d');
    const sq = a.includes('-s');
    const rest = a.filter(x => !x.startsWith('-'));
    const expandSet = s => {
      if (!s) return [];
      const m = s.match(/^(.)-(.)$/);
      if (m) { const out = []; for (let c = m[1].charCodeAt(0); c <= m[2].charCodeAt(0); c++) out.push(String.fromCharCode(c)); return out; }
      return [...s];
    };
    let text = stdin;
    if (del) {
      const set = new Set(expandSet(rest[0]));
      text = [...text].filter(c => !set.has(c)).join('');
    } else if (rest.length >= 2) {
      const from = expandSet(rest[0]), to = expandSet(rest[1]);
      const map = {};
      from.forEach((c, i) => { map[c] = to[Math.min(i, to.length - 1)] ?? ''; });
      text = [...text].map(c => map[c] !== undefined ? map[c] : c).join('');
    }
    if (sq) {
      const set = new Set(expandSet(rest[rest.length - 1]));
      let out = ''; let prev = null;
      for (const c of text) { if (set.has(c) && c === prev) continue; out += c; prev = c; }
      text = out;
    }
    return { out: text.split('\n'), mutated: false };
  },

  paste: (a, stdin) => {
    // paste [-d 分隔符] 文件1 文件2 ...
    let d = '\t'; const args = [...a];
    const di = args.indexOf('-d');
    if (di >= 0) { d = String(args[di + 1] ?? '\t').replace(/^["']|["']$/g, ''); args.splice(di, 2); }
    const files = args.filter(x => !x.startsWith('-'));
    const cols = files.length ? files.map(f => (readF(f) || '').replace(/\n$/, '').split('\n')) : [inputLines(stdin)];
    const rows = Math.max(...cols.map(c => c.length), 0);
    const out = [];
    for (let i = 0; i < rows; i++) out.push(cols.map(c => c[i] ?? '').join(d));
    return { out, mutated: false };
  },

  join: (a, stdin) => {
    // join [-t 分隔符] [-1 N] [-2 N] 文件1 文件2
    let sep = /\s+/; const args = [...a];
    const ti = args.indexOf('-t');
    if (ti >= 0) { sep = String(args[ti + 1] ?? ' ').replace(/^["']|["']$/g, ''); args.splice(ti, 2); }
    let j1 = 1, j2 = 1;
    const i1 = args.indexOf('-1'); if (i1 >= 0) { j1 = parseInt(args[i1 + 1]) || 1; args.splice(i1, 2); }
    const i2 = args.indexOf('-2'); if (i2 >= 0) { j2 = parseInt(args[i2 + 1]) || 1; args.splice(i2, 2); }
    const files = args.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: join [-t 分隔符] 文件1 文件2'] };
    const split = l => sep === /\s+/ ? l.split(/\s+/).filter(Boolean) : l.split(sep);
    const A = (readF(files[0]) || '').replace(/\n$/, '').split('\n').filter(l => l).map(split);
    const B = (readF(files[1]) || '').replace(/\n$/, '').split('\n').filter(l => l).map(split);
    const out = [];
    for (const ra of A) for (const rb of B) {
      if (ra[j1 - 1] !== undefined && ra[j1 - 1] === rb[j2 - 1]) {
        const rest = [...ra.slice(0, j1 - 1), ...ra.slice(j1), ...rb.slice(0, j2 - 1), ...rb.slice(j2)];
        out.push([ra[j1 - 1], ...rest].join(' '));
      }
    }
    return { out, mutated: false };
  },

  comm: (a, stdin) => {
    // comm [-123] 文件1 文件2
    const flags = a.filter(x => x.startsWith('-')).join('');
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: comm [-1] [-2] [-3] 文件1 文件2'] };
    const A = (readF(files[0]) || '').replace(/\n$/, '').split('\n').filter(l => l);
    const B = (readF(files[1]) || '').replace(/\n$/, '').split('\n').filter(l => l);
    const setB = new Set(B), setA = new Set(A);
    const out = [];
    if (!flags.includes('1')) A.filter(x => !setB.has(x)).forEach(x => out.push(x));
    if (!flags.includes('2')) B.filter(x => !setA.has(x)).forEach(x => out.push('\t' + x));
    if (!flags.includes('3')) A.filter(x => setB.has(x)).forEach(x => out.push('\t\t' + x));
    return { out, mutated: false };
  },

  tee: (a, stdin) => {
    // tee [-a] 文件...（stdin 同时写文件并输出）
    const append = a.includes('-a');
    const files = a.filter(x => !x.startsWith('-'));
    const lines = inputLines(stdin);
    const content = lines.join('\n') + (lines.length ? '\n' : '');
    for (const f of files) G.files[f] = append ? (G.files[f] || '') + content : content;
    if (files.length) sfx('file-write');
    return { out: lines, mutated: !!files.length };
  },

  column: (a, stdin) => {
    // column -t [-s 分隔符]
    const table = a.includes('-t');
    let sep = /\s+/; const args = [...a];
    const si = args.indexOf('-s');
    if (si >= 0) { sep = String(args[si + 1] ?? ' ').replace(/^["']|["']$/g, ''); }
    const file = a.find(x => !x.startsWith('-') && x !== '-t');
    const text = file ? (readF(file) || '') : stdin;
    const lines = text.replace(/\n$/, '').split('\n').filter(l => l);
    if (!table) return { out: lines, mutated: false };
    const rows = lines.map(l => (sep === /\s+/ ? l.split(/\s+/).filter(Boolean) : l.split(sep)));
    const width = [];
    for (const r of rows) r.forEach((c, i) => { width[i] = Math.max(width[i] || 0, String(c).length); });
    const out = rows.map(r => r.map((c, i) => String(c).padEnd((width[i] || 0) + 2)).join('').replace(/\s+$/, ''));
    return { out, mutated: false };
  },

  rev: (a, stdin) => {
    const file = a.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    return { out: text.replace(/\n$/, '').split('\n').map(l => [...l].reverse().join('')), mutated: false };
  },

  tac: (a, stdin) => {
    const file = a.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    return { out: text.replace(/\n$/, '').split('\n').reverse(), mutated: false };
  },

  nl: (a, stdin) => {
    const file = a.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    let n = 0;
    const out = text.replace(/\n$/, '').split('\n').map(l => l ? `${String(++n).padStart(6)}\t${l}` : l);
    return { out, mutated: false };
  },

  find: (a, stdin) => {
    // find [路径] [-name 模式] [-iname] [-type f|d] [-maxdepth N] [-delete]
    let name = null, iname = null, type = null, del = false;
    let maxdepth = Infinity;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '-name') name = a[++i];
      else if (x === '-iname') iname = a[++i];
      else if (x === '-type') type = a[++i];
      else if (x === '-maxdepth') maxdepth = parseInt(a[++i]) || Infinity;
      else if (x === '-delete') del = true;
    }
    if (type === 'd') return { out: ['.'], mutated: false };
    let files = Object.keys(G.files).sort();
    files = files.filter(f => f.split('/').length <= maxdepth + 1);
    if (name) files = files.filter(f => globMatch(String(name).replace(/^["']|["']$/g, ''), f.split('/').pop()));
    if (iname) { const p = String(iname).replace(/^["']|["']$/g, '').toLowerCase(); files = files.filter(f => globMatch(p, f.split('/').pop().toLowerCase())); }
    if (del) { const targets = [...files]; for (const f of targets) { delete G.files[f]; delete G.index[f]; } sfx('file-delete'); after(true); return { out: [], mutated: true }; }
    return { out: files.map(f => './' + f), mutated: false };
  },

  xargs: (a, stdin) => {
    // xargs [命令]（把 stdin 的词追加到命令后执行；默认 echo）
    const cmd = a.length ? a.join(' ') : 'echo';
    const words = stdin.split(/\s+/).filter(Boolean);
    const r = runPipeline(words.length ? `${cmd} ${words.join(' ')}` : cmd);
    if (r.err) return { out: [], err: r.err, exit: r.exit };
    return { out: r.out, mutated: r.mutated, exit: r.exit };
  },

  diff: (a, stdin) => {
    // diff [-u|-c|-q|-s] [-w|-i] 文件1 文件2
    const uni = a.includes('-u') || a.includes('--unified');
    const ctx = a.includes('-c');
    const quiet = a.includes('-q');
    const brief = a.includes('-s');
    const ignoreWS = a.includes('-w');
    const ignoreCase = a.includes('-i');
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: diff [-u|-c|-q] 文件1 文件2'] };
    const norm = l => { let s = l; if (ignoreWS) s = s.replace(/\s+/g, ' ').trim(); if (ignoreCase) s = s.toLowerCase(); return s; };
    const A = (readF(files[0]) || '').replace(/\n$/, '').split('\n');
    const B = (readF(files[1]) || '').replace(/\n$/, '').split('\n');
    const same = A.length === B.length && A.every((l, i) => norm(l) === norm(B[i]));
    if (same) return { out: brief ? [`文件 ${files[0]} 和 ${files[1]} 相同`] : [], mutated: false, exit: 0 };
    if (quiet || brief) return { out: [`文件 ${files[0]} 和 ${files[1]} 不同`], mutated: false, exit: 1 };
    const changes = lcsDiff(A, B);
    if (!uni && !ctx) {
      const out = [];
      changes.forEach((c, i) => {
        if (c.t === '-') out.push(`< ${c.v}`);
        else if (c.t === '+') out.push(`> ${c.v}`);
        void i;
      });
      return { out, mutated: false, exit: 1 };
    }
    const out = [`--- ${files[0]}`, `+++ ${files[1]}`, '@@ -1 +1 @@'];
    for (const c of changes) {
      if (c.t === ' ') out.push(' ' + c.v);
      else if (c.t === '-') out.push('-' + c.v);
      else out.push('+' + c.v);
    }
    return { out, mutated: false, exit: 1 };
  },

  md5sum: (a, stdin) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (!files.length) return { out: [`${md5(stdin)}  -`], mutated: false };
    const out = [];
    for (const f of files) {
      const c = readF(f);
      if (c === null) { return { out: [], err: [`md5sum: ${f}: 没有那个文件`] }; }
      out.push(`${md5(c)}  ${f}`);
    }
    return { out, mutated: false };
  },

  printf: (a, stdin) => {
    // printf 格式 [参数...]（支持 %s %d %f %% 与 \n \t）
    if (!a.length) return { out: [], err: ['用法: printf 格式 [参数...]'] };
    const fmt = a[0].replace(/^["']|["']$/g, '');
    const params = a.slice(1);
    let pi = 0;
    const out = fmt.replace(/\\([ntr\\%])|%([-0-9]*)([sdfx%])/g, (m, esc, w, conv) => {
      if (esc !== undefined) return escChar(esc);
      if (conv === '%') return '%';
      const v = params[pi++] ?? '';
      if (conv === 'd') return String(parseInt(v) || 0);
      if (conv === 'f') return String(parseFloat(v) || 0);
      if (conv === 'x') return (parseInt(v) || 0).toString(16);
      return String(v);
    });
    return { out: out.split('\n'), mutated: false };
  },

  seq: (a, stdin) => {
    // seq [首 [步长]] 末 [-w 等宽] [-s 分隔符]
    const wflag = a.includes('-w');
    let sep = '\n'; const args = [...a];
    const si = args.indexOf('-s');
    if (si >= 0) { sep = String(args[si + 1] ?? '\n').replace(/^["']|["']$/g, ''); args.splice(si, 2); }
    const nums = args.filter(x => !x.startsWith('-')).map(Number);
    let first = 1, step = 1, last = 1;
    if (nums.length === 1) last = nums[0];
    else if (nums.length === 2) { first = nums[0]; last = nums[1]; }
    else if (nums.length >= 3) { first = nums[0]; step = nums[1]; last = nums[2]; }
    if (step === 0) return { out: [], err: ['seq: 步长不能为 0'] };
    const out = [];
    let guard = 0;
    if (step > 0) for (let i = first; i <= last && guard++ < 100000; i += step) out.push(i);
    else for (let i = first; i >= last && guard++ < 100000; i += step) out.push(i);
    if (wflag) { const w = String(last).length; return { out: [out.map(n => String(n).padStart(w, '0')).join(sep)], mutated: false }; }
    if (sep !== '\n') return { out: [out.map(String).join(sep)], mutated: false };
    return { out: out.map(String), mutated: false };
  },

  shuf: (a, stdin) => {
    // shuf [-n N] [-e] [-i 首-末] [文件]（确定性“随机”，基于内容哈希）
    const args = [...a];
    let n = Infinity;
    const ni = args.indexOf('-n'); if (ni >= 0) { n = parseInt(args[ni + 1]) || Infinity; args.splice(ni, 2); }
    const ii = args.indexOf('-i');
    let lines;
    if (ii >= 0) {
      const m = String(args[ii + 1]).match(/^(\d+)-(\d+)$/);
      const lo = m ? parseInt(m[1]) : 1, hi = m ? parseInt(m[2]) : 1;
      lines = []; for (let k = lo; k <= hi; k++) lines.push(String(k));
      args.splice(ii, 2);
    } else {
      const file = args.find(x => !x.startsWith('-'));
      lines = (file ? (readF(file) || '') : stdin).replace(/\n$/, '').split('\n').filter(l => l);
    }
    let h = 7;
    for (const ch of lines.join(',')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const arr = [...lines];
    for (let i = arr.length - 1; i > 0; i--) { h = (h * 1103515245 + 12345) >>> 0; const j = h % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return { out: arr.slice(0, n).map(String), mutated: false };
  },

  // ===== 文件操作 =====
  ls: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const patterns = a.filter(x => !x.startsWith('-'));
    let files = Object.keys(G.files).sort();
    if (patterns.length) files = files.filter(f => patterns.some(p => globMatch(p, f) || f.includes(p)));
    G.used.add('ls');
    if (!files.length) return { out: ['(空)'], mutated: true };
    if (flags.includes('l')) {
      const out = files.map(f => {
        const size = (G.files[f] || '').length;
        const mode = (G.modes && G.modes[f]) || '-rw-r--r--';
        return `${mode} 1 user group ${String(size).padStart(5)} 2024-01-01 ${f}`;
      });
      return { out, mutated: true };
    }
    return { out: [files.join('  ')], mutated: true };
  },

  mkdir: (a, stdin) => {
    // 扁平文件系统：目录为概念性存在，记录到 G.dirs
    const dirs = a.filter(x => !x.startsWith('-'));
    if (!dirs.length) return { out: [], err: ['用法: mkdir [-p] 目录...'] };
    G.dirs = G.dirs || {};
    for (const d of dirs) G.dirs[d] = true;
    sfx('file-create');
    return { out: [], mutated: true };
  },

  touch: (a, stdin) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (!files.length) return { out: [], err: ['用法: touch 文件...'] };
    for (const f of files) if (G.files[f] === undefined) G.files[f] = '';
    sfx('file-create');
    return { out: [], mutated: true };
  },

  cp: (a, stdin) => {
    const args = a.filter(x => x !== '--');
    const files = args.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: cp [-r] 源 目标'] };
    const src = files[0], dst = files[files.length - 1];
    const c = readF(src);
    if (c === null) return { out: [], err: [`cp: 无法访问 '${src}': 没有那个文件`] };
    G.files[dst] = c;
    sfx('file-create');
    return { out: [], mutated: true };
  },

  mv: (a, stdin) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: mv 源 目标'] };
    const src = files[0], dst = files[files.length - 1];
    const c = readF(src);
    if (c === null) return { out: [], err: [`mv: 无法访问 '${src}': 没有那个文件`] };
    G.files[dst] = c; delete G.files[src];
    if (G.index[src] !== undefined) { G.index[dst] = G.index[src]; delete G.index[src]; }
    sfx('file-move');
    return { out: [], mutated: true };
  },

  rm: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const recursive = flags.includes('r') || flags.includes('R');
    const force = flags.includes('f');
    const interactive = flags.includes('i');
    const files = a.filter(x => !x.startsWith('-'));
    if (!files.length) return { out: [], err: ['用法: rm [-r|-f] 文件...'] };
    if (interactive) return { out: ['rm: 交互模式（模拟）：未删除任何文件'], mutated: false };
    const out = [];
    for (const f of files) {
      if (recursive) {
        const targets = Object.keys(G.files).filter(x => x === f || x.startsWith(f + '/'));
        if (!targets.length && !force) { out.push(`rm: 无法删除 '${f}': 没有那个文件或目录`); continue; }
        for (const t of targets) { delete G.files[t]; delete G.index[t]; }
      } else {
        if (G.files[f] === undefined) { if (!force) out.push(`rm: 无法删除 '${f}': 没有那个文件`); continue; }
        delete G.files[f]; delete G.index[f];
      }
    }
    sfx('file-delete');
    return { out, err: out.length && !force ? out : null, mutated: true, exit: out.length && !force ? 1 : 0 };
  },

  chmod: (a, stdin) => {
    // chmod [-R] 模式 文件...（记录权限，扁平文件系统）
    const args = a.filter(x => !x.startsWith('-'));
    if (args.length < 2) return { out: [], err: ['用法: chmod [-R] 模式 文件...'] };
    const mode = args[0];
    const files = args.slice(1);
    G.modes = G.modes || {};
    for (const f of files) {
      if (G.files[f] === undefined) return { out: [], err: [`chmod: 无法访问 '${f}': 没有那个文件`] };
      G.modes[f] = /^\d+$/.test(mode) ? mode : (G.modes[f] || '644');
    }
    return { out: [`已将 ${files.join(', ')} 的权限设为 ${mode}`], mutated: true };
  },

  pwd: () => ({ out: ['/termquest'], mutated: false }),

  // ===== shell 内建 / 杂项 =====
  echo: (a, stdin) => {
    const eflag = a.includes('-e');
    const nflag = a.includes('-n');
    const rest = a.filter(x => x !== '-e' && x !== '-n' && x !== '-E');
    let text = rest.join(' ');
    if (eflag) text = text.replace(/\\(.)/g, (_, c) => escChar(c));
    void nflag;
    return { out: text === '' ? [''] : text.split('\n'), mutated: false };
  },

  cat: (a, stdin) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (!files.length) return { out: inputLines(stdin), mutated: false };
    const out = [];
    for (const f of files) {
      const c = readF(f);
      if (c === null) return { out: [], err: [`cat: ${f}: 没有那个文件或目录`] };
      out.push(...c.replace(/\n$/, '').split('\n'));
    }
    return { out, mutated: true };
  },

  test: (a, stdin) => { const ok = testEval(a); return { out: [], mutated: false, exit: ok ? 0 : 1 }; },
  '[': (a, stdin) => { const ok = testEval(a); return { out: [], mutated: false, exit: ok ? 0 : 1 }; },

  expr: (a, stdin) => {
    // expr 表达式（数值运算 / 字符串 length / index）
    if (!a.length) return { out: [], err: ['用法: expr 表达式（如 expr 2 + 3）'] };
    const s = a.join(' ');
    const lm = s.match(/^length\s+(.*)$/);
    if (lm) return { out: [String(lm[1].replace(/^["']|["']$/g, '').length)], mutated: false };
    const im = s.match(/^index\s+(\S+)\s+(\S+)$/);
    if (im) { const idx = im[1].indexOf(im[2]); return { out: [String(idx + 1)], mutated: false }; }
    return { out: [bcEval(s)], mutated: false };
  },

  bc: (a, stdin) => {
    // bc：逐行求值算术表达式（文件 / stdin / -e 表达式）
    const eidx = a.indexOf('-e');
    if (eidx >= 0) return { out: [bcEval(a.slice(eidx + 1).join(' '))], mutated: false };
    const file = a.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const out = text.replace(/\n$/, '').split('\n').filter(l => l.trim()).map(l => bcEval(l.trim()));
    return { out, mutated: false };
  },

  read: (a, stdin) => {
    // read 变量（非交互：取 stdin 第一行，缺省给占位值）
    const names = a.filter(x => !x.startsWith('-'));
    const val = stdin ? stdin.split('\n')[0] : 'input';
    if (names.length && CUR_ENV) setVar(names[0], val);
    return { out: [], mutated: false };
  },

  source: (a, stdin) => {
    // source 脚本.sh：在当前环境执行脚本
    const file = a[0];
    if (!file) return { out: [], err: ['用法: source 脚本.sh'] };
    const c = readF(file);
    if (c === null) return { out: [], err: [`source: ${file}: 没有那个文件`] };
    sfx('proc-spawn');
    runScript(c, CUR_ENV || { vars: {}, funcs: {}, pos: [], exit: 0, name: file });
    return { out: [], mutated: true };
  },

  alias: (a, stdin) => {
    if (!a.length) {
      const ks = Object.keys(aliases);
      return { out: ks.length ? ks.map(k => `alias ${k}='${aliases[k]}'`) : ['(未定义别名)'], mutated: false };
    }
    for (const item of a) {
      const m = item.match(/^([^=]+)=(.*)$/);
      if (m) aliases[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return { out: [], mutated: false };
  },

  unalias: (a, stdin) => {
    for (const n of a) delete aliases[n];
    return { out: [], mutated: false };
  },

  type: (a, stdin) => {
    const builtins = new Set(Object.keys(SHELL));
    const out = a.map(name => {
      if (aliases[name]) return `${name} 是 '${aliases[name]}' 的别名`;
      if (CUR_ENV && CUR_ENV.funcs[name]) return `${name} 是一个函数`;
      if (builtins.has(name)) return `${name} 是 shell 内建命令`;
      if (name === 'git' || name === 'help') return `${name} 是 /usr/bin/${name}`;
      return `bash: type: ${name}: 未找到`;
    });
    return { out, mutated: false };
  },

  which: (a, stdin) => {
    const known = new Set([...Object.keys(SHELL), 'git', 'help']);
    const out = [];
    for (const name of a.filter(x => !x.startsWith('-'))) {
      if (aliases[name]) out.push(`alias ${name}='${aliases[name]}'`);
      else if (known.has(name)) out.push(`/usr/bin/${name}`);
      else return { out: [], err: [`which: 找不到 ${name}`], exit: 1 };
    }
    return { out, mutated: false };
  },

  true: () => ({ out: [], mutated: false, exit: 0 }),
  false: () => ({ out: [], mutated: false, exit: 1 }),

  export: (a, stdin) => {
    for (const item of a) {
      const m = item.match(/^([A-Za-z_]\w*)=(.*)$/);
      if (m && CUR_ENV) setVar(m[1], processAssignValue(m[2], CUR_ENV));
    }
    return { out: [], mutated: false };
  },

  unset: (a, stdin) => {
    for (const n of a.filter(x => !x.startsWith('-'))) if (CUR_ENV && CUR_ENV.vars[n] !== undefined) delete CUR_ENV.vars[n];
    return { out: [], mutated: false };
  },

  sleep: (a, stdin) => {
    const n = parseFloat(a[0]) || 0;
    return { out: [`(已休眠 ${n} 秒，模拟环境瞬间完成)`], mutated: false };
  },

  basename: (a, stdin) => {
    const p = a[0];
    if (p === undefined) return { out: [], err: ['用法: basename 路径 [后缀]'] };
    let base = p.split('/').filter(Boolean).pop() || p;
    if (a[1] && base.endsWith(a[1])) base = base.slice(0, base.length - a[1].length);
    return { out: [base], mutated: false };
  },

  dirname: (a, stdin) => {
    const p = a[0];
    if (p === undefined) return { out: [], err: ['用法: dirname 路径'] };
    const parts = p.split('/').filter(Boolean);
    parts.pop();
    return { out: [parts.length ? parts.join('/') : '.'], mutated: false };
  },

  date: (a, stdin) => ({ out: ['2024年 01月 01日 星期一 12:00:00 CST'], mutated: false }),
  whoami: () => ({ out: ['user'], mutated: false }),
  hostname: () => ({ out: ['termquest'], mutated: false }),
  uname: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    if (flags.includes('a')) return { out: ['Linux termquest 6.1.0 #1 SMP x86_64 GNU/Linux'], mutated: false };
    if (flags.includes('r')) return { out: ['6.1.0'], mutated: false };
    if (flags.includes('m')) return { out: ['x86_64'], mutated: false };
    return { out: ['Linux'], mutated: false };
  },
  env: (a, stdin) => {
    const vars = CUR_ENV ? CUR_ENV.vars : {};
    const ks = Object.keys(vars);
    return { out: ks.length ? ks.map(k => `${k}=${vars[k]}`) : ['(无环境变量)'], mutated: false };
  },

  clear: () => { clearTerm(); return { out: [], mutated: false }; },

  // 简化 vim：vim 文件 会提示用 sed -i / echo 编辑（非交互环境）
  vim: (a, stdin) => {
    const f = a[0];
    if (!f) return { out: [], err: ['用法: vim 文件'] };
    const c = readF(f);
    return {
      out: [
        `── ${f} ${c === null ? '(新文件)' : ''} ──`,
        ...(c === null ? [] : c.replace(/\n$/, '').split('\n')),
        '── 非交互模式：请用 sed -i \'s/旧/新/\' ' + f + ' 或 echo "内容" > ' + f + ' 编辑 ──',
      ],
      mutated: false,
      sfx: 'ui-open',
    };
  },

  // 脚本执行：bash [-c "命令"] 脚本.sh [参数...]
  bash: (a, stdin) => {
    const ci = a.indexOf('-c');
    if (ci >= 0) {
      const code = a.slice(ci + 1).join(' ');
      sfx('proc-spawn');
      runScript(code, { vars: {}, funcs: {}, pos: [], exit: 0, name: 'bash' });
      return { out: [], mutated: true };
    }
    const file = a[0];
    if (!file) return { out: [], err: ['用法: bash 脚本.sh [参数...] 或 bash -c "命令"'] };
    const c = readF(file);
    if (c === null) return { out: [], err: [`bash: ${file}: 没有那个文件`] };
    const pos = a.slice(1);
    sfx('proc-spawn');
    runScript(c, { vars: {}, funcs: {}, pos, exit: 0, name: file });
    return { out: [], mutated: true };
  },
  sh: (a, stdin) => SHELL.bash(a, stdin),
  '.': (a, stdin) => SHELL.source(a, stdin),
};