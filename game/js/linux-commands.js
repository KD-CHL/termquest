// Linux 命令集 —— 文件操作 / 文本处理 / 管道 / 进程管理
// 与 commands.js 同级：接收输入字符串，操作 app.engine（LinuxEngine），
// 通过 app.afterCommand 钩子通知 ui 重渲染。
import { app } from './state.js';
import { print, printCmd, clearTerm } from './terminal.js';
import { sfx, sfxClick } from './effects.js';
import { parsePipeline } from './fs.js';
import { tokenize } from './commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

// 输出辅助：收集行，最后统一打印 + 记录 lastOut
function emit(lines, cls = 'out') { lines.forEach(l => print(l, cls)); }

/* ============ 主入口 ============ */
export function linuxExecute(input, engineOverride) {
  input = input.trim();
  if (!input) return;
  printCmd(input);
  const e = engineOverride || E();
  e.history.push(input);

  // 后台任务标记
  let bg = false;
  if (input.endsWith('&') && !input.endsWith('&&')) { bg = true; input = input.slice(0, -1).trim(); }

  const base = input.split(/\s/)[0];
  if (!['help', 'clear', 'ls', 'pwd', 'cat', 'ps', 'top', 'jobs', 'whoami', 'hostname', 'uname', 'date', 'history', 'echo', 'wc', 'head', 'tail', 'env', 'which', 'stat', 'basename', 'dirname', 'file'].includes(base)) {
    app.cmdCount++;
  }
  if (app.updateCmdCount) app.updateCmdCount();

  if (input === 'clear') { clearTerm(); return; }
  if (input === 'help') { showLinuxHelp(); return; }

  const { stages, redirect } = parsePipeline(input);
  if (!stages.length) return;

  let stdin = '';
  let lastResult = null;
  let piped = stages.length > 1;

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isLast = i === stages.length - 1;
    lastResult = runStage(stage, stdin, e, isLast && !piped);
    if (lastResult.err && lastResult.err.length) {
      emit(lastResult.err, 'err');
      if (lastResult.sfx) sfx(lastResult.sfx); else sfx('err-file');
      e.lastOut = '';
      after(false);
      return;
    }
    stdin = lastResult.out.join('\n');
    if (piped && i < stages.length - 1) sfx('pipe-tick');
  }

  // 重定向
  if (redirect.file) {
    const content = stdin + (stdin ? '\n' : '');
    if (redirect.type === '>>') {
      const old = e.readFile(redirect.file);
      const prev = old.ok ? old.content : '';
      e.writeFile(redirect.file, prev + content);
    } else {
      e.writeFile(redirect.file, content);
    }
    sfx('file-write');
    after(true);
    return;
  }

  // 打印输出
  if (lastResult.out.length) emit(lastResult.out, lastResult.cls || 'out');
  e.lastOut = lastResult.out.join('\n');
  if (lastResult.sfx) sfx(lastResult.sfx);

  // 后台任务
  if (bg && lastResult.pid) {
    const jid = e.nextJid++;
    e.jobs.push({ jid, pid: lastResult.pid, cmd: input, state: 'Running' });
    print(`[${jid}] ${lastResult.pid}`, 'info');
  }

  // 即使命令不改文件（如 ls / grep），也可能推进 used 集合触发过关判定，所以总是检查
  after(true);
}

/* ============ 单阶段执行 ============ */
export function runStage(stage, stdin, e, direct) {
  const t = tokenize(stage);
  const cmd = t[0];
  const args = t.slice(1);
  track(cmd);
  e.used.add(cmd);

  const fn = CMD[cmd];
  if (!fn) return { out: [], err: [`${cmd}: command not found`], sfx: 'err-syntax' };
  return fn(args, stdin, e, stage);
}

// 远程单命令模式（ssh host cmd / scp 内部用）：执行并返回输出，不打印到终端
export function runRemoteCmd(input, engine) {
  const { stages } = parsePipeline(input);
  let stdin = '';
  let last = { out: [] };
  for (const stage of stages) {
    last = runStage(stage, stdin, engine, false);
    if (last.err && last.err.length) return { out: last.err, err: true };
    stdin = last.out.join('\n');
  }
  return { out: last.out };
}

/* ============ 命令实现 ============ */
const CMD = {

  /* ---- 导航 / 查看 ---- */
  pwd: (a, stdin, e) => ({ out: [e.cwd], mutated: false }),

  cd: (a, stdin, e) => {
    const target = e.resolvePath(a[0] || '~');
    const node = e.follow(target);
    if (!node) return { out: [], err: [`cd: ${a[0] || '~'}: 没有那个文件或目录`] };
    if (node.type !== 'dir') return { out: [], err: [`cd: ${a[0]}: 不是目录`] };
    e.cwd = target;
    sfx('ui-tab');
    return { out: [] };
  },

  ls: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const paths = a.filter(x => !x.startsWith('-'));
    const target = paths[0] || e.cwd;
    const node = e.follow(target);
    if (!node) return { out: [], err: [`ls: 无法访问 '${target}': 没有那个文件或目录`] };
    if (node.type !== 'dir') return { out: [e.basename(e.resolvePath(target))], mutated: false };

    const showAll = flags.includes('a') || flags.includes('A');
    const sizeOf = c => c.type === 'dir' ? 4096 : c.type === 'link' ? c.target.length : (c.content || '').length;
    const humanSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + 'M' : n >= 1024 ? (n / 1024).toFixed(1) + 'K' : String(n);

    const getEntries = n => {
      let entries = Object.entries(n.children);
      if (!showAll) entries = entries.filter(([name]) => !name.startsWith('.'));
      if (flags.includes('t')) entries.sort(([x], [y]) => mtimeOf(y) - mtimeOf(x) || x.localeCompare(y));
      else if (flags.includes('S')) entries.sort(([x, cx], [y, cy]) => sizeOf(cy) - sizeOf(cx) || x.localeCompare(y));
      else entries.sort(([x], [y]) => x.localeCompare(y));
      return entries;
    };
    const fmtLong = entries => {
      const lines = [`total ${entries.length}`];
      for (const [name, child] of entries) {
        const size = sizeOf(child);
        const sizeStr = flags.includes('h') ? humanSize(size) : String(size);
        const arrow = child.type === 'link' ? ` -> ${child.target}` : '';
        lines.push(`${child.mode} 1 ${child.owner.padEnd(6)} ${child.group.padEnd(6)} ${sizeStr.padStart(5)} Jul 25 10:00 ${name}${arrow}`);
      }
      return lines;
    };
    const fmtShort = entries => entries.map(([n, c]) => c.type === 'dir' ? n + '/' : n);

    // -R 递归列出子目录（带 目录: 头）
    if (flags.includes('R')) {
      const out = [];
      const rec = (n, label) => {
        const entries = getEntries(n);
        out.push(`${label}:`);
        out.push(...(flags.includes('l') ? fmtLong(entries) : fmtShort(entries)));
        out.push('');
        for (const [name, child] of entries) {
          if (child.type === 'dir') rec(child, (label === '.' ? './' : label + '/') + name);
        }
      };
      rec(node, target === e.cwd ? '.' : target);
      while (out.length && out[out.length - 1] === '') out.pop();
      return { out, mutated: false };
    }

    const entries = getEntries(node);
    if (flags.includes('l')) return { out: fmtLong(entries), mutated: false };
    const names = fmtShort(entries);
    if (flags.includes('1')) return { out: names.length ? names : ['(空)'], mutated: false };
    return { out: [names.join('  ') || '(空)'], mutated: false };
  },

  cat: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const files = a.filter(x => !x.startsWith('-'));
    const number = lines => flags.includes('n')
      ? lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      : lines;
    if (!files.length) return { out: number(stdin ? stdin.split('\n') : []), mutated: false };
    const out = [];
    for (const f of files) {
      const r = e.readFile(f);
      if (r.err) return { out: [], err: [r.err] };
      out.push(...r.content.replace(/\n$/, '').split('\n'));
    }
    return { out: number(out), mutated: false };
  },

  echo: (a, stdin, e) => {
    const text = a.join(' ').replace(/^["']|["']$/g, '');
    // 支持 $VAR 展开
    const expanded = text.replace(/\$(\w+)/g, (_, v) => e.env[v] || '');
    return { out: [expanded], mutated: false };
  },

  /* ---- 文件操作 ---- */
  mkdir: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const dirs = a.filter(x => !x.startsWith('-'));
    if (!dirs.length) return { out: [], err: ['mkdir: 缺少操作数'] };
    for (const d of dirs) {
      if (flags.includes('p')) {
        // 递归创建
        const resolved = e.resolvePath(d);
        const segs = resolved.split('/').filter(Boolean);
        let cur = '';
        for (const seg of segs) {
          cur += '/' + seg;
          if (!e.exists(cur)) e.mkdir(cur);
        }
      } else {
        const r = e.mkdir(d);
        if (r.err) return { out: [], err: [r.err] };
      }
    }
    return { out: [], sfx: 'file-create' };
  },

  touch: (a, stdin, e) => {
    if (!a.length) return { out: [], err: ['touch: 缺少文件操作数'] };
    for (const f of a) {
      if (!e.exists(f)) e.writeFile(f, '');
    }
    return { out: [], sfx: 'file-create' };
  },

  cp: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const paths = a.filter(x => !x.startsWith('-'));
    if (paths.length < 2) return { out: [], err: ['cp: 缺少操作数'] };
    const r = e.copy(paths[0], paths[1]);
    if (r.err) return { out: [], err: [r.err] };
    return { out: [], sfx: 'file-copy' };
  },

  mv: (a, stdin, e) => {
    const paths = a.filter(x => !x.startsWith('-'));
    if (paths.length < 2) return { out: [], err: ['mv: 缺少操作数'] };
    const r = e.move(paths[0], paths[1]);
    if (r.err) return { out: [], err: [r.err] };
    return { out: [], sfx: 'file-move' };
  },

  rm: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const paths = a.filter(x => !x.startsWith('-'));
    if (!paths.length) return { out: [], err: ['rm: 缺少操作数'] };
    for (const p of paths) {
      const r = e.remove(p, flags.includes('r') || flags.includes('R'));
      if (r.err) return { out: [], err: [r.err] };
    }
    return { out: [], sfx: 'file-delete' };
  },

  chmod: (a, stdin, e) => {
    if (a.length < 2) return { out: [], err: ['chmod: 缺少操作数'] };
    const r = e.chmod(a[1], a[0]);
    if (r.err) return { out: [], err: [r.err] };
    return { out: [], sfx: 'file-chmod' };
  },

  chown: (a, stdin, e) => {
    if (a.length < 2) return { out: [], err: ['chown: 缺少操作数'] };
    const [owner, group] = a[0].split(':');
    const r = e.chown(a[1], owner, group);
    if (r.err) return { out: [], err: [r.err] };
    return { out: [], sfx: 'file-chmod' };
  },

  ln: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const paths = a.filter(x => !x.startsWith('-'));
    if (paths.length < 2) return { out: [], err: ['ln: 缺少操作数'] };
    if (!flags.includes('s')) return { out: [], err: ['ln: 本模拟器仅支持符号链接 (ln -s)'] };
    const r = e.symlink(paths[0], paths[1]);
    if (r.err) return { out: [], err: [r.err] };
    return { out: [], sfx: 'file-create' };
  },

  /* ---- 文本处理 ---- */
  grep: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const rest = a.filter(x => !x.startsWith('-'));
    if (!rest.length) return { out: [], err: ['用法: grep [选项] 模式 [文件]'] };
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

    // -r 递归搜索目录，输出 路径:行
    if (flags.includes('r') && rest[1] && e.isDir(rest[1])) {
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
    const hits = lines.map((l, i) => [i + 1, l]).filter(([, l]) => test(l));
    if (flags.includes('c')) return { out: [String(hits.length)], mutated: false, sfx: 'text-grep' };
    if (flags.includes('l')) return { out: hits.length && srcName ? [srcName] : [], mutated: false, sfx: 'text-grep' };
    let out;
    if (flags.includes('o')) out = hits.flatMap(([, l]) => matchParts(l));
    else if (flags.includes('n') && srcName) out = hits.map(([no, l]) => `${no}:${l}`);
    else out = hits.map(([, l]) => l);
    return { out, mutated: false, sfx: 'text-grep' };
  },

  sed: (a, stdin, e) => {
    // 简化：sed 's/old/new/[g]' [file]
    const expr = a[0]?.replace(/^["']|["']$/g, '');
    if (!expr || !expr.startsWith('s/')) return { out: [], err: ['用法: sed \'s/旧/新/[g]\' [文件]'] };
    const parts = expr.split('/');
    if (parts.length < 3) return { out: [], err: [`sed: 无效表达式: ${expr}`] };
    const [, pat, rep, g] = parts;
    let re;
    try { re = new RegExp(pat, g === 'g' ? 'g' : ''); }
    catch { return { out: [], err: [`sed: 无效的正则: ${pat}`] }; }
    let lines;
    if (a[1]) {
      const r = e.readFile(a[1]);
      if (r.err) return { out: [], err: [r.err] };
      lines = r.content.split('\n');
    } else {
      lines = stdin.split('\n');
    }
    const out = lines.map(l => l.replace(re, rep));
    // sed -i 直接改文件
    if (a.includes('-i') && a[1]) {
      e.writeFile(a[1], out.join('\n') + '\n');
      return { out: [], sfx: 'file-write' };
    }
    return { out, mutated: false };
  },

  awk: (a, stdin, e) => {
    // 简化：awk '{print $1}' [file]  /  awk -F: '{print $2}' file
    let fieldSep = /\s+/;
    let prog = a[0];
    if (a[0] === '-F' || a[0]?.startsWith('-F')) {
      fieldSep = a[0] === '-F' ? new RegExp(escapeRe(a[1])) : new RegExp(escapeRe(a[0].slice(2)));
      prog = a[a[0] === '-F' ? 2 : 1];
    }
    const fileArg = a[a[0] === '-F' ? 3 : (a[0]?.startsWith('-F') ? 2 : 1)];
    if (!prog) return { out: [], err: ['用法: awk \'{print $1}\' [文件]'] };
    let lines;
    if (fileArg) {
      const r = e.readFile(fileArg);
      if (r.err) return { out: [], err: [r.err] };
      lines = r.content.split('\n').filter(l => l);
    } else {
      lines = stdin.split('\n').filter(l => l);
    }
    const pm = prog.replace(/^["'{]+|["'}]+$/g, '').match(/print\s+(.*)/);
    if (!pm) return { out: [], err: ['awk: 仅支持 {print $N} 形式'] };
    const out = lines.map(l => {
      const fields = l.split(fieldSep).filter(Boolean);
      return pm[1].replace(/\$(\d+)/g, (_, n) => fields[parseInt(n) - 1] || '');
    });
    return { out, mutated: false };
  },

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
    let lines = (args.find(x => !x.startsWith('-')) ? e.readFile(args.find(x => !x.startsWith('-')))?.content || '' : stdin).split('\n').filter(l => l || stdin);
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
        return c || tie(x, y);
      });
    }
    else if (flags.includes('n')) lines.sort((x, y) => parseFloat(x) - parseFloat(y));
    else if (flags.includes('f')) lines.sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
    else lines.sort();
    if (flags.includes('r')) lines.reverse();
    if (flags.includes('u')) lines = [...new Set(lines)];
    return { out: lines, mutated: false };
  },

  uniq: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const lines = stdin.split('\n');
    const out = [];
    let prev = null, count = 0;
    const flush = () => {
      if (prev === null) return;
      if (flags.includes('c')) out.push(`${String(count).padStart(4)} ${prev}`);
      else if (flags.includes('d')) { if (count > 1) out.push(prev); }
      else if (flags.includes('u')) { if (count === 1) out.push(prev); }
      else out.push(prev);
    };
    for (const l of lines) {
      if (l === prev) count++;
      else { flush(); prev = l; count = 1; }
    }
    flush();
    return { out: out.filter(l => l !== '' || lines.includes('')), mutated: false };
  },

  wc: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    let text;
    const file = a.find(x => !x.startsWith('-'));
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      text = r.content;
    } else text = stdin;
    const lines = text.split('\n').filter(l => l).length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    if (flags.includes('l')) return { out: [String(lines)], mutated: false };
    if (flags.includes('w')) return { out: [String(words)], mutated: false };
    if (flags.includes('c')) return { out: [String(byteLen(text))], mutated: false };
    if (flags.includes('m')) return { out: [String(chars)], mutated: false };
    return { out: [`  ${lines}  ${words} ${chars}${file ? ' ' + file : ''}`], mutated: false };
  },

  head: (a, stdin, e) => {
    let n = 10, bytes = null;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { n = parseInt(args[i + 1]) || 10; args.splice(i, 2); i--; }
      else if (/^-n\d+$/.test(args[i] || '')) { n = parseInt(args[i].slice(2)) || 10; args.splice(i, 1); i--; }
      else if (args[i] === '-c') { bytes = parseInt(args[i + 1]) || 0; args.splice(i, 2); i--; }
      else if (/^-c\d+$/.test(args[i] || '')) { bytes = parseInt(args[i].slice(2)) || 0; args.splice(i, 1); i--; }
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    if (bytes !== null) {
      const s = text.slice(0, bytes);
      return { out: s ? [s] : [], mutated: false };
    }
    return { out: text.split('\n').slice(0, n), mutated: false };
  },

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
      else if (arg === '-c') { bytes = parseInt(args[i + 1]) || 0; args.splice(i, 2); i--; }
      else if (/^-c\d+$/.test(arg)) { bytes = parseInt(arg.slice(2)) || 0; args.splice(i, 1); i--; }
      else if (arg === '-f') { args.splice(i, 1); i--; } // 模拟非阻塞：接受但不跟踪
    }
    const file = args.find(x => !x.startsWith('-'));
    let text = file ? (e.readFile(file)?.content || '') : stdin;
    if (bytes !== null) {
      const s = text.slice(Math.max(0, text.length - bytes));
      return { out: s ? [s] : [], mutated: false };
    }
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop(); // 末尾换行不算空行，与真实 tail 一致
    if (fromLine !== null) return { out: lines.slice(fromLine - 1), mutated: false };
    return { out: lines.slice(Math.max(0, lines.length - n)), mutated: false };
  },

  cut: (a, stdin, e) => {
    let delim = '\t', fields = null, chars = null;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d') { delim = args[i + 1]?.replace(/^["']|["']$/g, '') || '\t'; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-d')) { delim = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-f') { fields = args[i + 1]; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-f')) { fields = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-c') { chars = args[i + 1]; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-c')) { chars = args[i].slice(2); args.splice(i, 1); i--; }
    }
    if (!fields && !chars) return { out: [], err: ['用法: cut -d 分隔符 -f 列号 [文件]'] };
    const file = args.find(x => !x.startsWith('-'));
    let lines = file ? (e.readFile(file)?.content || '').split('\n').filter(l => l) : stdin.split('\n').filter(l => l);
    let out;
    if (chars) {
      const idx = chars.split(',').map(x => parseInt(x) - 1);
      out = lines.map(l => idx.map(c => l[c] || '').join(''));
    } else {
      const cols = fields.split(',').map(x => parseInt(x) - 1);
      out = lines.map(l => {
        const parts = l.split(delim);
        return cols.map(c => parts[c] || '').join(delim);
      });
    }
    return { out, mutated: false };
  },

  tr: (a, stdin, e) => {
    const del = a.includes('-d');
    const sets = a.filter(x => !x.startsWith('-'));
    if (!sets.length) return { out: [], err: ['用法: tr [-d] 字符集1 [字符集2]'] };
    let text = stdin;
    if (del) {
      const re = new RegExp('[' + escapeRe(sets[0].replace(/^["']|["']$/g, '')) + ']', 'g');
      text = text.replace(re, '');
    } else if (sets.length >= 2) {
      const from = sets[0].replace(/^["']|["']$/g, ''), to = sets[1].replace(/^["']|["']$/g, '');
      text = text.split('').map(c => { const i = from.indexOf(c); return i >= 0 ? (to[i] || to[to.length - 1] || '') : c; }).join('');
    }
    return { out: text.split('\n'), mutated: false };
  },

  /* ---- 进程管理 ---- */
  ps: (a, stdin, e) => {
    // 支持 ps aux / ps -aux 两种写法
    const flags = a.filter(x => x.startsWith('-') || /^[auxef]+$/.test(x)).join('').replace(/-/g, '');
    const header = 'PID TTY          TIME CMD';
    const lines = [header];
    for (const p of e.procs) {
      if (!flags.includes('a') && p.name !== 'bash' && p.name !== 'init') continue;
      const time = `00:00:${String(Math.floor(p.pid % 60)).padStart(2, '0')}`;
      lines.push(`${String(p.pid).padStart(5)} pts/0  ${time} ${p.cmd}`);
    }
    if (flags.includes('a') || flags.includes('x')) {
      // aux 格式
      if (flags.includes('u')) {
        lines.length = 0;
        lines.push('USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
        for (const p of e.procs) {
          lines.push(`${(p.name === 'init' || p.name === 'sshd' ? 'root' : 'user').padEnd(8)} ${String(p.pid).padStart(5)} ${p.cpu.padStart(4)} ${p.mem.padStart(4)}  22604  5892 pts/0    ${p.state}+   10:00   0:00 ${p.cmd}`);
        }
      }
    }
    return { out: lines, mutated: false };
  },

  kill: (a, stdin, e) => {
    const pids = a.filter(x => !x.startsWith('-'));
    if (!pids.length) return { out: [], err: ['用法: kill PID'] };
    for (const pidStr of pids) {
      const pid = parseInt(pidStr);
      if (isNaN(pid)) return { out: [], err: [`kill: ${pidStr}: 参数必须是进程 ID`] };
      if (pid === 1) return { out: [], err: ['kill: (1) - 操作不允许 (init)'] };
      if (!e.kill(pid)) return { out: [], err: [`kill: (${pid}) - 没有那个进程`] };
    }
    return { out: [], sfx: 'proc-kill' };
  },

  top: (a, stdin, e) => {
    const lines = [
      `top - 10:00:00 up 1 day,  3:42,  1 user,  load average: 0.08, 0.03, 0.01`,
      `Tasks: ${e.procs.length} total,   1 running, ${e.procs.length - 1} sleeping`,
      '',
      '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ];
    for (const p of e.procs) {
      lines.push(`${String(p.pid).padStart(5)} user      20   0   22604   5892   3456 ${p.state}   ${p.cpu}   ${p.mem}   0:00.0${p.pid % 10} ${p.name}`);
    }
    return { out: lines, mutated: false };
  },

  jobs: (a, stdin, e) => {
    if (!e.jobs.length) return { out: [], mutated: false };
    return { out: e.jobs.map(j => `[${j.jid}] ${j.state.padEnd(8)} ${j.cmd}`), mutated: false };
  },

  bg: (a, stdin, e) => {
    const j = e.jobs[e.jobs.length - 1];
    if (!j) return { out: [], err: ['bash: bg: 当前没有任务'] };
    j.state = 'Running';
    return { out: [`[${j.jid}]+ ${j.cmd} &`], sfx: 'proc-spawn' };
  },

  fg: (a, stdin, e) => {
    const j = e.jobs[e.jobs.length - 1];
    if (!j) return { out: [], err: ['bash: fg: 当前没有任务'] };
    e.jobs.pop();
    e.kill(j.pid);
    return { out: [j.cmd], sfx: 'proc-spawn' };
  },

  sleep: (a, stdin, e) => {
    const secs = parseInt(a[0]) || 1;
    const pid = e.spawn('sleep', `sleep ${secs}`, 'S');
    return { out: [], pid, sfx: 'proc-spawn' };
  },

  nohup: (a, stdin, e) => {
    if (!a.length) return { out: [], err: ['用法: nohup 命令 &'] };
    const pid = e.spawn(a[0], a.join(' '), 'S');
    print('nohup: 忽略输入并把输出追加到"nohup.out"', 'info');
    return { out: [], pid, sfx: 'proc-spawn' };
  },

  /* ---- 系统信息 ---- */
  whoami: (a, stdin, e) => ({ out: [e.env.USER], mutated: false }),
  hostname: (a, stdin, e) => ({ out: ['termquest'], mutated: false }),
  uname: (a, stdin, e) => ({ out: [a.includes('-a') ? 'Linux termquest 6.1.0-termquest #1 SMP x86_64 GNU/Linux' : 'Linux'], mutated: false }),
  date: (a, stdin, e) => ({ out: ['Fri Jul 25 10:00:00 CST 2026'], mutated: false }),
  env: (a, stdin, e) => ({ out: Object.entries(e.env).map(([k, v]) => `${k}=${v}`), mutated: false }),

  export: (a, stdin, e) => {
    for (const arg of a) {
      const eq = arg.indexOf('=');
      if (eq > 0) e.env[arg.slice(0, eq)] = arg.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
    return { out: [] };
  },

  history: (a, stdin, e) => ({ out: e.history.map((h, i) => `  ${String(i + 1).padStart(4)}  ${h}`), mutated: false }),

  man: (a, stdin, e) => ({ out: [`本模拟器不提供 man 手册，输入 help 查看命令速查`], mutated: false }),

  /* ---- 查询 / 路径 ---- */
  which: (a, stdin, e) => {
    // 真实 which：找到打印路径，找不到什么都不打印
    const SYS = ['sh', 'bash', 'dash', 'true', 'false', 'test', 'su', 'passwd', 'sudo', 'useradd',
      'systemctl', 'journalctl', 'crontab', 'tar', 'gzip', 'gunzip', 'df', 'du', 'free', 'uptime',
      'lsof', 'vmstat', 'dmesg', 'lsblk', 'mount', 'umount', 'ping', 'traceroute', 'dig', 'nslookup',
      'host', 'curl', 'wget', 'nc', 'ss', 'netstat', 'ip', 'ifconfig', 'ssh', 'scp', 'rsync',
      'ssh-keygen', 'docker', 'docker-compose', 'kubectl', 'sqlite3', 'redis-cli', 'vim', 'find',
      'xargs', 'tee', 'diff', 'paste', 'join', 'comm', 'column', 'seq', 'rev'];
    if (!a.length) return { out: [], err: ['用法: which 命令'] };
    const out = [];
    for (const c of a) {
      if (CMD[c] || SYS.includes(c)) out.push(`/usr/bin/${c}`);
    }
    return { out, mutated: false };
  },

  stat: (a, stdin, e) => {
    const file = a.find(x => !x.startsWith('-'));
    if (!file) return { out: [], err: ['用法: stat 文件'] };
    const node = e.getNode(e.resolvePath(file));
    if (!node) return { out: [], err: [`stat: 无法 stat '${file}': 没有那个文件或目录`] };
    const size = node.type === 'dir' ? 4096 : node.type === 'link' ? node.target.length : (node.content || '').length;
    const typeStr = node.type === 'dir' ? 'directory' : node.type === 'link' ? `symbolic link to ${node.target}` : 'regular file';
    const octal = node.mode.slice(1).match(/.{3}/g)
      .map(t => (t[0] !== '-' ? 4 : 0) + (t[1] !== '-' ? 2 : 0) + (t[2] !== '-' ? 1 : 0)).join('');
    const ino = 1000 + (mtimeOf(e.resolvePath(file)) % 9000);
    return {
      out: [
        `  File: ${file}`,
        `  Size: ${size}\t\tBlocks: ${Math.max(8, Math.ceil(size / 512) * 8)}\t IO Block: 4096   ${typeStr}`,
        `Device: 801h/2049d\tInode: ${ino}\t Links: 1`,
        `Access: (0${octal}/${node.mode})  Uid: ( 1000/   ${node.owner})   Gid: ( 1000/   ${node.group})`,
        `Access: 2026-07-25 10:00:00.000000000 +0800`,
        `Modify: 2026-07-25 10:00:00.000000000 +0800`,
        `Change: 2026-07-25 10:00:00.000000000 +0800`,
        ` Birth: -`,
      ], mutated: false
    };
  },

  basename: (a) => {
    if (!a.length) return { out: [], err: ['basename: 缺少操作数'] };
    let name = a[0].replace(/\/+$/, '').split('/').filter(Boolean).pop() || '/';
    if (a[1] && name.endsWith(a[1]) && name !== a[1]) name = name.slice(0, -a[1].length);
    return { out: [name], mutated: false };
  },

  dirname: (a) => {
    if (!a.length) return { out: [], err: ['dirname: 缺少操作数'] };
    const p = a[0].replace(/\/+$/, '');
    const i = p.lastIndexOf('/');
    if (i < 0) return { out: ['.'], mutated: false };
    if (i === 0) return { out: ['/'], mutated: false };
    return { out: [p.slice(0, i).replace(/\/+$/, '') || '/'], mutated: false };
  },

  alias: (a, stdin, e) => {
    if (!e.aliases) e.aliases = { ll: 'ls -l', la: 'ls -la', '..': 'cd ..', cls: 'clear' };
    if (!a.length) {
      return { out: Object.entries(e.aliases).map(([k, v]) => `alias ${k}='${v}'`), mutated: false };
    }
    for (const arg of a) {
      const eq = arg.indexOf('=');
      if (eq > 0) e.aliases[arg.slice(0, eq)] = arg.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
    return { out: [] };
  },

  file: (a, stdin, e) => {
    if (!a.length) return { out: [], err: ['用法: file 路径'] };
    const out = [];
    for (const p of a) {
      const node = e.follow(p);
      if (!node) { out.push(`${p}: cannot open (No such file or directory)`); continue; }
      if (node.type === 'dir') { out.push(`${p}: directory`); continue; }
      if (node.type === 'link') { out.push(`${p}: symbolic link to ${node.target}`); continue; }
      const c = node.content || '';
      if (!c) { out.push(`${p}: empty`); continue; }
      if (c.startsWith('#!')) { out.push(`${p}: a script text executable`); continue; }
      const t = c.trim();
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { JSON.parse(t); out.push(`${p}: JSON data`); continue; } catch { /* 不是 JSON，继续判断 */ }
      }
      out.push(/^[\x20-\x7E\n\r\t]*$/.test(c) ? `${p}: ASCII text` : `${p}: UTF-8 Unicode text`);
    }
    return { out, mutated: false };
  },
};

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 合成 mtime：按路径字符串做稳定哈希，供 ls -t 排序（无真实时间戳时的模拟序）
function mtimeOf(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 1000003; return h; }

// UTF-8 字节长度（wc -c）
function byteLen(s) {
  let b = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    b += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return b;
}

function showLinuxHelp() {
  ['── 文件与目录 ──',
    '  pwd · cd 目录 · ls [-l|-a|-h|-R|-t|-S|-1] [目录]',
    '  cat [-n] 文件 · mkdir [-p] 目录 · touch 文件',
    '  cp 源 目标 · mv 源 目标 · rm [-r] 目标',
    '  chmod 模式 文件 · chown 用户:组 文件 · ln -s 目标 链接',
    '  stat 文件 · file 路径 · which 命令 · basename 路径 · dirname 路径',
    '── 文本处理（支持管道 | 和重定向 > >>）──',
    '  echo "文本" · grep [-invE] [-r|-c|-l|-w|-o] 模式 [文件|目录]',
    '  sed \'s/旧/新/[g]\' [文件] · awk \'{print $1}\' [文件]',
    '  sort [-nru] [-k 列] [-t 分隔符] [-f] · uniq [-cdu] · wc [-lwcm]',
    '  head [-n N|-c N] · tail [-n N|-n +N|-c N|-f] · cut -d 分隔符 -f 列 / cut -c 1,3',
    '  tr [-d] 集1 集2 · alias [名称=\'命令\']',
    '── 进程 ──',
    '  ps [-aux] · top · kill PID · jobs · bg · fg',
    '  sleep 秒 & · nohup 命令 &',
    '── 系统 ──',
    '  whoami · hostname · uname [-a] · date · env · export K=V · history',
    '  clear 清屏',
  ].forEach(l => print(l, 'info'));
}
