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

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'echo', 'wc', 'head', 'tail', 'find', 'jq', 'nl', 'shuf', 'md5sum', 'grep', 'cut', 'tr', 'sort', 'uniq', 'tac', 'fold', 'fmt', 'expand', 'unexpand', 'od', 'strings', 'cmp', 'base64', 'sha256sum', 'more', 'less'];

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
    let maxdepth = null, mindepth = null, sizeSpec = null, mtimeSpec = null, doDelete = false, print0 = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-name') name = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-iname') iname = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-type') type = a[++i];
      else if (a[i] === '-maxdepth') maxdepth = parseInt(a[++i]);
      else if (a[i] === '-mindepth') mindepth = parseInt(a[++i]);
      else if (a[i] === '-path') pathGlob = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-size') sizeSpec = a[++i];
      else if (a[i] === '-mtime') mtimeSpec = a[++i];
      else if (a[i] === '-delete') doDelete = true;
      else if (a[i] === '-print0') print0 = true;
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
      const depthOk = (maxdepth === null || maxdepth < 0 || depth <= maxdepth) && (mindepth === null || depth >= mindepth);
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
      // -mtime 模拟：虚拟 FS 文件视为"今天"修改（age=0）
      let mtimeOk = true;
      if (mtimeSpec !== null) {
        const mv = parseInt(mtimeSpec);
        if (!isNaN(mv)) {
          if (mtimeSpec.startsWith('+')) mtimeOk = 0 > mv;       // +N: 超过 N 天
          else if (mtimeSpec.startsWith('-')) mtimeOk = 0 < mv;  // -N: 不足 N 天
          else mtimeOk = 0 === mv;                                // N: 恰好 N 天
        }
      }
      if (depthOk && nameOk && typeOk && pathOk && sizeOk && mtimeOk && !(p === base && type === 'f' && !name && !iname)) {
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
    // -print0：以 NUL 分隔（终端显示为空格分隔，保持兼容）
    if (print0 && uniq.length) return { out: [uniq.join('\0')], sfx: 'text-grep' };
    return { out: uniq.length ? uniq : [], sfx: 'text-grep' };
  },

  /* ---- xargs：把 stdin 的行拼接到命令后逐个执行 ---- */
  xargs: (a, stdin, e) => {
    let placeholder = null, maxArgs = null, delim = '\n';
    const rest = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-I') placeholder = a[++i];
      else if (a[i] === '-n') maxArgs = parseInt(a[++i]);
      else if (a[i] === '-d') delim = (a[++i] || '\n').replace(/^\\n$/, '\n').replace(/^\\0$/, '\0').replace(/^\\t$/, '\t');
      else if (a[i].startsWith('-I') && a[i].length > 2) placeholder = a[i].slice(2);
      else if (a[i].startsWith('-n') && a[i].length > 2) maxArgs = parseInt(a[i].slice(2));
      else if (a[i].startsWith('-d') && a[i].length > 2) delim = a[i].slice(2).replace(/^\\n$/, '\n').replace(/^\\0$/, '\0').replace(/^\\t$/, '\t');
      else rest.push(a[i]);
    }
    const items = stdin.split(delim).filter(l => l.trim());
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
    let sep = /\s+/, j1 = 0, j2 = 0;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') { sep = args[i + 1] || ' '; args.splice(i, 2); i--; }
      else if (args[i].startsWith('-t') && args[i].length > 2) { sep = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-1') { j1 = (parseInt(args[i + 1]) || 1) - 1; args.splice(i, 2); i--; }
      else if (args[i] === '-2') { j2 = (parseInt(args[i + 1]) || 1) - 1; args.splice(i, 2); i--; }
    }
    const files = args.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: join [-t 分隔符] [-1 N] [-2 N] 文件1 文件2'] };
    const splitLine = l => typeof sep === 'string' ? l.split(sep) : l.split(sep).filter(Boolean);
    const l1 = (e.readFile(files[0])?.content || '').split('\n').filter(l => l);
    const l2 = (e.readFile(files[1])?.content || '').split('\n').filter(l => l);
    const map2 = {};
    for (const l of l2) { const f = splitLine(l); map2[f[j2] ?? ''] = f.filter((_, idx) => idx !== j2).join(' '); }
    const out = [];
    for (const l of l1) {
      const f = splitLine(l);
      const key = f[j1] ?? '';
      if (map2[key] !== undefined) out.push([key, ...f.filter((_, idx) => idx !== j1), map2[key]].join(' '));
    }
    return { out: out.length ? out : ['(无匹配行)'], sfx: 'file-copy' };
  },

  diff: (a, stdin, e) => {
    const unified = a.includes('-u');
    const sideBySide = a.includes('-y');
    const quiet = a.includes('-q');
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: diff [-u|-y|-q] 文件1 文件2'] };
    const l1 = (e.readFile(files[0])?.content || '').split('\n');
    const l2 = (e.readFile(files[1])?.content || '').split('\n');
    const a1 = l1[l1.length - 1] === '' ? l1.slice(0, -1) : l1;
    const a2 = l2[l2.length - 1] === '' ? l2.slice(0, -1) : l2;
    const identical = a1.length === a2.length && a1.every((v, i) => v === a2[i]);
    if (quiet) {
      return identical ? { out: [], cls: 'info' } : { out: [`文件 ${files[0]} 和 ${files[1]} 不同`], sfx: 'text-grep' };
    }
    if (sideBySide) {
      const w = Math.max(...a1.map(l => l.length), ...a2.map(l => l.length), 20);
      const colW = Math.min(w, 40);
      const out = [];
      const max = Math.max(a1.length, a2.length);
      for (let i = 0; i < max; i++) {
        const left = (a1[i] ?? '').slice(0, colW).padEnd(colW);
        const right = (a2[i] ?? '').slice(0, colW);
        const sep = a1[i] === a2[i] ? ' ' : (a1[i] === undefined ? '>' : a2[i] === undefined ? '<' : '|');
        out.push(`${left} ${sep} ${right}`);
      }
      if (identical) return { out: ['(两个文件完全相同)'], cls: 'info' };
      return { out, sfx: 'text-grep' };
    }
    if (unified) {
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
    // 解析抑制列：-1/-2/-3 或组合如 -12/-23/-123
    let suppress = '';
    const files = [];
    for (const arg of a) {
      if (/^-[123]+$/.test(arg)) suppress += arg.slice(1);
      else if (!arg.startsWith('-')) files.push(arg);
    }
    if (files.length < 2) return { out: [], err: ['用法: comm [-1] [-2] [-3] 文件1 文件2'] };
    const s1 = new Set((e.readFile(files[0])?.content || '').split('\n').filter(l => l));
    const s2 = new Set((e.readFile(files[1])?.content || '').split('\n').filter(l => l));
    const out = [];
    if (!suppress.includes('1')) [...s1].filter(x => !s2.has(x)).sort().forEach(x => out.push(x));
    if (!suppress.includes('2')) [...s2].filter(x => !s1.has(x)).sort().forEach(x => out.push((suppress.includes('1') ? '' : '\t') + x));
    if (!suppress.includes('3')) [...s1].filter(x => s2.has(x)).sort().forEach(x => {
      let prefix = '';
      if (!suppress.includes('1')) prefix += '\t';
      if (!suppress.includes('2')) prefix += '\t';
      out.push(prefix + x);
    });
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
    let sep = null, table = false;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') { table = true; args.splice(i, 1); i--; }
      else if (args[i] === '-s') { sep = args[i + 1] ?? ' '; args.splice(i, 2); i--; }
      else if (args[i].startsWith('-s') && args[i].length > 2) { sep = args[i].slice(2); args.splice(i, 1); i--; }
    }
    const lines = stdin.split('\n').filter(l => l);
    if (!lines.length) return { out: [], err: ['column: 需要管道输入'] };
    const splitRe = sep ? sep : /\s+/;
    const rows = lines.map(l => l.split(splitRe).filter(x => x !== '' || sep));
    const cols = Math.max(...rows.map(r => r.length));
    const widths = [];
    for (let c = 0; c < cols; c++) widths.push(Math.max(...rows.map(r => (r[c] || '').length)));
    if (table) {
      return { out: rows.map(r => r.map((cell, c) => (cell || '').padEnd(widths[c])).join('  ').trimEnd()) };
    }
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
    // 支持管道：.a | .b | length 逐段求值
    const segments = filter.split('|').map(s => s.trim()).filter(Boolean);
    let results = [data];
    for (const seg of segments) {
      const next = [];
      for (const item of results) {
        try {
          if (seg === 'keys') {
            if (item && typeof item === 'object' && !Array.isArray(item)) next.push(Object.keys(item));
            else if (Array.isArray(item)) next.push([...Array(item.length).keys()]);
            else next.push([]);
          } else if (seg === 'values') {
            if (item && typeof item === 'object' && !Array.isArray(item)) next.push(Object.values(item));
            else next.push(item);
          } else if (seg === 'type') {
            if (item === null) next.push('null');
            else if (Array.isArray(item)) next.push('array');
            else next.push(typeof item);
          } else {
            next.push(...jqPath(item, seg));
          }
        } catch { return { out: [], err: [`jq: 不支持的过滤器: ${seg}（支持 .key · .a.b · .[] · .[N] · .length · keys · values · type · 管道 |）`] }; }
      }
      results = next;
    }
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

  /* ---- grep 全家桶：-r/-i/-n/-v/-c/-l/-w/-o/-E/-A/-B/-C ---- */
  grep: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const rest = a.filter(x => !x.startsWith('-'));
    if (!rest.length) return { out: [], err: ['用法: grep [-rinvcloEw] [-A N] [-B N] [-C N] 模式 [文件]'] };
    // 解析 -A/-B/-C 上下文行数
    let afterCtx = 0, beforeCtx = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-A') afterCtx = parseInt(a[i + 1]) || 0;
      else if (a[i] === '-B') beforeCtx = parseInt(a[i + 1]) || 0;
      else if (a[i] === '-C') { const n = parseInt(a[i + 1]) || 0; afterCtx = n; beforeCtx = n; }
      else if (/^-A\d+$/.test(a[i])) afterCtx = parseInt(a[i].slice(2)) || 0;
      else if (/^-B\d+$/.test(a[i])) beforeCtx = parseInt(a[i].slice(2)) || 0;
      else if (/^-C\d+$/.test(a[i])) { const n = parseInt(a[i].slice(2)) || 0; afterCtx = n; beforeCtx = n; }
    }
    let pattern = rest[0].replace(/^["']|["']$/g, '');
    if (flags.includes('w')) pattern = `\\b(?:${pattern})\\b`;
    let re;
    try { re = new RegExp(pattern, flags.includes('i') ? 'i' : ''); }
    catch { return { out: [], err: [`grep: 无效的正则: ${pattern}`] }; }
    const test = l => flags.includes('v') ? !re.test(l) : re.test(l);
    const matchParts = l => {
      const reG = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      const parts = []; let m;
      while ((m = reG.exec(l))) { parts.push(m[0]); if (!m[0]) reG.lastIndex++; }
      return parts;
    };
    // -r 递归搜索目录
    if (flags.includes('r') && rest[1] && e.isDir && e.isDir(rest[1])) {
      const base = rest[1].replace(/\/+$/, '') || '.';
      const out = []; let count = 0; const files = [];
      for (const rel of e.walk(base)) {
        const p = base === '.' ? './' + rel : base + '/' + rel;
        const r = e.readFile(p);
        if (r.err) continue;
        const hits = r.content.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => test(l));
        if (!hits.length) continue;
        files.push(p); count += hits.length;
        if (flags.includes('c') || flags.includes('l')) continue;
        for (const [no, l] of hits) {
          if (flags.includes('o')) out.push(...matchParts(l).map(s => `${p}:${s}`));
          else if (flags.includes('n')) out.push(`${p}:${no}:${l}`);
          else out.push(`${p}:${l}`);
        }
      }
      if (flags.includes('c')) return { out: [String(count)], mutated: false, sfx: 'text-grep' };
      if (flags.includes('l')) return { out: files, mutated: false, sfx: 'text-grep' };
      return { out, mutated: false, sfx: 'text-grep' };
    }
    let lines, srcName = null;
    if (rest[1]) {
      const r = e.readFile(rest[1]);
      if (r.err) return { out: [], err: [r.err] };
      lines = r.content.split('\n');
      srcName = rest[1];
    } else {
      lines = stdin.split('\n');
    }
    const hitIdx = [];
    lines.forEach((l, i) => { if (test(l)) hitIdx.push(i); });
    if (flags.includes('c')) return { out: [String(hitIdx.length)], mutated: false, sfx: 'text-grep' };
    if (flags.includes('l')) return { out: hitIdx.length && srcName ? [srcName] : [], mutated: false, sfx: 'text-grep' };
    // 上下文输出
    if ((afterCtx || beforeCtx) && hitIdx.length) {
      const show = new Set();
      for (const idx of hitIdx) {
        for (let j = Math.max(0, idx - beforeCtx); j <= Math.min(lines.length - 1, idx + afterCtx); j++) show.add(j);
      }
      const out = [];
      let prev = -2;
      for (const idx of [...show].sort((x, y) => x - y)) {
        if (idx - prev > 1) out.push('--');
        const l = lines[idx];
        if (flags.includes('o')) out.push(...matchParts(l));
        else if (flags.includes('n')) out.push(`${idx + 1}:${l}`);
        else out.push(l);
        prev = idx;
      }
      return { out, mutated: false, sfx: 'text-grep' };
    }
    let out;
    if (flags.includes('o')) out = hitIdx.flatMap(i => matchParts(lines[i]));
    else if (flags.includes('n')) out = hitIdx.map(i => `${i + 1}:${lines[i]}`);
    else out = hitIdx.map(i => lines[i]);
    return { out, mutated: false, sfx: 'text-grep' };
  },

  /* ---- cut 增强：-d/-f/-c/--complement ---- */
  cut: (a, stdin, e) => {
    let delim = '\t', fields = null, chars = null, complement = false;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--complement') { complement = true; args.splice(i, 1); i--; }
      else if (args[i] === '-d') { delim = args[i + 1]?.replace(/^["']|["']$/g, '') || '\t'; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-d') && args[i].length > 2) { delim = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-f') { fields = args[i + 1]; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-f') && args[i].length > 2) { fields = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-c') { chars = args[i + 1]; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-c') && args[i].length > 2) { chars = args[i].slice(2); args.splice(i, 1); i--; }
    }
    if (!fields && !chars) return { out: [], err: ['用法: cut -d 分隔符 -f 列号 [--complement] [文件]'] };
    const file = args.find(x => !x.startsWith('-'));
    let lines = file ? (e.readFile(file)?.content || '').split('\n').filter(l => l) : stdin.split('\n').filter(l => l);
    // 解析字段列表：支持 1,3 / 1-3 / 2- 形式
    const parseRange = (spec, max) => {
      const idx = new Set();
      for (const part of spec.split(',')) {
        const rm = part.match(/^(\d+)-(\d+)$/);
        const rm2 = part.match(/^(\d+)-$/);
        if (rm) { for (let j = parseInt(rm[1]); j <= parseInt(rm[2]); j++) idx.add(j - 1); }
        else if (rm2) { for (let j = parseInt(rm2[1]); j <= max; j++) idx.add(j - 1); }
        else idx.add(parseInt(part) - 1);
      }
      return idx;
    };
    let out;
    if (chars) {
      const maxC = Math.max(...lines.map(l => l.length), 1);
      let idx = parseRange(chars, maxC);
      if (complement) { const full = new Set([...Array(maxC).keys()]); idx = new Set([...full].filter(x => !idx.has(x))); }
      out = lines.map(l => [...idx].sort((a2, b2) => a2 - b2).map(c => l[c] || '').join(''));
    } else {
      const maxF = Math.max(...lines.map(l => l.split(delim).length), 1);
      let idx = parseRange(fields, maxF);
      if (complement) { const full = new Set([...Array(maxF).keys()]); idx = new Set([...full].filter(x => !idx.has(x))); }
      out = lines.map(l => {
        const parts = l.split(delim);
        return [...idx].sort((a2, b2) => a2 - b2).map(c => parts[c] || '').join(delim);
      });
    }
    return { out, mutated: false };
  },

  /* ---- tr 增强：-d/-s ---- */
  tr: (a, stdin, e) => {
    const del = a.includes('-d');
    const squeeze = a.includes('-s');
    const sets = a.filter(x => !x.startsWith('-'));
    if (!sets.length) return { out: [], err: ['用法: tr [-d] [-s] 字符集1 [字符集2]'] };
    let text = stdin;
    const expandSet = (s) => {
      // 支持 a-z 范围展开
      let out = '';
      for (let i = 0; i < s.length; i++) {
        if (i + 2 < s.length && s[i + 1] === '-') {
          const from = s.charCodeAt(i), to = s.charCodeAt(i + 2);
          for (let c = from; c <= to; c++) out += String.fromCharCode(c);
          i += 2;
        } else out += s[i];
      }
      return out;
    };
    if (del) {
      const charset = expandSet(sets[0].replace(/^["']|["']$/g, ''));
      const re = new RegExp('[' + charset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']', 'g');
      text = text.replace(re, '');
    } else if (sets.length >= 2) {
      const from = expandSet(sets[0].replace(/^["']|["']$/g, ''));
      const to = expandSet(sets[1].replace(/^["']|["']$/g, ''));
      text = text.split('').map(c => { const i = from.indexOf(c); return i >= 0 ? (to[i] || to[to.length - 1] || '') : c; }).join('');
    }
    if (squeeze) {
      const sqSet = sets.length >= 2 ? expandSet(sets[1].replace(/^["']|["']$/g, '')) : expandSet(sets[0].replace(/^["']|["']$/g, ''));
      const re = new RegExp('([' + sqSet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '])\\1+', 'g');
      text = text.replace(re, '$1');
    }
    return { out: text.split('\n'), mutated: false };
  },

  /* ---- sort 增强：-k/-t/-r/-n/-u/-f ---- */
  sort: (a, stdin, e) => {
    const args = [...a];
    let key = null, sep = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-k') { key = parseInt(args[i + 1]) || null; args.splice(i, 2); i--; }
      else if (/^-k\d+$/.test(args[i] || '')) { key = parseInt(args[i].slice(2)); args.splice(i, 1); i--; }
      else if (args[i] === '-t') { sep = (args[i + 1] || '').replace(/^["']|["']$/g, ''); args.splice(i, 2); i--; }
      else if (/^-t.$/.test(args[i] || '')) { sep = args[i].slice(2); args.splice(i, 1); i--; }
    }
    const flags = args.filter(x => x.startsWith('-')).join('');
    const file = args.find(x => !x.startsWith('-'));
    let lines = (file ? (e.readFile(file)?.content || '') : stdin).split('\n').filter(l => l || stdin);
    if (key) {
      const fieldOf = line => {
        const f = sep ? line.split(sep) : line.split(/\s+/).filter(Boolean);
        return f[key - 1] ?? '';
      };
      const tie = (x, y) => x < y ? -1 : x > y ? 1 : 0;
      lines.sort((x, y) => {
        const kx = fieldOf(x), ky = fieldOf(y);
        let c;
        if (flags.includes('n')) c = (parseFloat(kx) || 0) - (parseFloat(ky) || 0);
        else if (flags.includes('f')) c = kx.toLowerCase().localeCompare(ky.toLowerCase());
        else c = tie(kx, ky);
        return flags.includes('r') ? -c || tie(y, x) : c || tie(x, y);
      });
    } else {
      if (flags.includes('n')) lines.sort((x, y) => (parseFloat(x) || 0) - (parseFloat(y) || 0));
      else if (flags.includes('f')) lines.sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
      else lines.sort();
      if (flags.includes('r')) lines.reverse();
    }
    if (flags.includes('u')) lines = [...new Set(lines)];
    return { out: lines, mutated: false };
  },

  /* ---- uniq 增强：-c/-d/-u/-i ---- */
  uniq: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const ignoreCase = flags.includes('i');
    const file = a.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const lines = text.split('\n');
    const out = [];
    let prev = null, prevRaw = null, count = 0;
    const norm = l => ignoreCase ? l.toLowerCase() : l;
    const flush = () => {
      if (prev === null) return;
      if (flags.includes('c')) out.push(`${String(count).padStart(4)} ${prevRaw}`);
      else if (flags.includes('d')) { if (count > 1) out.push(prevRaw); }
      else if (flags.includes('u')) { if (count === 1) out.push(prevRaw); }
      else out.push(prevRaw);
    };
    for (const l of lines) {
      const n = norm(l);
      if (n === prev) count++;
      else { flush(); prev = n; prevRaw = l; count = 1; }
    }
    flush();
    return { out: out.filter(l => l !== '' || lines.includes('')), mutated: false };
  },

  /* ---- wc 增强：-l/-w/-c/-m ---- */
  wc: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const file = a.find(x => !x.startsWith('-'));
    let text;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    const lines = text.split('\n').filter(l => l).length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const bytes = new TextEncoder().encode(text).length;
    const chars = text.length;
    if (flags.includes('l')) return { out: [String(lines)], mutated: false };
    if (flags.includes('w')) return { out: [String(words)], mutated: false };
    if (flags.includes('c')) return { out: [String(bytes)], mutated: false };
    if (flags.includes('m')) return { out: [String(chars)], mutated: false };
    return { out: [`  ${lines}  ${words} ${chars}${file ? ' ' + file : ''}`], mutated: false };
  },

  /* ---- head 增强：-n/-c ---- */
  head: (a, stdin, e) => {
    let n = 10, bytes = null;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { n = parseInt(args[i + 1]) || 10; args.splice(i, 2); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { n = parseInt(args[i].slice(1)) || 10; args.splice(i, 1); i--; }
      else if (/^-n\d+$/.test(args[i] || '')) { n = parseInt(args[i].slice(2)) || 10; args.splice(i, 1); i--; }
      else if (args[i] === '-c') { bytes = parseInt(args[i + 1]) || 0; args.splice(i, 2); i--; }
      else if (/^-c\d+$/.test(args[i] || '')) { bytes = parseInt(args[i].slice(2)) || 0; args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    if (bytes !== null) return { out: text.slice(0, bytes) ? [text.slice(0, bytes)] : [], mutated: false };
    return { out: text.split('\n').slice(0, n), mutated: false };
  },

  /* ---- tail 增强：-n/-c/+N ---- */
  tail: (a, stdin, e) => {
    let n = 10, fromLine = null, bytes = null;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] || '';
      if (arg === '-n') {
        const v = args[i + 1] || '';
        if (v.startsWith('+')) fromLine = parseInt(v.slice(1)) || 1;
        else n = parseInt(v) || 10;
        args.splice(i, 2); i--;
      }
      else if (/^-n\+\d+$/.test(arg)) { fromLine = parseInt(arg.slice(3)) || 1; args.splice(i, 1); i--; }
      else if (/^-n\d+$/.test(arg)) { n = parseInt(arg.slice(2)) || 10; args.splice(i, 1); i--; }
      else if (/^\+\d+$/.test(arg)) { fromLine = parseInt(arg.slice(1)) || 1; args.splice(i, 1); i--; }
      else if (arg === '-c') { bytes = parseInt(args[i + 1]) || 0; args.splice(i, 2); i--; }
      else if (/^-c\d+$/.test(arg)) { bytes = parseInt(arg.slice(2)) || 0; args.splice(i, 1); i--; }
      else if (arg === '-f') { args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    if (bytes !== null) { const s = text.slice(Math.max(0, text.length - bytes)); return { out: s ? [s] : [], mutated: false }; }
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    if (fromLine !== null) return { out: lines.slice(fromLine - 1), mutated: false };
    return { out: lines.slice(Math.max(0, lines.length - n)), mutated: false };
  },

  /* ---- tac：逆序输出行 ---- */
  tac: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const lines = text.replace(/\n$/, '').split('\n');
    return { out: lines.reverse(), mutated: false };
  },

  /* ---- fold：按宽度折行 ---- */
  fold: (a, stdin, e) => {
    let width = 80;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-w') { width = parseInt(args[i + 1]) || 80; args.splice(i, 2); i--; }
      else if (/^-w\d+$/.test(args[i] || '')) { width = parseInt(args[i].slice(2)) || 80; args.splice(i, 1); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { width = parseInt(args[i].slice(1)) || 80; args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const out = [];
    for (const line of text.replace(/\n$/, '').split('\n')) {
      for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
      if (!line.length) out.push('');
    }
    return { out, mutated: false };
  },

  /* ---- fmt：简单段落格式化 ---- */
  fmt: (a, stdin, e) => {
    let width = 75;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-w') { width = parseInt(args[i + 1]) || 75; args.splice(i, 2); i--; }
      else if (/^-w\d+$/.test(args[i] || '')) { width = parseInt(args[i].slice(2)) || 75; args.splice(i, 1); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { width = parseInt(args[i].slice(1)) || 75; args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const words = text.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
    const out = []; let line = '';
    for (const w of words) {
      if (line && (line + ' ' + w).length > width) { out.push(line); line = w; }
      else line = line ? line + ' ' + w : w;
    }
    if (line) out.push(line);
    return { out, mutated: false };
  },

  /* ---- expand：Tab 转空格 ---- */
  expand: (a, stdin, e) => {
    let tabSize = 8;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') { tabSize = parseInt(args[i + 1]) || 8; args.splice(i, 2); i--; }
      else if (/^-t\d+$/.test(args[i] || '')) { tabSize = parseInt(args[i].slice(2)) || 8; args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const out = text.replace(/\n$/, '').split('\n').map(line => {
      let result = '';
      for (const ch of line) {
        if (ch === '\t') result += ' '.repeat(tabSize - (result.length % tabSize));
        else result += ch;
      }
      return result;
    });
    return { out, mutated: false };
  },

  /* ---- unexpand：空格转 Tab ---- */
  unexpand: (a, stdin, e) => {
    let tabSize = 8;
    const all = a.includes('-a');
    const args = a.filter(x => !x.startsWith('-') || /^-t\d+$/.test(x));
    for (let i = 0; i < args.length; i++) {
      if (/^-t\d+$/.test(args[i])) tabSize = parseInt(args[i].slice(2)) || 8;
    }
    const file = a.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const spaces = ' '.repeat(tabSize);
    const out = text.replace(/\n$/, '').split('\n').map(line => {
      if (all) return line.replace(new RegExp(spaces.replace(/ /g, ' '), 'g'), '\t');
      // 默认只转行首空格
      const m = line.match(/^( +)/);
      if (!m) return line;
      const lead = m[1];
      const tabs = '\t'.repeat(Math.floor(lead.length / tabSize));
      return tabs + ' '.repeat(lead.length % tabSize) + line.slice(lead.length);
    });
    return { out, mutated: false };
  },

  /* ---- od：八进制/十六进制转储 ---- */
  od: (a, stdin, e) => {
    const hex = a.includes('-x') || a.includes('-t') || a.some(x => x.startsWith('-t'));
    const file = a.find(x => !x.startsWith('-') && !x.startsWith('x'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const bytes = new TextEncoder().encode(text);
    const out = [];
    for (let i = 0; i < bytes.length; i += 16) {
      const chunk = bytes.slice(i, i + 16);
      const addr = i.toString(8).padStart(7, '0');
      if (hex) {
        out.push(addr + ' ' + [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' '));
      } else {
        out.push(addr + ' ' + [...chunk].map(b => b.toString(8).padStart(3, '0')).join(' '));
      }
    }
    out.push(bytes.length.toString(8).padStart(7, '0'));
    return { out, mutated: false };
  },

  /* ---- strings：提取可打印字符串 ---- */
  strings: (a, stdin, e) => {
    let minLen = 4;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { minLen = parseInt(args[i + 1]) || 4; args.splice(i, 2); i--; }
      else if (/^-n\d+$/.test(args[i] || '')) { minLen = parseInt(args[i].slice(2)) || 4; args.splice(i, 1); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { minLen = parseInt(args[i].slice(1)) || 4; args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    const re = new RegExp(`[\\x20-\\x7E]{${minLen},}`, 'g');
    const out = text.match(re) || [];
    return { out, mutated: false };
  },

  /* ---- cmp：逐字节比较两文件 ---- */
  cmp: (a, stdin, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: cmp 文件1 文件2'] };
    const r1 = e.readFile(files[0]), r2 = e.readFile(files[1]);
    if (r1.err) return { out: [], err: [r1.err] };
    if (r2.err) return { out: [], err: [r2.err] };
    const c1 = r1.content, c2 = r2.content;
    if (c1 === c2) return { out: [], cls: 'info' };
    const len = Math.min(c1.length, c2.length);
    for (let i = 0; i < len; i++) {
      if (c1[i] !== c2[i]) {
        return { out: [`${files[0]} ${files[1]} 不同: 字节 ${i + 1}, 行 ${c1.slice(0, i).split('\n').length}`], sfx: 'text-grep' };
      }
    }
    const shorter = c1.length < c2.length ? files[0] : files[1];
    return { out: [`cmp: EOF on ${shorter}`], sfx: 'text-grep' };
  },

  /* ---- patch（简）：应用 unified diff 补丁 ---- */
  patch: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    if (!file) return { out: [], err: ['用法: patch 文件 < 补丁（或 patch 文件 补丁文件）'] };
    const r = e.readFile(file);
    if (r.err) return { out: [], err: [r.err] };
    const patchText = a.filter(x => !x.startsWith('-'))[1] ? (e.readFile(a.filter(x => !x.startsWith('-'))[1])?.content || '') : stdin;
    if (!patchText.trim()) return { out: ['patch: 空补丁'], err: [] };
    // 简化：解析 +/- 行，应用替换
    const lines = r.content.split('\n');
    const patchLines = patchText.split('\n');
    const out = [];
    let li = 0;
    for (const pl of patchLines) {
      if (pl.startsWith('---') || pl.startsWith('+++') || pl.startsWith('@@')) continue;
      if (pl.startsWith('-')) { li++; continue; }
      if (pl.startsWith('+')) { out.push(pl.slice(1)); continue; }
      if (pl.startsWith(' ')) { if (li < lines.length) out.push(lines[li]); li++; continue; }
      // 非 diff 行忽略
    }
    if (out.length) {
      e.writeFile(file, out.join('\n') + '\n');
      return { out: [`patching file ${file}`], sfx: 'file-write' };
    }
    return { out: [`patching file ${file}`, 'Hunk #1 succeeded'], sfx: 'file-write' };
  },

  /* ---- base64：编解码 ---- */
  base64: (a, stdin, e) => {
    const decode = a.includes('-d') || a.includes('--decode');
    const file = a.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    try {
      if (decode) {
        // 手动 base64 解码
        const cleaned = text.replace(/\s/g, '');
        const bin = atob(cleaned);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { out: [new TextDecoder().decode(bytes)], mutated: false };
      }
      const bytes = new TextEncoder().encode(text.replace(/\n$/, ''));
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return { out: [btoa(bin)], mutated: false };
    } catch {
      return { out: [], err: ['base64: 无效的输入'] };
    }
  },

  /* ---- sha256sum：输出 64 位十六进制哈希 + 文件名 ---- */
  sha256sum: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    let content;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      content = r.content;
    } else content = stdin;
    // 用两路 simpleHash128 拼成 64 位
    const h1 = simpleHash128(content);
    const h2 = simpleHash128(content.split('').reverse().join(''));
    return { out: [`${h1}${h2}  ${file || '-'}`], mutated: false };
  },

  /* ---- iconv（简）：编码转换模拟 ---- */
  iconv: (a, stdin, e) => {
    let from = 'UTF-8', to = 'UTF-8';
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-f') { from = args[i + 1] || 'UTF-8'; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-f') && args[i].length > 2) { from = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-t') { to = args[i + 1] || 'UTF-8'; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-t') && args[i].length > 2) { to = args[i].slice(2); args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    // 模拟：UTF-8 → ASCII 时去掉非 ASCII 字符
    if (/ascii/i.test(to) && !/ascii/i.test(from)) {
      text = text.replace(/[^\x00-\x7F]/g, '');
    }
    return { out: text.replace(/\n$/, '').split('\n'), mutated: false };
  },

  /* ---- more/less：分页器模拟（直接输出内容） ---- */
  more: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    return { out: text.replace(/\n$/, '').split('\n'), cls: 'out' };
  },
  less: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    return { out: text.replace(/\n$/, '').split('\n'), cls: 'out' };
  },
};

function showTextHelp() {
  ['── 查找 ──',
    '  find [路径] -name "*.log" · find . -type f · find . -name "*.tmp" -exec rm {} \\;',
    '  find . -iname "*.LOG"（忽略大小写） · find . -maxdepth 1 · find . -mindepth 2 · find . -path "*docs*"',
    '  find . -size +100 / -size -10（按内容字节数） · find . -mtime -1 · find . -name "*.bak" -delete · -print0',
    '  find . -name "*.log" | xargs rm · xargs -I {} 模板 {} · xargs -n 2 命令 · xargs -d 分隔符',
    '── 搜索过滤 ──',
    '  grep [-rinvcloEw] [-A N] [-B N] [-C N] 模式 [文件] · grep -r 递归 · grep -E 扩展正则',
    '  cut -d 分隔符 -f 列号 [--complement] · tr [-d] [-s] 字符集1 [字符集2]',
    '  sort [-k N] [-t 分隔符] [-rnfu] · uniq [-cdui] · wc [-lwcm]',
    '  head [-n N] [-c N] · tail [-n N] [-c N] [+N]',
    '── 进阶文本 ──',
    '  awk \'$2 > 30 {print $1}\' 文件 · awk \'{sum+=$2} END {print sum}\' 文件',
    '  awk -v 变量=值 \'BEGIN {printf "表头 %s\\n", 变量} ...\' · printf 支持 %s %d %.2f · $0 整行',
    '  sed \'2d\' · sed -n \'3p\' · sed \'/模式/d\' · sed -i \'s/旧/新/g\' · sed \'1,3s/旧/新/g\'',
    '  sed \'2a\\追加文本\' · sed \'/模式/i\\插入文本\'（a 在后、i 在前）',
    '── 合并对比 ──',
    '  paste [-d 分隔符] 文件1 文件2 · join [-t 分隔符] [-1 N] [-2 N] 文件1 文件2',
    '  diff [-u|-y|-q] 文件1 文件2 · comm [-1] [-2] [-3] 文件1 文件2 · cmp 文件1 文件2',
    '── 格式转换 ──',
    '  tac（逆序行） · fold [-w N]（折行） · fmt [-w N]（段落格式化）',
    '  expand [-t N]（Tab→空格） · unexpand [-a]（空格→Tab） · od [-x]（八/十六进制转储）',
    '  strings [-n N]（提取可打印串） · base64 [-d]（编解码） · sha256sum · iconv -f UTF-8 -t ASCII',
    '── JSON 与工具 ──',
    '  jq \'.key\' 文件.json · 过滤器：. · .key · .a.b · .[] · .[N] · .length · keys · values · type · 管道 |',
    '  nl 文件（行编号） · shuf 文件（打乱行序） · md5sum 文件（哈希校验）',
    '  命令 | tee 文件 · 命令 | column -t [-s 分隔符] · rev · seq N · more/less 文件',
    '── 其余 ──',
    '  patch 文件（应用补丁） · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
