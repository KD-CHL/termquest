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

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'echo', 'wc', 'head', 'tail', 'find'];

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

const TEXT = {
  /* ---- find ---- */
  find: (a, stdin, e) => {
    let path = '.';
    let name = null, type = null, execCmd = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-name') name = a[++i]?.replace(/^["']|["']$/g, '');
      else if (a[i] === '-type') type = a[++i];
      else if (a[i] === '-exec') { execCmd = a.slice(i + 1).join(' ').replace(/\\\;|\;\s*$/, '').trim(); break; }
      else if (!a[i].startsWith('-')) path = a[i];
    }
    const base = e.resolvePath(path);
    if (!e.exists(base)) return { out: [], err: [`find: '${path}': 没有那个文件或目录`] };
    const results = [];
    const walkAll = (p) => {
      const node = e.follow(p);
      if (!node) return;
      const isFile = node.type === 'file', isDir = node.type === 'dir';
      const nameOk = !name || globToRe(name).test(e.basename(p));
      const typeOk = !type || (type === 'f' && isFile) || (type === 'd' && isDir);
      const disp = p === base ? (path === '.' ? '.' : path) : path === '.' ? p.replace(base + '/', '') : p;
      if (nameOk && typeOk && !(p === base && type === 'f' && !name)) {
        if (!(p === base && type && type === 'f')) results.push(disp);
      }
      if (node.type === 'dir') {
        for (const child of Object.keys(node.children).sort()) walkAll(p === '/' ? '/' + child : p + '/' + child);
      }
    };
    walkAll(base);
    const uniq = [...new Set(results)];
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
    const cmdName = a.find(x => !x.startsWith('-')) || 'echo';
    const out = [];
    for (const item of items) {
      const full = `${cmdName} ${item}`;
      const res = runStage(full, '', e, false);
      if (res.out && res.out.length) out.push(...res.out);
    }
    return { out, sfx: 'pipe-whoosh' };
  },

  /* ---- awk 进阶（条件 / 聚合 / NR） ---- */
  awk: (a, stdin, e) => {
    let fieldSep = /\s+/;
    let prog = a[0], fileArg = a[1];
    if (a[0] === '-F') { fieldSep = new RegExp(escRe(a[1])); prog = a[2]; fileArg = a[3]; }
    else if (a[0] && a[0].startsWith('-F')) { fieldSep = new RegExp(escRe(a[0].slice(2))); prog = a[1]; fileArg = a[2]; }
    if (!prog) return { out: [], err: ['用法: awk [-F 分隔符] \'程序\' [文件]'] };
    let text;
    if (fileArg) {
      const r = e.readFile(fileArg);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    const lines = text.split('\n').filter(l => l);
    const endMatch = prog.match(/END\s*\{(.*)\}/);
    const mainRaw = endMatch ? prog.slice(0, prog.indexOf('END')).trim() : prog;
    const mainPart = mainRaw.replace(/^["']?\{|\}["']?$/g, '');
    const rows = lines.map((l, idx) => ({ fields: l.split(fieldSep).filter(Boolean), line: l, nr: idx + 1 }));

    const evalCond = (cond, row) => {
      cond = (cond || '').trim();
      if (!cond) return true;
      let m;
      if ((m = cond.match(/^NR\s*==\s*(\d+)$/))) return row.nr === parseInt(m[1]);
      if ((m = cond.match(/^\$(\d+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/))) {
        const val = row.fields[parseInt(m[1]) - 1] || '';
        const rhs = m[3].replace(/["']/g, '');
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
    const agg = mainPart.match(/(?:sum|total|count)\s*\+=\s*\$(\d+)/);
    const pm = !agg ? mainPart.match(/^(.*?)\{?\s*print\s*(.*)$/s) : null;
    const condOf = agg ? mainPart.slice(0, mainPart.indexOf('{')).trim() : (pm ? pm[1].trim() : mainPart);

    for (const row of rows) {
      if (!evalCond(condOf, row)) continue;
      if (agg) { sum += parseFloat(row.fields[parseInt(agg[1]) - 1] || 0); cnt++; }
      else if (pm) {
        const expr = pm[2].trim();
        if (!expr) { out.push(row.line); continue; }
        out.push(expr.replace(/\$(\d+)/g, (_, n) => row.fields[parseInt(n) - 1] || '').replace(/["']/g, ''));
      } else out.push(row.line);
    }
    if (endMatch && endMatch[1]) {
      let expr = endMatch[1].trim().replace(/print\s*/, '').replace(/["']/g, '');
      expr = expr.replace(/\b(?:sum|total)\b/g, String(sum)).replace(/\bcount\b/g, String(cnt));
      try { expr = String(Function('"use strict";return (' + expr + ')')()); } catch {}
      out.push(expr);
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
    if (expr.startsWith('s/')) {
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
    } else {
      return { out: [], err: [`sed: 不支持的表达式: ${expr}（支持 s/旧/新/g · Nd · N,Md · -n Np · /re/d · /re/p）`] };
    }
    if (a.includes('-i') && file) {
      e.writeFile(file, out.join('\n') + '\n');
      return { out: [], sfx: 'file-write' };
    }
    return { out };
  },

  /* ---- paste / join / diff / comm ---- */
  paste: (a, stdin, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: paste 文件1 文件2'] };
    const lists = files.map(f => (e.readFile(f)?.content || '').split('\n').filter(l => l));
    const maxLen = Math.max(...lists.map(l => l.length));
    const out = [];
    for (let i = 0; i < maxLen; i++) out.push(lists.map(l => l[i] || '').join('\t'));
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
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: diff 文件1 文件2'] };
    const l1 = (e.readFile(files[0])?.content || '').split('\n');
    const l2 = (e.readFile(files[1])?.content || '').split('\n');
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
};

function showTextHelp() {
  ['── 查找 ──',
    '  find [路径] -name "*.log" · find . -type f · find . -name "*.tmp" -exec rm {} \\;',
    '  find . -name "*.log" | xargs rm',
    '── 进阶文本 ──',
    '  awk \'$2 > 30 {print $1}\' 文件 · awk \'{sum+=$2} END {print sum}\' 文件',
    '  sed \'2d\' 文件 · sed -n \'3p\' 文件 · sed \'/模式/d\' 文件 · sed -i \'s/旧/新/g\' 文件',
    '── 合并对比 ──',
    '  paste 文件1 文件2 · join 文件1 文件2 · diff 文件1 文件2 · comm 文件1 文件2',
    '── 工具 ──',
    '  命令 | tee 文件 · 命令 | column -t · rev · seq N',
    '── 其余 ──',
    '  grep · sort · uniq · cut · tr · wc ... 照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
