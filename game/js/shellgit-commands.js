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
const SHELL_HANDLED = new Set(['grep', 'sed', 'awk', 'sort', 'uniq', 'wc', 'head', 'tail', 'bash', 'sh', 'vim', 'append']);

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
    const pattern = rest[0].replace(/^["']|["']$/g, '');
    let lines;
    if (rest[1]) {
      const c = readF(rest[1]);
      if (c === null) return { out: [], err: [`grep: ${rest[1]}: 没有那个文件`] };
      lines = c.split('\n');
    } else lines = stdin.split('\n');
    let re;
    try { re = new RegExp(pattern, flags.includes('i') ? 'i' : ''); }
    catch { return { out: [], err: [`grep: 无效的正则: ${pattern}`] }; }
    let matched = lines.filter(l => re.test(l));
    if (flags.includes('v')) matched = lines.filter(l => !re.test(l));
    return { out: flags.includes('c') ? [String(matched.length)] : matched, mutated: false, sfx: 'text-grep' };
  },

  sed: (a, stdin) => {
    // sed [-i] 's/old/new/[g]' [file]
    const inplace = a.includes('-i');
    const rest = a.filter(x => x !== '-i');
    const expr = rest[0]?.replace(/^["']|["']$/g, '');
    if (!expr || !expr.startsWith('s/')) return { out: [], err: ['用法: sed [-i] \'s/旧/新/[g]\' [文件]'] };
    const parts = expr.split('/');
    if (parts.length < 3) return { out: [], err: [`sed: 无效表达式: ${expr}`] };
    const [, pat, rep, g] = parts;
    let re;
    try { re = new RegExp(pat, g === 'g' ? 'g' : ''); }
    catch { return { out: [], err: [`sed: 无效的正则: ${pat}`] }; }
    const file = rest[1];
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
    const prog = (a[0] || '').replace(/^["'{]+|["'}]+$/g, '');
    const file = a[1];
    const pm = prog.match(/print\s+(.*)/);
    if (!pm) return { out: [], err: ['用法: awk \'{print $1}\' [文件]'] };
    let lines;
    if (file) {
      const c = readF(file);
      if (c === null) return { out: [], err: [`awk: ${file}: 没有那个文件`] };
      lines = c.split('\n').filter(l => l);
    } else lines = stdin.split('\n').filter(l => l);
    return {
      out: lines.map(l => {
        const fields = l.split(/\s+/).filter(Boolean);
        return pm[1].replace(/\$(\d+)/g, (_, n) => fields[parseInt(n) - 1] || '');
      }),
      mutated: false,
    };
  },

  sort: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const file = a.find(x => !x.startsWith('-'));
    let lines = (file ? readF(file) || '' : stdin).split('\n').filter(l => l);
    if (flags.includes('n')) lines.sort((x, y) => parseFloat(x) - parseFloat(y));
    else lines.sort();
    if (flags.includes('r')) lines.reverse();
    if (flags.includes('u')) lines = [...new Set(lines)];
    return { out: lines, mutated: false };
  },

  uniq: (a, stdin) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const lines = stdin.split('\n');
    const out = [];
    let prev = null, count = 0;
    const flush = () => {
      if (prev === null) return;
      if (flags.includes('c')) out.push(`${String(count).padStart(4)} ${prev}`);
      else out.push(prev);
    };
    for (const l of lines) { if (l === prev) count++; else { flush(); prev = l; count = 1; } }
    flush();
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
    let n = 10; const args = [...a];
    const ni = args.indexOf('-n');
    if (ni >= 0) { n = parseInt(args[ni + 1]) || 10; args.splice(ni, 2); }
    const file = args.find(x => !x.startsWith('-'));
    const text = file ? (readF(file) || '') : stdin;
    const lines = text.split('\n');
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
