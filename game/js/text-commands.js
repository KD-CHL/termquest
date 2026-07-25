// 文本处理进阶命令集 —— find / xargs / awk(条件&聚合) / sed(地址&删除) / paste / join / diff / tee / column
// 本模块自建管道执行器：进阶命令走 TEXT 表（覆盖 linux 的简化版 awk/sed），
// 其余阶段委托 linux-commands 的 runStage，从而支持 find | xargs 这类组合。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { parsePipeline } from './fs.js';
import { tokenize } from './commands.js';
import { runStage } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'echo', 'wc', 'head', 'tail', 'find', 'jq', 'nl', 'shuf', 'md5sum'];

export function textExecute(input) {
  input = input.trim();
  if (!input) return;
  printCmd(input);
  const e = E();
  e.history.push(input);

  const base = input.split(/\s/)[0];
  if (base === 'help') { showTextHelp(); return; }
  if (base === 'clear') { import('./terminal.js').then(m => m.clearTerm()); return; }

  if (!FREE.includes(base)) { app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount(); }

  const { stages, redirect } = parsePipeline(input);
  if (!stages.length) return;

  let stdin = '';
  let lastResult = null;
  const piped = stages.length > 1;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isLast = i === stages.length - 1;
    lastResult = runTextStage(stage, stdin, e, isLast && !piped);
    if (lastResult.err && lastResult.err.length) {
      lastResult.err.forEach(l => print(l, 'err'));
      sfx(lastResult.sfx || 'err-syntax');
      e.lastOut = '';
      after(false);
      return;
    }
    stdin = lastResult.out.join('\n');
    if (piped && i < stages.length - 1) sfx('pipe-tick');
  }

  if (redirect.file) {
    const content = stdin + (stdin ? '\n' : '');
    if (redirect.type === '>>') {
      const old = e.readFile(redirect.file);
      e.writeFile(redirect.file, (old.ok ? old.content : '') + content);
    } else {
      e.writeFile(redirect.file, content);
    }
    sfx('file-write'); after(true); return;
  }

  if (lastResult.out.length) lastResult.out.forEach(l => print(l, lastResult.cls || 'out'));
  e.lastOut = lastResult.out.join('\n');
  if (lastResult.sfx) sfx(lastResult.sfx);
  after(true);
}

// 单阶段：优先 TEXT 表，否则走 linux runStage
function runTextStage(stage, stdin, e, direct) {
  const t = tokenize(stage);
  const cmd = t[0];
  track(cmd);
  e.used.add(cmd);
  if (TEXT[cmd]) return TEXT[cmd](t.slice(1), stdin, e, stage);
  return runStage(stage, stdin, e, direct);
}

function globToRe(pat) {
  return new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
// 返回与 openIdx 处 '{' 配对的 '}' 下标（未找到返回 -1）
function matchBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
// LCS 行 diff：返回 [{t:' '|'-'|'+', l}]（diff -u 用）
function lcsDiff(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const res = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { res.push({ t: ' ', l: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push({ t: '-', l: a[i] }); i++; }
    else { res.push({ t: '+', l: b[j] }); j++; }
  }
  while (i < m) { res.push({ t: '-', l: a[i] }); i++; }
  while (j < n) { res.push({ t: '+', l: b[j] }); j++; }
  return res;
}
// jq 输出格式化：字符串/数字/布尔/null 原样输出，对象/数组美化为多行 JSON
function jqFormat(v) {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}
// 简化 jq 过滤器求值：支持 . · .key · .a.b · .[] · .a[] · .[N]（含负数） · .length
// 返回结果值数组；不支持的语法抛错，由调用方给出友好报错
function jqPath(data, filter) {
  filter = String(filter).trim();
  if (filter === '.') return [data];
  if (!filter.startsWith('.')) throw new Error('bad filter');
  let cur = [data];
  let i = 0;
  while (i < filter.length) {
    if (filter[i] === '.') i++;           // 点号可选：.a.b / .a[0] / .a.[0] 均可
    else if (filter[i] !== '[') throw new Error('bad filter');
    if (filter[i] === '[') {
      const close = filter.indexOf(']', i);
      if (close < 0) throw new Error('bad filter');
      const inner = filter.slice(i + 1, close).trim();
      i = close + 1;
      const next = [];
      if (inner === '') {
        // .[] 迭代：数组取元素，对象取值
        for (const v of cur) {
          if (Array.isArray(v)) next.push(...v);
          else if (v && typeof v === 'object') next.push(...Object.values(v));
          else throw new Error('cannot iterate');
        }
      } else {
        const idx = parseInt(inner, 10);
        if (Number.isNaN(idx)) throw new Error('bad filter');
        for (const v of cur) {
          if (Array.isArray(v)) next.push(v[idx < 0 ? v.length + idx : idx] ?? null);
          else if (v && typeof v === 'object') next.push(Object.values(v)[idx < 0 ? Object.values(v).length + idx : idx] ?? null);
          else throw new Error('cannot index');
        }
      }
      cur = next;
    } else {
      let j = i;
      while (j < filter.length && filter[j] !== '.' && filter[j] !== '[') j++;
      const key = filter.slice(i, j);
      i = j;
      if (!key) throw new Error('bad filter');
      if (key === 'length') {
        cur = cur.map(v => {
          if (v === null) return 0;
          if (typeof v === 'string' || Array.isArray(v)) return v.length;
          if (typeof v === 'object') return Object.keys(v).length;
          throw new Error('no length');
        });
      } else {
        cur = cur.map(v => (v && typeof v === 'object' && !Array.isArray(v)) ? (key in v ? v[key] : null) : null);
      }
    }
  }
  return cur;
}
// 稳定哈希（非真实 MD5）：四路不同种子的 FNV 变体拼接成 32 位十六进制串
function simpleHash128(content) {
  const pass = (seed) => {
    let x = seed >>> 0;
    for (let i = 0; i < content.length; i++) x = Math.imul(x ^ content.charCodeAt(i), 16777619) >>> 0;
    x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0;
    x ^= x >>> 13; x = Math.imul(x, 3266489917) >>> 0;
    x ^= x >>> 16;
    return x >>> 0;
  };
  return [0x811c9dc5, 0x9747b28c, 0x100001b3, 0x85ebca6b].map(s => pass(s).toString(16).padStart(8, '0')).join('');
}

const TEXT = {
  /* ---- find ---- */
  find: (a, stdin, e) => {
    let path = '.';
    let name = null, iname = null, type = null, execCmd = null, pathGlob = null;
    let maxdepth = null, sizeSpec = null, doDelete = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-name') name = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-iname') iname = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-type') type = a[++i];
      else if (a[i] === '-maxdepth') maxdepth = parseInt(a[++i]);
      else if (a[i] === '-path') pathGlob = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-size') sizeSpec = a[++i];
      else if (a[i] === '-delete') doDelete = true;
      else if (a[i] === '-exec') { execCmd = a.slice(i + 1).join(' ').replace(/\\\;|\;\s*$/, '').trim(); break; }
      else if (!a[i].startsWith('-')) path = a[i];
    }
    const base = e.resolvePath(path);
    if (!e.exists(base)) return { out: [], err: [`find: '${path}': 没有那个文件或目录`] };
    // -size +N（> N 字节）/ -size -N（< N 字节），按文件内容长度
    let sizeOp = null, sizeN = 0;
    if (sizeSpec) {
      const sm = String(sizeSpec).match(/^([+-])(\d+)$/);
      if (sm) { sizeOp = sm[1]; sizeN = parseInt(sm[2]); }
    }
    const results = [];
    const matched = []; // {disp, abs, isFile} 供 -delete 使用
    const walkAll = (p, depth) => {
      const node = e.follow(p);
      if (!node) return;
      const isFile = node.type === 'file', isDir = node.type === 'dir';
      const disp = p === base ? (path === '.' ? '.' : path) : path === '.' ? p.replace(base + '/', '') : p;
      const depthOk = maxdepth === null || maxdepth < 0 || depth <= maxdepth;
      const nameOk = (!name && !iname)
        || (name && globToRe(name).test(e.basename(p)))
        || (iname && new RegExp(globToRe(iname).source, 'i').test(e.basename(p)));
      const typeOk = !type || (type === 'f' && isFile) || (type === 'd' && isDir);
      const pathOk = !pathGlob || globToRe(pathGlob).test(disp) || globToRe(pathGlob).test(p);
      let sizeOk = true;
      if (sizeOp) {
        if (!isFile) sizeOk = false;
        else {
          const len = (node.content || '').length;
          sizeOk = sizeOp === '+' ? len > sizeN : len < sizeN;
        }
      }
      if (depthOk && nameOk && typeOk && pathOk && sizeOk && !(p === base && type === 'f' && !name && !iname)) {
        if (!(p === base && type && type === 'f')) {
          results.push(disp);
          matched.push({ disp, abs: p, isFile });
        }
      }
      if (node.type === 'dir' && (maxdepth === null || maxdepth < 0 || depth < maxdepth)) {
        for (const child of Object.keys(node.children).sort()) walkAll(p === '/' ? '/' + child : p + '/' + child, depth + 1);
      }
    };
    walkAll(base, 0);
    const uniq = [...new Set(results)];
    if (doDelete) {
      for (const m of matched) if (m.isFile) e.remove(m.abs);
      return { out: [], sfx: 'file-delete' };
    }
    if (execCmd) {
      for (const f of uniq) {
        if (f === '.' || f === path) continue;
        const cmd = execCmd.replace(/\{\}/g, f);
        const [c0, ...rest] = tokenize(cmd);
        if (c0 === 'rm') e.remove(rest[0], rest.includes('-r'));
        else if (c0 === 'cat') { const r = e.readFile(rest[0]); if (r.ok) r.content.split('\n').filter(Boolean).forEach(l => print(l, 'out')); }
      }
      return { out: [], sfx: 'file-delete' };
    }
    return { out: uniq.length ? uniq : [], sfx: 'text-grep' };
  },

  /* ---- xargs：把 stdin 的行拼接到命令后逐个执行 ---- */
  xargs: (a, stdin, e) => {
    const items = stdin.split('\n').filter(l => l.trim());
    let placeholder = null, maxArgs = null;
    const rest = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-I') placeholder = a[++i];
      else if (a[i] === '-n') maxArgs = parseInt(a[++i]);
      else if (a[i].startsWith('-I') && a[i].length > 2) placeholder = a[i].slice(2);
      else if (a[i].startsWith('-n') && a[i].length > 2) maxArgs = parseInt(a[i].slice(2));
      else rest.push(a[i]);
    }
    const cmdName = rest[0] || 'echo';
    const cmdRest = rest.slice(1);
    const out = [];
    const run = (full) => {
      const res = runStage(full, '', e, false);
      if (res.out && res.out.length) out.push(...res.out);
    };
    if (placeholder) {
      // -I 模式：每行替换命令模板中的占位符
      const template = [cmdName, ...cmdRest].join(' ');
      for (const item of items) run(template.split(placeholder).join(item.trim()));
    } else if (maxArgs && maxArgs > 0) {
      // -n 模式：每次最多 maxArgs 个参数
      for (let i = 0; i < items.length; i += maxArgs) {
        const batch = items.slice(i, i + maxArgs).map(x => x.trim());
        run([cmdName, ...cmdRest, ...batch].join(' '));
      }
    } else {
      // 默认：每行一个参数逐次执行
      for (const item of items) run([cmdName, ...cmdRest, item].join(' '));
    }
    return { out, sfx: 'pipe-whoosh' };
  },

  /* ---- awk 进阶（条件 / 聚合 / NR / -v / BEGIN / printf / $0） ---- */
  awk: (a, stdin, e) => {
    let fieldSep = /\s+/;
    const vars = {};
    const positional = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-v') {
        const kv = a[++i] || '';
        const eq = kv.indexOf('=');
        if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else if (a[i].startsWith('-v') && a[i].length > 2) {
        const kv = a[i].slice(2);
        const eq = kv.indexOf('=');
        if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else if (a[i] === '-F') {
        fieldSep = new RegExp(escRe(a[++i]));
      } else if (a[i].startsWith('-F')) {
        fieldSep = new RegExp(escRe(a[i].slice(2)));
      } else {
        positional.push(a[i]);
      }
    }
    const prog = positional[0], fileArg = positional[1];
    if (!prog) return { out: [], err: ['用法: awk [-F 分隔符] [-v 变量=值] \'程序\' [文件]'] };
    let text;
    if (fileArg) {
      const r = e.readFile(fileArg);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    const lines = text.split('\n').filter(l => l);
    const rows = lines.map((l, idx) => ({ fields: l.split(fieldSep).filter(Boolean), line: l, nr: idx + 1 }));

    // 引号感知的逗号拆分（printf/print 参数）
    const splitArgs = (s) => {
      const parts = []; let cur = '', q = null;
      for (const ch of s) {
        if (q) { if (ch === q) q = null; cur += ch; }
        else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
        else if (ch === ',') { parts.push(cur.trim()); cur = ''; }
        else cur += ch;
      }
      parts.push(cur.trim());
      return parts;
    };
    // $0/$N 与 -v 变量替换
    const subVars = (s, row) => {
      let r = s.replace(/\$(\d+)/g, (_, n) => {
        const idx = parseInt(n);
        if (idx === 0) return row ? row.line : '';
        return row ? (row.fields[idx - 1] || '') : '';
      });
      for (const [k, v] of Object.entries(vars)) {
        r = r.replace(new RegExp('\\b' + escRe(k) + '\\b', 'g'), String(v));
      }
      return r;
    };
    // print 表达式：先按逗号拆分（引号感知），再对每个参数做 $N/-v 替换、去引号、空格连接
    // （先拆后替换，避免 $0 替换出的整行内容被逗号二次拆分）
    const evalPrint = (expr, row) => {
      return splitArgs(expr).map(p => subVars(p.trim(), row).replace(/["']/g, '')).join(' ');
    };
    // printf 单个参数取值
    const evalArgValue = (arg, row) => {
      arg = arg.trim();
      const m = arg.match(/^["'](.*)["']$/);
      if (m) return m[1];
      if (arg === '$0') return row ? row.line : '';
      const fm = arg.match(/^\$(\d+)$/);
      if (fm) return row ? (row.fields[parseInt(fm[1]) - 1] || '') : '';
      if (Object.prototype.hasOwnProperty.call(vars, arg)) return vars[arg];
      // 纯数字与运算符组成的简单算术式（如 END 里 sum/NR 替换后的 60/3）
      if (/^[\d\s+\-*/().]+$/.test(arg) && /\d/.test(arg) && /[+\-*/]/.test(arg)) {
        try { return String(Function('"use strict";return (' + arg + ')')()); } catch {}
      }
      return arg;
    };
    // printf "格式", 参数... ：支持 %s / %d / %.2f
    const evalPrintf = (expr, row) => {
      const parts = splitArgs(expr);
      let fmt = (parts[0] || '').replace(/^["']|["']$/g, '');
      fmt = fmt.replace(/\\t/g, '\t').replace(/\\n/g, '');
      const args = parts.slice(1).map(p => evalArgValue(p, row));
      let ai = 0;
      return fmt.replace(/%(\.(\d+))?([sdf%])/g, (mm, dot, prec, type) => {
        if (type === '%') return '%';
        const val = args[ai++];
        if (type === 'd') return String(parseInt(val, 10) || 0);
        if (type === 'f') return parseFloat(val).toFixed(prec !== undefined ? parseInt(prec) : 6);
        return val === undefined ? '' : String(val);
      });
    };
    // 执行 BEGIN / END 块内的 print / printf 语句
    const execBlock = (body, row, out) => {
      for (const stmt of body.split(';').map(s => s.trim()).filter(Boolean)) {
        let m;
        if ((m = stmt.match(/^printf\s+(.*)$/s))) out.push(evalPrintf(m[1], row));
        else if ((m = stmt.match(/^print\s*(.*)$/s))) {
          const expr = m[1].trim();
          out.push(expr ? evalPrint(expr, row) : (row ? row.line : ''));
        }
      }
    };

    // 拆出 BEGIN / END 块，剩下主规则
    let p = prog.trim();
    let beginBody = '', endBody = '';
    const bi = p.indexOf('BEGIN');
    if (bi >= 0) {
      const open = p.indexOf('{', bi);
      const close = open >= 0 ? matchBrace(p, open) : -1;
      if (close > open) { beginBody = p.slice(open + 1, close).trim(); p = (p.slice(0, bi) + p.slice(close + 1)).trim(); }
    }
    const ei = p.indexOf('END');
    if (ei >= 0) {
      const open = p.indexOf('{', ei);
      const close = open >= 0 ? matchBrace(p, open) : -1;
      if (close > open) { endBody = p.slice(open + 1, close).trim(); p = (p.slice(0, ei) + p.slice(close + 1)).trim(); }
    }
    const mainPart = p.replace(/^["']?\{|\}["']?$/g, '').trim();

    const evalCond = (cond, row) => {
      cond = (cond || '').trim();
      if (!cond) return true;
      let m;
      if ((m = cond.match(/^NR\s*==\s*(\d+)$/))) return row.nr === parseInt(m[1]);
      if ((m = cond.match(/^\$(\d+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/))) {
        const val = row.fields[parseInt(m[1]) - 1] || '';
        // 右侧允许引用 -v 变量（如 $3 == city），先做变量替换再去引号
        const rhs = subVars(m[3].trim(), row).replace(/["']/g, '');
        const num = !isNaN(parseFloat(val)) && !isNaN(parseFloat(rhs)) && String(val).trim() !== '' ;
        const lv = num ? parseFloat(val) : val, rv = num ? parseFloat(rhs) : rhs;
        switch (m[2]) { case '>': return lv > rv; case '<': return lv < rv; case '>=': return lv >= rv;
          case '<=': return lv <= rv; case '==': return lv == rv; case '!=': return lv != rv; }
      }
      if ((m = cond.match(/^\/(.*)\/$/))) return new RegExp(m[1]).test(row.line);
      return true;
    };

    const out = [];
    let sum = 0, cnt = 0;

    // BEGIN 块：在处理输入前执行
    if (beginBody) execBlock(beginBody, null, out);

    const agg = mainPart.match(/(?:sum|total|count)\s*\+=\s*\$(\d+)/);
    const pm = !agg ? mainPart.match(/^(.*?)\{?\s*(printf|print)\s*(.*)$/s) : null;
    const condOf = agg ? mainPart.slice(0, mainPart.indexOf('{')).trim() : (pm ? pm[1].trim() : mainPart);

    if (mainPart) {
      for (const row of rows) {
        if (!evalCond(condOf, row)) continue;
        if (agg) { sum += parseFloat(row.fields[parseInt(agg[1]) - 1] || 0); cnt++; }
        else if (pm) {
          const expr = pm[3].trim();
          if (pm[2] === 'printf') out.push(evalPrintf(expr, row));
          else if (!expr) out.push(row.line);
          else out.push(evalPrint(expr, row));
        } else out.push(row.line);
      }
    }

    // END 块：含 printf 走新逻辑，否则沿用原有算术求值（NR 取最终记录数）
    if (endBody) {
      const body = endBody.replace(/\b(?:sum|total)\b/g, String(sum)).replace(/\bcount\b/g, String(cnt)).replace(/\bNR\b/g, String(rows.length));
      if (/printf/.test(body)) execBlock(body, null, out);
      else {
        let expr = body.replace(/print\s*/, '').replace(/["']/g, '');
        try { expr = String(Function('"use strict";return (' + expr + ')')()); } catch {}
        out.push(expr);
      }
    }
    return { out, sfx: 'text-grep' };
  },

  /* ---- sed 进阶（地址删除 / -n 打印 / 范围 / 正则删除） ---- */
  sed: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const nonFlags = a.filter(x => !x.startsWith('-'));
    const expr = nonFlags[0]?.replace(/^["']|["']$/g, '');
    const file = nonFlags[1];
    if (!expr) return { out: [], err: ['用法: sed [-n] [-i] \'表达式\' [文件]'] };
    let lines;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      lines = r.content.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
    } else lines = stdin.split('\n');
    let out = lines, m;
    if ((m = expr.match(/^(\d+),(\d+)s\/(.*)\/(.*)\/([g]*)$/))) {
      // 范围替换 N,Ms/旧/新/g
      const start = parseInt(m[1]), end = parseInt(m[2]);
      const re = new RegExp(m[3], m[5].includes('g') ? 'g' : '');
      const rep = m[4];
      out = lines.map((l, i) => (i >= start - 1 && i <= end - 1) ? l.replace(re, rep) : l);
    } else if (expr.startsWith('s/')) {
      const parts = expr.split('/');
      const re = new RegExp(parts[1], parts[3] === 'g' ? 'g' : '');
      out = lines.map(l => l.replace(re, parts[2]));
    } else if ((m = expr.match(/^(\d+),(\d+)d$/))) {
      out = lines.filter((_, i) => i < parseInt(m[1]) - 1 || i > parseInt(m[2]) - 1);
    } else if ((m = expr.match(/^(\d+)d$/))) {
      out = lines.filter((_, i) => i !== parseInt(m[1]) - 1);
    } else if ((m = expr.match(/^(\d+)p$/)) && flags.includes('n')) {
      out = lines.filter((_, i) => i === parseInt(m[1]) - 1);
    } else if ((m = expr.match(/^\/(.*)\/d$/))) {
      const re = new RegExp(m[1]); out = lines.filter(l => !re.test(l));
    } else if ((m = expr.match(/^\/(.*)\/p$/)) && flags.includes('n')) {
      const re = new RegExp(m[1]); out = lines.filter(l => re.test(l));
    } else if ((m = expr.match(/^(\d+)a\\?\s*(.*)$/))) {
      // Na\文本：在第 N 行后追加
      const n = parseInt(m[1]); const text = m[2];
      out = []; lines.forEach((l, i) => { out.push(l); if (i === n - 1) out.push(text); });
    } else if ((m = expr.match(/^(\d+)i\\?\s*(.*)$/))) {
      // Ni\文本：在第 N 行前插入
      const n = parseInt(m[1]); const text = m[2];
      out = []; lines.forEach((l, i) => { if (i === n - 1) out.push(text); out.push(l); });
    } else if ((m = expr.match(/^\/(.*)\/a\\?\s*(.*)$/))) {
      // /正则/a\文本：在匹配行后追加
      const re = new RegExp(m[1]); const text = m[2];
      out = []; lines.forEach(l => { out.push(l); if (re.test(l)) out.push(text); });
    } else if ((m = expr.match(/^\/(.*)\/i\\?\s*(.*)$/))) {
      // /正则/i\文本：在匹配行前插入
      const re = new RegExp(m[1]); const text = m[2];
      out = []; lines.forEach(l => { if (re.test(l)) out.push(text); out.push(l); });
    } else {
      return { out: [], err: [`sed: 不支持的表达式: ${expr}（支持 s/旧/新/g · N,Ms/旧/新/g · Nd · N,Md · -n Np · /re/d · /re/p · Na\\文本 · Ni\\文本 · /re/a\\文本 · /re/i\\文本）`] };
    }
    if (a.includes('-i') && file) {
      e.writeFile(file, out.join('\n') + '\n');
      return { out: [], sfx: 'file-write' };
    }
    return { out };
  },

  /* ---- paste / join / diff / comm ---- */
  paste: (a, stdin, e) => {
    let delim = '\t';
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d') { delim = args[i + 1] ?? '\t'; args.splice(i, 2); i--; }
      else if (args[i].startsWith('-d') && args[i].length > 2) { delim = args[i].slice(2); args.splice(i, 1); i--; }
    }
    const files = args.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: paste [-d 分隔符] 文件1 文件2'] };
    const lists = files.map(f => (e.readFile(f)?.content || '').split('\n').filter(l => l));
    const maxLen = Math.max(...lists.map(l => l.length));
    const out = [];
    for (let i = 0; i < maxLen; i++) out.push(lists.map(l => l[i] || '').join(delim));
    return { out, sfx: 'file-copy' };
  },

  join: (a, stdin, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: join 文件1 文件2（按第一列连接）'] };
    const l1 = (e.readFile(files[0])?.content || '').split('\n').filter(l => l);
    const l2 = (e.readFile(files[1])?.content || '').split('\n').filter(l => l);
    const map2 = {};
    for (const l of l2) { const [k, ...rest] = l.split(/\s+/); map2[k] = rest.join(' '); }
    const out = [];
    for (const l of l1) {
      const [k, ...rest] = l.split(/\s+/);
      if (map2[k] !== undefined) out.push([k, ...rest, map2[k]].join(' '));
    }
    return { out: out.length ? out : ['(无匹配行)'], sfx: 'file-copy' };
  },

  diff: (a, stdin, e) => {
    const unified = a.includes('-u');
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: diff [-u] 文件1 文件2'] };
    const l1 = (e.readFile(files[0])?.content || '').split('\n');
    const l2 = (e.readFile(files[1])?.content || '').split('\n');
    if (unified) {
      const a1 = l1[l1.length - 1] === '' ? l1.slice(0, -1) : l1;
      const a2 = l2[l2.length - 1] === '' ? l2.slice(0, -1) : l2;
      const d = lcsDiff(a1, a2);
      if (!d.some(x => x.t !== ' ')) return { out: ['(两个文件完全相同)'], cls: 'info' };
      const out = [`--- a/${files[0]}`, `+++ b/${files[1]}`, `@@ -1,${a1.length} +1,${a2.length} @@`];
      for (const x of d) out.push(x.t + x.l);
      return { out, sfx: 'text-grep' };
    }
    const out = [];
    const max = Math.max(l1.length, l2.length);
    for (let i = 0; i < max; i++) {
      if (l1[i] !== l2[i]) {
        if (l1[i] !== undefined && l1[i] !== '') out.push(`< ${l1[i]}`);
        out.push('---');
        if (l2[i] !== undefined && l2[i] !== '') out.push(`> ${l2[i]}`);
      }
    }
    if (!out.length) return { out: ['(两个文件完全相同)'], cls: 'info' };
    return { out, sfx: 'text-grep' };
  },

  comm: (a, stdin, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: comm 文件1 文件2'] };
    const s1 = new Set((e.readFile(files[0])?.content || '').split('\n').filter(l => l));
    const s2 = new Set((e.readFile(files[1])?.content || '').split('\n').filter(l => l));
    const out = [];
    [...s1].sort().forEach(x => { if (!s2.has(x)) out.push(x); });
    [...s2].sort().forEach(x => { if (!s1.has(x)) out.push('\t' + x); });
    [...s1].filter(x => s2.has(x)).sort().forEach(x => out.push('\t\t' + x));
    return { out };
  },

  /* ---- tee / column / rev / seq ---- */
  tee: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    if (!file) return { out: [], err: ['用法: 命令 | tee 文件'] };
    e.writeFile(file, stdin + (stdin ? '\n' : ''));
    return { out: stdin.split('\n'), sfx: 'file-write' };
  },

  column: (a, stdin, e) => {
    const lines = stdin.split('\n').filter(l => l);
    if (!lines.length) return { out: [], err: ['column: 需要管道输入'] };
    const rows = lines.map(l => l.split(/\s+/));
    const cols = Math.max(...rows.map(r => r.length));
    const widths = [];
    for (let c = 0; c < cols; c++) widths.push(Math.max(...rows.map(r => (r[c] || '').length)));
    return { out: rows.map(r => r.map((cell, c) => (cell || '').padEnd(widths[c])).join('  ').trimEnd()) };
  },

  rev: (a, stdin, e) => ({ out: stdin.split('\n').map(l => l.split('').reverse().join('')) }),

  seq: (a, stdin, e) => {
    const n = parseInt(a[a.length - 1]) || 10;
    const start = a.length >= 2 ? parseInt(a[0]) : 1;
    const out = [];
    for (let i = start; i <= n; i++) out.push(i);
    return { out };
  },

  /* ---- jq：简化 JSON 处理器 ---- */
  jq: (a, stdin, e) => {
    const nonFlags = a.filter(x => !x.startsWith('-'));
    const filter = nonFlags[0] || '.';
    const file = nonFlags[1];
    let text;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    let data;
    try { data = JSON.parse(text); }
    catch { return { out: [], err: ['jq: 无效的 JSON 输入'] }; }
    let results;
    try { results = jqPath(data, filter); }
    catch { return { out: [], err: [`jq: 不支持的过滤器: ${filter}（支持 .key · .a.b · .[] · .[N] · .length）`] }; }
    return { out: results.flatMap(v => jqFormat(v).split('\n')), sfx: 'text-grep' };
  },

  /* ---- nl：给行编号（类似 cat -n） ---- */
  nl: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    let text;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    const lines = text.replace(/\n$/, '').split('\n');
    return { out: lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`), mutated: false };
  },

  /* ---- shuf：打乱行序（内容种子，结果确定） ---- */
  shuf: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    let text;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    const lines = text.replace(/\n$/, '').split('\n').filter(l => l);
    let seed = 2166136261;
    for (const ch of text) seed = (Math.imul(seed ^ ch.charCodeAt(0), 16777619)) >>> 0;
    const arr = [...lines];
    let s = seed || 1;
    const rand = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    if (arr.length > 1 && arr.join('\n') === lines.join('\n')) arr.reverse();
    return { out: arr, sfx: 'pipe-whoosh' };
  },

  /* ---- md5sum：输出 32 位十六进制哈希 + 文件名 ---- */
  md5sum: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    if (!file) return { out: [], err: ['用法: md5sum 文件'] };
    const r = e.readFile(file);
    if (r.err) return { out: [], err: [r.err] };
    return { out: [`${simpleHash128(r.content)}  ${file}`], mutated: false };
  },
};

function showTextHelp() {
  ['── 查找 ──',
    '  find [路径] -name "*.log" · find . -type f · find . -name "*.tmp" -exec rm {} \\;',
    '  find . -iname "*.LOG"（忽略大小写） · find . -maxdepth 1 · find . -path "*docs*"',
    '  find . -size +100 / -size -10（按内容字节数） · find . -name "*.bak" -delete',
    '  find . -name "*.log" | xargs rm · xargs -I {} 模板 {} · xargs -n 2 命令',
    '── 进阶文本 ──',
    '  awk \'$2 > 30 {print $1}\' 文件 · awk \'{sum+=$2} END {print sum}\' 文件',
    '  awk -v 变量=值 \'BEGIN {printf "表头 %s\\n", 变量} ...\' · printf 支持 %s %d %.2f · $0 整行',
    '  sed \'2d\' · sed -n \'3p\' · sed \'/模式/d\' · sed -i \'s/旧/新/g\' · sed \'1,3s/旧/新/g\'',
    '  sed \'2a\\追加文本\' · sed \'/模式/i\\插入文本\'（a 在后、i 在前）',
    '── 合并对比 ──',
    '  paste [-d 分隔符] 文件1 文件2 · join 文件1 文件2 · diff [-u] 文件1 文件2 · comm 文件1 文件2',
    '── JSON 与工具 ──',
    '  jq \'.key\' 文件.json · 过滤器支持：. · .key · .a.b · .[] · .[N] · .length',
    '  nl 文件（行编号） · shuf 文件（打乱行序） · md5sum 文件（哈希校验）',
    '  命令 | tee 文件 · 命令 | column -t · rev · seq N',
    '── 其余 ──',
    '  grep · sort · uniq · cut · tr · wc ... 照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
