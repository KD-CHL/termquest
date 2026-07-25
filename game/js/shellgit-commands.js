// Shell + Git 混合命令集 —— 在 git 仓库里做文本处理 / 脚本自动化
// 共享 GitEngine（G）：shell 命令直接操作 G.files（扁平文件映射），
// git 命令委托给 commands.js 的 gitExecute。
import { G, app } from './state.js';
import { execute as gitExecute, tokenize } from './commands.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { parsePipeline } from './fs.js';

function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

// 这些命令由本模块处理，其余交给 gitExecute（git / echo / ls / cat / rm / clear / help）
// 注意：不要把无处理器的命令放进 SHELL_HANDLED（曾误收 'append'，已移除使其自然落回 gitExecute）
const SHELL_HANDLED = new Set(['grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail', 'bash', 'sh', 'vim']);

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

function handleShell(input, base) {
  const { stages, redirect } = parsePipeline(input);
  let stdin = '';
  let last = null;
  for (let i = 0; i < stages.length; i++) {
    last = runShellStage(stages[i], stdin);
    if (last.err) {
      print(last.err, 'err');
      sfx(last.sfx || 'err-file');
      after(false);
      return;
    }
    stdin = last.out.join('\n');
    if (i < stages.length - 1) sfx('pipe-tick');
  }

  if (redirect.file) {
    const content = stdin + (stdin ? '\n' : '');
    G.files[redirect.file] = redirect.type === '>>' ? (G.files[redirect.file] || '') + content : content;
    sfx('file-write');
    after(true);
    return;
  }

  if (last.out.length) last.out.forEach(l => print(l, 'out'));
  if (last.sfx) sfx(last.sfx);
  after(true);
}

function runShellStage(stage, stdin) {
  const t = tokenize(stage);
  const cmd = t[0];
  const args = t.slice(1);
  track(cmd);
  G.used.add(cmd);

  const fn = SHELL[cmd];
  if (!fn) return { out: [], err: [`${cmd}: command not found`], sfx: 'err-syntax' };
  return fn(args, stdin);
}

// 读取文件内容（G.files 扁平映射）
function readF(name) {
  if (G.files[name] === undefined) return null;
  return G.files[name];
}

const SHELL = {
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
    if (flags.includes('c')) return { out: [String(matched.length)], mutated: false, sfx: 'text-grep' };
    if (flags.includes('l')) return { out: matched.length ? [fname] : [], mutated: false, sfx: 'text-grep' };
    return { out: matched.map(({ l, i }) => flags.includes('n') ? `${i + 1}:${l}` : l), mutated: false, sfx: 'text-grep' };
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
    }
    const file = args.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const lines = text.split('\n');
    if (from !== null) return { out: lines.slice(from - 1), mutated: false };
    return { out: lines.slice(Math.max(0, lines.length - n)), mutated: false };
  },

  // 脚本执行：bash script.sh 逐行执行文件里的命令
  bash: (a, stdin) => {
    const file = a[0];
    if (!file) return { out: [], err: ['用法: bash 脚本.sh'] };
    const c = readF(file);
    if (c === null) return { out: [], err: [`bash: ${file}: 没有那个文件`] };
    const lines = c.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    sfx('proc-spawn');
    const prev = app.inScript; app.inScript = true;
    try {
      for (const line of lines) {
        // 逐行递归执行（git 命令走 gitExecute，shell 命令走本模块）
        shellgitExecute(line);
      }
    } finally { app.inScript = prev; }
    return { out: [], mutated: true };
  },
  sh: (a, stdin) => SHELL.bash(a, stdin),

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
};
