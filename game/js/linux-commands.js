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
  try {
    return fn(args, stdin, e, stage) || { out: [] };
  } catch (err) {
    return { out: [], err: [`${cmd}: 内部错误: ${err && err.message ? err.message : err}`], sfx: 'err-syntax' };
  }
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
    const blocksOf = c => Math.ceil(sizeOf(c) / 512) || 0;
    const indicator = c => {
      if (c.type === 'dir') return '/';
      if (!flags.includes('F')) return '';
      if (c.type === 'link') return '@';
      if (c.type === 'file' && (c.mode || '').slice(1, 4).includes('x')) return '*';
      return '';
    };
    const fmtLong = entries => {
      const lines = [`total ${entries.length}`];
      for (const [name, child] of entries) {
        const size = sizeOf(child);
        const sizeStr = flags.includes('h') ? humanSize(size) : String(size);
        const arrow = child.type === 'link' ? ` -> ${child.target}` : '';
        const blk = flags.includes('s') ? String(blocksOf(child)).padStart(2) + ' ' : '';
        const ind = flags.includes('F') ? indicator(child) : '';
        lines.push(`${blk}${child.mode} 1 ${child.owner.padEnd(6)} ${child.group.padEnd(6)} ${sizeStr.padStart(5)} Jul 25 10:00 ${name}${ind}${arrow}`);
      }
      return lines;
    };
    const fmtShort = entries => entries.map(([n, c]) => {
      const blk = flags.includes('s') ? blocksOf(c) + ' ' : '';
      return blk + n + indicator(c);
    });

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
    const decorate = lines => {
      let ls = flags.includes('A') ? lines.map(l => l.replace(/\t/g, '^I') + '$') : lines;
      return flags.includes('n') ? ls.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`) : ls;
    };
    if (!files.length) return { out: decorate(stdin ? stdin.split('\n') : []), mutated: false };
    const out = [];
    for (const f of files) {
      const r = e.readFile(f);
      if (r.err) return { out: [], err: [r.err] };
      out.push(...r.content.replace(/\n$/, '').split('\n'));
    }
    return { out: decorate(out), mutated: false };
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
    const recursive = flags.includes('r') || flags.includes('R');
    const verbose = flags.includes('v');
    const out = [];
    // -i：交互式确认（本模拟器非交互，仅在目标已存在时给出覆盖提示）
    if (flags.includes('i') && e.exists(paths[1]) && !e.isDir(paths[1])) {
      out.push(`cp: 覆盖 '${paths[1]}' 吗？(y)：是`);
    }
    const r = recursive ? e.copyTree(paths[0], paths[1]) : e.copy(paths[0], paths[1]);
    if (r.err) return { out: [], err: [r.err] };
    if (verbose) out.push(`${paths[0]} -> ${paths[1]}`);
    return { out, sfx: 'file-copy' };
  },

  mv: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const paths = a.filter(x => !x.startsWith('-'));
    if (paths.length < 2) return { out: [], err: ['mv: 缺少操作数'] };
    const out = [];
    if (flags.includes('i') && e.exists(paths[1]) && !e.isDir(paths[1])) {
      out.push(`mv: 覆盖 '${paths[1]}' 吗？(y)：是`);
    }
    const r = e.move(paths[0], paths[1]);
    if (r.err) return { out: [], err: [r.err] };
    if (flags.includes('v')) out.push(`${paths[0]} -> ${paths[1]}`);
    return { out, sfx: 'file-move' };
  },

  rm: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const paths = a.filter(x => !x.startsWith('-'));
    if (!paths.length) return { out: [], err: ['rm: 缺少操作数'] };
    const force = flags.includes('f');
    const verbose = flags.includes('v');
    const out = [];
    for (const p of paths) {
      if (flags.includes('i') && !force) out.push(`rm: 删除 '${p}' 吗？(y)：是`);
      const r = e.remove(p, flags.includes('r') || flags.includes('R'));
      if (r.err) {
        if (force && /没有那个文件或目录/.test(r.err)) continue; // rm -f 忽略不存在的文件
        return { out: [], err: [r.err] };
      }
      if (verbose) out.push(`removed '${p}'`);
    }
    return { out, sfx: 'file-delete' };
  },

  chmod: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const rest = a.filter(x => !x.startsWith('-'));
    if (rest.length < 2) return { out: [], err: ['chmod: 缺少操作数'] };
    const mode = rest[0];
    const out = [];
    for (const path of rest.slice(1)) {
      const r = flags.includes('R') ? e.chmodR(path, mode) : e.chmod(path, mode);
      if (r.err) return { out: [], err: [r.err] };
      if (flags.includes('v')) {
        const node = e.getNode(e.resolvePath(path));
        out.push(`mode of '${path}' changed to ${node ? node.mode : mode}`);
      }
    }
    return { out, sfx: 'file-chmod' };
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
    if (flags.includes('f') && e.exists(paths[1])) e.remove(paths[1], true);
    const r = e.symlink(paths[0], paths[1]);
    if (r.err) return { out: [], err: [r.err] };
    const out = flags.includes('v') ? [`${paths[0]} -> ${paths[1]}`] : [];
    return { out, sfx: 'file-create' };
  },

  /* ---- 文本处理 ---- */
  grep: (a, stdin, e) => {
    // 提取上下文选项 -A/-B/-C（支持 -A 2 与 -A2 两种写法）
    let ctxA = 0, ctxB = 0;
    const args = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      let m;
      if (t === '-A' || t === '--after-context') { ctxA = parseInt(a[++i]) || 0; continue; }
      if (t === '-B' || t === '--before-context') { ctxB = parseInt(a[++i]) || 0; continue; }
      if (t === '-C' || t === '--context') { ctxA = ctxB = parseInt(a[++i]) || 0; continue; }
      if ((m = String(t).match(/^-A(\d+)$/))) { ctxA = parseInt(m[1]); continue; }
      if ((m = String(t).match(/^-B(\d+)$/))) { ctxB = parseInt(m[1]); continue; }
      if ((m = String(t).match(/^-C(\d+)$/))) { ctxA = ctxB = parseInt(m[1]); continue; }
      args.push(t);
    }
    const flags = args.filter(x => x.startsWith('-')).join('');
    const rest = args.filter(x => !x.startsWith('-'));
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
    // -A/-B/-C 上下文
    if ((ctxA || ctxB) && !flags.includes('o')) {
      const matchIdx = new Set(hits.map(([no]) => no - 1));
      const include = new Set();
      for (const idx of matchIdx) {
        for (let k = idx - ctxB; k <= idx + ctxA; k++) if (k >= 0 && k < lines.length) include.add(k);
      }
      const sorted = [...include].sort((x, y) => x - y);
      const ctxOut = [];
      let prev = -2;
      for (const idx of sorted) {
        if (idx - prev > 1) ctxOut.push('--');
        const sep = matchIdx.has(idx) ? ':' : '-';
        ctxOut.push(flags.includes('n') ? `${idx + 1}${sep}${lines[idx]}` : lines[idx]);
        prev = idx;
      }
      return { out: ctxOut, mutated: false, sfx: 'text-grep' };
    }
    let out;
    if (flags.includes('o')) out = hits.flatMap(([, l]) => matchParts(l));
    else if (flags.includes('n') && srcName) out = hits.map(([no, l]) => `${no}:${l}`);
    else out = hits.map(([, l]) => l);
    return { out, mutated: false, sfx: 'text-grep' };
  },

  sed: (a, stdin, e) => {
    // 支持 sed [-n|-i] [-e 's/.../.../[gp]']... [文件]
    const silent = a.includes('-n');
    const inPlace = a.includes('-i');
    const exprs = [];
    const positional = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-n' || t === '-i') continue;
      if (t === '-e') { exprs.push(String(a[++i] || '').replace(/^["']|["']$/g, '')); continue; }
      if (typeof t === 'string' && t.startsWith('-') && t.length > 1) continue; // 忽略未知选项
      positional.push(t);
    }
    if (!exprs.length && positional.length) exprs.push(String(positional.shift()).replace(/^["']|["']$/g, ''));
    const file = positional[0];
    if (!exprs.length || !exprs[0].startsWith('s/')) return { out: [], err: ['用法: sed [-n|-i] [-e] \'s/旧/新/[gp]\' [文件]'] };
    const scripts = [];
    for (const expr of exprs) {
      const parts = expr.split('/');
      if (!expr.startsWith('s/') || parts.length < 3) return { out: [], err: [`sed: 无效表达式: ${expr}`] };
      const pat = parts[1], rep = parts[2], fl = parts[3] || '';
      let re;
      try { re = new RegExp(pat, fl.includes('g') ? 'g' : ''); }
      catch { return { out: [], err: [`sed: 无效的正则: ${pat}`] }; }
      scripts.push({ re, rep, p: fl.includes('p') });
    }
    let lines;
    if (file) {
      const r = e.readFile(file);
      if (r.err) return { out: [], err: [r.err] };
      lines = r.content.split('\n');
    } else {
      lines = stdin.split('\n');
    }
    const transformed = lines.map(l => {
      let line = l, printed = false;
      for (const s of scripts) {
        const before = line;
        line = line.replace(s.re, s.rep);
        if (s.p && line !== before) printed = true;
      }
      return { line, printed };
    });
    const result = silent ? transformed.filter(t => t.printed).map(t => t.line) : transformed.map(t => t.line);
    // sed -i 直接改文件（split('\n') 产生的尾部空元素 join 后已还原换行，无需再补）
    if (inPlace && file) {
      e.writeFile(file, result.join('\n'));
      return { out: [], sfx: 'file-write' };
    }
    return { out: result, mutated: false };
  },

  awk: (a, stdin, e) => {
    // awk [-F 分隔符] [-v 名=值]... '程序' [文件]
    let fieldSep = null; // null = 默认空白分隔
    const vars = {};
    const positional = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-F') { fieldSep = String(a[++i] || ''); continue; }
      if (typeof t === 'string' && t.startsWith('-F') && t.length > 2) { fieldSep = t.slice(2); continue; }
      if (t === '-v') { const kv = String(a[++i] || ''); const eq = kv.indexOf('='); if (eq > 0) vars[kv.slice(0, eq)] = kv.slice(eq + 1); continue; }
      if (typeof t === 'string' && t.startsWith('-') && t.length > 1) continue; // 忽略未知选项
      positional.push(t);
    }
    const prog = positional.shift();
    if (!prog) return { out: [], err: ['用法: awk [-F 分隔符] [-v 名=值] \'程序\' [文件]'] };
    const fileArg = positional[0];
    let lines;
    if (fileArg) {
      const r = e.readFile(fileArg);
      if (r.err) return { out: [], err: [r.err] };
      lines = r.content.split('\n').filter(l => l.length);
    } else {
      lines = stdin.split('\n').filter(l => l.length);
    }
    const sep = fieldSep === null ? null : new RegExp(escapeRe(fieldSep));
    return { out: runAwk(String(prog).replace(/^["']|["']$/g, ''), lines, sep, vars), mutated: false };
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
    const ci = flags.includes('i');
    const keyOf = l => ci ? String(l).toLowerCase() : l;
    const lines = stdin.split('\n');
    const out = [];
    let prev = null, prevKey = null, count = 0;
    const flush = () => {
      if (prevKey === null) return;
      if (flags.includes('c')) out.push(`${String(count).padStart(4)} ${prev}`);
      else if (flags.includes('d')) { if (count > 1) out.push(prev); }
      else if (flags.includes('u')) { if (count === 1) out.push(prev); }
      else out.push(prev);
    };
    for (const l of lines) {
      const k = keyOf(l);
      if (prevKey !== null && k === prevKey) count++;
      else { flush(); prev = l; prevKey = k; count = 1; }
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
    let delim = '\t', fields = null, chars = null, complement = false;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--complement') { complement = true; args.splice(i, 1); i--; continue; }
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
      out = lines.map(l => {
        const arr = [...l];
        return complement ? arr.filter((_, i) => !idx.includes(i)).join('') : idx.map(c => arr[c] || '').join('');
      });
    } else {
      const cols = fields.split(',').map(x => parseInt(x) - 1);
      out = lines.map(l => {
        const parts = l.split(delim);
        return complement ? parts.filter((_, i) => !cols.includes(i)).join(delim) : cols.map(c => parts[c] || '').join(delim);
      });
    }
    return { out, mutated: false };
  },

  tr: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const del = flags.includes('d');
    const squeeze = flags.includes('s');
    const compl = flags.includes('c') || flags.includes('C');
    const sets = a.filter(x => !x.startsWith('-'));
    if (!sets.length) return { out: [], err: ['用法: tr [-d|-s|-c] 字符集1 [字符集2]'] };
    const strip = s => s.replace(/^["']|["']$/g, '');
    const set1 = strip(sets[0] || '');
    const set2 = strip(sets[1] || '');
    let text = stdin;
    if (del) {
      // -c 取补集：删除“不在 set1 中”的字符（保留换行以免合并输出行）
      if (compl) text = text.split('').filter(c => c === '\n' || set1.includes(c)).join('');
      else text = text.replace(new RegExp('[' + escapeRe(set1) + ']', 'g'), '');
    } else if (sets.length >= 2) {
      const to = set2;
      text = text.split('').map(c => {
        const inSet = set1.includes(c);
        if (compl) return inSet ? c : (to[to.length - 1] || '');
        const i = set1.indexOf(c);
        return i >= 0 ? (to[i] || to[to.length - 1] || '') : c;
      }).join('');
    }
    if (squeeze) {
      const sqSet = (!del && sets.length >= 2) ? set2 : set1;
      if (sqSet) text = text.replace(new RegExp('([' + escapeRe(sqSet) + '])\\1+', 'g'), '$1');
    }
    return { out: text.split('\n'), mutated: false };
  },

  /* ---- 进程管理 ---- */
  ps: (a, stdin, e) => {
    const joined = a.join(' ');
    const isEf = /(^|\s)-?ef(\s|$)/.test(joined);
    let pidFilter = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-p') pidFilter = a[i + 1];
      else if (/^-p\d+$/.test(a[i] || '')) pidFilter = a[i].slice(2);
    }
    const flags = a.filter(x => x.startsWith('-') || /^[auxef]+$/.test(x)).join('').replace(/-/g, '');
    const userOf = p => (p.name === 'init' || p.name === 'sshd') ? 'root' : (e.env.USER || 'user');
    const timeOf = p => `00:00:${String(Math.floor(p.pid % 60)).padStart(2, '0')}`;
    const procs = pidFilter ? e.procs.filter(p => String(p.pid) === String(pidFilter)) : e.procs;

    if (isEf) {
      const lines = ['UID          PID    PPID  C STIME TTY          TIME CMD'];
      for (const p of procs) lines.push(`${userOf(p).padEnd(8)} ${String(p.pid).padStart(6)} ${String(Math.max(1, p.pid - 1)).padStart(7)}  0 10:00 pts/0  ${timeOf(p)} ${p.cmd}`);
      return { out: lines, mutated: false };
    }
    if (flags.includes('u')) {
      const lines = ['USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND'];
      for (const p of procs) {
        lines.push(`${userOf(p).padEnd(8)} ${String(p.pid).padStart(5)} ${p.cpu.padStart(4)} ${p.mem.padStart(4)}  22604  5892 pts/0    ${p.state}+   10:00   0:00 ${p.cmd}`);
      }
      return { out: lines, mutated: false };
    }
    const lines = ['PID TTY          TIME CMD'];
    for (const p of procs) {
      if (!flags.includes('a') && p.name !== 'bash' && p.name !== 'init') continue;
      lines.push(`${String(p.pid).padStart(5)} pts/0  ${timeOf(p)} ${p.cmd}`);
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

  pgrep: (a, stdin, e) => {
    const listFull = a.includes('-l');
    const pattern = a.filter(x => !x.startsWith('-'))[0];
    if (!pattern) return { out: [], err: ['用法: pgrep [-l] 模式'] };
    const hits = e.findProc(pattern);
    if (!hits.length) return { out: [], mutated: false };
    return { out: hits.map(p => listFull ? `${p.pid} ${p.name}` : String(p.pid)), mutated: false };
  },

  pkill: (a, stdin, e) => {
    const pattern = a.filter(x => !x.startsWith('-'))[0];
    if (!pattern) return { out: [], err: ['用法: pkill 模式'] };
    const hits = e.findProc(pattern).filter(p => p.pid !== 1);
    if (!hits.length) return { out: [], mutated: false };
    for (const p of hits) e.kill(p.pid);
    return { out: [], sfx: 'proc-kill' };
  },

  nice: (a, stdin, e) => {
    const args = [...a];
    let pri = 10;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { pri = parseInt(args[i + 1]) || 10; args.splice(i, 2); i--; }
      else if (/^-n-?\d+$/.test(args[i] || '')) { pri = parseInt(args[i].slice(2)) || 10; args.splice(i, 1); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { pri = parseInt(args[i].slice(1)); args.splice(i, 1); i--; }
    }
    const rest = args.filter(x => !x.startsWith('-'));
    if (!rest.length) return { out: [], err: ['用法: nice [-n 优先级] 命令'] };
    const pid = e.spawn(rest[0], rest.join(' '), 'S');
    const proc = e.procs.find(p => p.pid === pid);
    if (proc) proc.nice = pri;
    return { out: [], pid, sfx: 'proc-spawn' };
  },

  renice: (a, stdin, e) => {
    const args = a.filter(x => x !== '-p');
    if (args.length < 2) return { out: [], err: ['用法: renice 优先级 PID'] };
    const pri = parseInt(args[0]);
    if (isNaN(pri)) return { out: [], err: ['renice: 无效优先级'] };
    const out = [];
    for (const pidStr of args.slice(1)) {
      const pid = parseInt(pidStr);
      const p = e.procs.find(x => x.pid === pid);
      if (!p) { out.push(`renice: 无法获取 pid ${pid} 的信息: 没有那个进程`); continue; }
      p.nice = pri;
      out.push(`${pid} (进程 ID) 旧优先级 0，新优先级 ${pri}`);
    }
    return { out, mutated: false };
  },

  disown: (a, stdin, e) => {
    if (!e.jobs.length) return { out: [], mutated: false };
    const tok = a.find(x => /^%?\d+$/.test(x));
    if (tok) {
      const jid = parseInt(tok.replace('%', ''));
      e.jobs = e.jobs.filter(j => j.jid !== jid);
    } else e.jobs.pop();
    return { out: [], mutated: false };
  },

  wait: (a, stdin, e) => {
    e.jobs = [];
    return { out: [], mutated: false };
  },

  time: (a, stdin, e) => {
    if (!a.length) return { out: [], err: ['用法: time 命令'] };
    const inner = runStage(a.join(' '), stdin, e, false);
    const out = [...(inner.out || [])];
    out.push('', 'real\t0m0.012s', 'user\t0m0.008s', 'sys\t0m0.004s');
    return { out, mutated: false };
  },

  timeout: (a, stdin, e) => {
    const rest = a.filter(x => !x.startsWith('-'));
    if (rest.length < 2) return { out: [], err: ['用法: timeout 秒数 命令'] };
    const inner = runStage(rest.slice(1).join(' '), stdin, e, false);
    return { out: inner.out || [], err: inner.err || [], mutated: false };
  },

  watch: (a, stdin, e) => {
    let interval = 2;
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { interval = parseFloat(args[i + 1]) || 2; args.splice(i, 2); i--; }
      else if (/^-n[\d.]+$/.test(args[i] || '')) { interval = parseFloat(args[i].slice(2)) || 2; args.splice(i, 1); i--; }
    }
    const rest = args.filter(x => !x.startsWith('-'));
    if (!rest.length) return { out: [], err: ['用法: watch [-n 秒] 命令'] };
    const inner = runStage(rest.join(' '), stdin, e, false);
    return { out: [`Every ${interval}.0s: ${rest.join(' ')}    Fri Jul 25 10:00:00 2026`, '', ...(inner.out || [])], mutated: false };
  },

  top: (a, stdin, e) => {
    const procs = e.procs;
    const lines = [
      `top - 10:00:00 up 1 day,  3:42,  1 user,  load average: 0.08, 0.03, 0.01`,
      `Tasks: ${procs.length} total,   1 running, ${procs.length - 1} sleeping`,
      `%Cpu(s):  2.3 us,  1.1 sy,  0.0 ni, 96.4 id,  0.0 wa,  0.0 hi,  0.2 si`,
      'MiB Mem :   3943.2 total,   1204.5 free,   1487.3 used,   1251.4 buff/cache',
      '',
      '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ];
    for (const p of procs) {
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
  uname: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    if (flags.includes('a')) return { out: ['Linux termquest 6.1.0-termquest #1 SMP x86_64 GNU/Linux'], mutated: false };
    if (flags.includes('r')) return { out: ['6.1.0-termquest'], mutated: false };
    if (flags.includes('m')) return { out: ['x86_64'], mutated: false };
    if (flags.includes('n')) return { out: ['termquest'], mutated: false };
    return { out: ['Linux'], mutated: false };
  },
  date: (a, stdin, e) => ({ out: ['Fri Jul 25 10:00:00 CST 2026'], mutated: false }),
  env: (a, stdin, e) => ({ out: Object.entries(e.env).map(([k, v]) => `${k}=${v}`), mutated: false }),
  printenv: (a, stdin, e) => {
    if (a.length) {
      const v = e.env[a[0]];
      return v === undefined ? { out: [], mutated: false } : { out: [v], mutated: false };
    }
    return { out: Object.entries(e.env).map(([k, v]) => `${k}=${v}`), mutated: false };
  },

  export: (a, stdin, e) => {
    for (const arg of a) {
      const eq = arg.indexOf('=');
      if (eq > 0) e.env[arg.slice(0, eq)] = arg.slice(eq + 1).replace(/^["']|["']$/g, '');
    }
    return { out: [] };
  },

  set: (a, stdin, e) => {
    const vars = Object.entries(e.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return { out: [...vars, 'SHELL=/bin/bash', "IFS=$' \\t\\n'"], mutated: false };
  },

  history: (a, stdin, e) => ({ out: e.history.map((h, i) => `  ${String(i + 1).padStart(4)}  ${h}`), mutated: false }),

  man: (a, stdin, e) => ({ out: [`本模拟器不提供 man 手册，输入 help 查看命令速查`], mutated: false }),

  free: (a, stdin, e) => {
    const { flags } = parseFlags(a);
    if (flags.includes('h')) {
      return {
        out: ['               total        used        free      shared  buff/cache   available',
          'Mem:           3.9Gi       1.4Gi       1.2Gi        34Mi       1.2Gi       2.2Gi',
          'Swap:          2.0Gi          0B       2.0Gi'], mutated: false
      };
    }
    return {
      out: ['               total        used        free      shared  buff/cache   available',
        'Mem:         4037892     1487312     1204528       34816     1346052     2269184',
        'Swap:        2097148           0     2097148'], mutated: false
    };
  },

  uptime: (a, stdin, e) => ({ out: [' 10:00:00 up 1 day,  3:42,  1 user,  load average: 0.08, 0.03, 0.01'], mutated: false }),

  nproc: (a, stdin, e) => ({ out: ['4'], mutated: false }),

  lscpu: (a, stdin, e) => ({
    out: ['Architecture:            x86_64',
      '  CPU op-mode(s):        32-bit, 64-bit',
      'CPU(s):                  4',
      '  On-line CPU(s) list:   0-3',
      'Vendor ID:               GenuineIntel',
      '  Model name:            Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz',
      '  Thread(s) per core:    2',
      '  Core(s) per socket:    2',
      '  Socket(s):             1',
      'CPU max MHz:             3400.0000'], mutated: false
  }),

  id: (a, stdin, e) => {
    const user = a.find(x => !x.startsWith('-')) || e.env.USER;
    const uid = user === 'root' ? 0 : 1000;
    return { out: [`uid=${uid}(${user}) gid=${uid}(${user}) groups=${uid}(${user}),27(sudo)`], mutated: false };
  },

  who: (a, stdin, e) => ({ out: [`${e.env.USER}   pts/0        2026-07-25 10:00 (10.0.0.5)`], mutated: false }),

  w: (a, stdin, e) => ({
    out: [' 10:00:00 up 1 day,  3:42,  1 user,  load average: 0.08, 0.03, 0.01',
      'USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT',
      `${e.env.USER}   pts/0    10.0.0.5         10:00    0.00s  0.02s  0.00s w`], mutated: false
  }),

  last: (a, stdin, e) => ({
    out: [`${e.env.USER}   pts/0        10.0.0.5       Fri Jul 25 10:00   still logged in`,
      `${e.env.USER}   pts/0        10.0.0.5       Thu Jul 24 09:12 - 18:40  (09:28)`,
      '',
      'wtmp begins Thu Jul 24 09:12:00 2026'], mutated: false
  }),

  tty: (a, stdin, e) => ({ out: ['/dev/pts/0'], mutated: false }),

  type: (a, stdin, e) => {
    if (!e.aliases) e.aliases = { ll: 'ls -l', la: 'ls -la', '..': 'cd ..', cls: 'clear' };
    const BUILTINS = ['cd', 'echo', 'export', 'alias', 'history', 'set', 'unset', 'read', 'exit', 'source', 'test', 'true', 'false', 'printf', 'eval', 'exec'];
    const out = [];
    for (const name of a) {
      if (e.aliases[name]) out.push(`${name} 是别名，对应 '${e.aliases[name]}'`);
      else if (CMD[name] && BUILTINS.includes(name)) out.push(`${name} 是 shell 内建命令`);
      else if (CMD[name]) out.push(`${name} 是 /usr/bin/${name}`);
      else out.push(`bash: type: ${name}: 未找到`);
    }
    return { out, mutated: false };
  },

  command: (a, stdin, e) => {
    const rest = a.filter(x => x !== '-v' && x !== '-p');
    if (!rest.length) return { out: [], err: ['用法: command 命令'] };
    return runStage(rest.join(' '), stdin, e, false);
  },

  unalias: (a, stdin, e) => {
    if (!e.aliases) e.aliases = {};
    if (a.includes('-a')) { e.aliases = {}; return { out: [] }; }
    for (const name of a) delete e.aliases[name];
    return { out: [] };
  },

  cal: (a, stdin, e) => {
    const nums = a.filter(x => /^\d+$/.test(x)).map(Number);
    let month = 7, year = 2026;
    if (nums.length === 1) { year = nums[0]; }
    else if (nums.length >= 2) { month = nums[0]; year = nums[1]; }
    return { out: renderCal(month, year), mutated: false };
  },

  clear: (a, stdin, e) => { clearTerm(); return { out: [] }; },

  true: (a, stdin, e) => ({ out: [], mutated: false }),
  false: (a, stdin, e) => ({ out: [], mutated: false }),

  test: (a, stdin, e) => testExpr(a, e),
  '[': (a, stdin, e) => testExpr(a.filter(x => x !== ']'), e),

  expr: (a, stdin, e) => {
    if (!a.length) return { out: [], err: ['用法: expr 表达式'] };
    const toks = a.map(x => x.replace(/^["']|["']$/g, ''));
    if (toks[0] === 'length') return { out: [String((toks[1] || '').length)], mutated: false };
    if (toks.length === 3 && /^[+\-*/%]$/.test(toks[1])) {
      const x = parseFloat(toks[0]), y = parseFloat(toks[2]);
      let r;
      if (toks[1] === '+') r = x + y;
      else if (toks[1] === '-') r = x - y;
      else if (toks[1] === '*') r = x * y;
      else if (toks[1] === '/') r = y === 0 ? NaN : Math.trunc(x / y);
      else r = y === 0 ? NaN : x % y;
      if (isNaN(r)) return { out: [], err: ['expr: 除数为零或非数值'] };
      return { out: [String(r)], mutated: false };
    }
    if (toks.length === 3 && /^(=|!=|<|>)$/.test(toks[1])) {
      const cmp = toks[0] === toks[2] ? 0 : toks[0] < toks[2] ? -1 : 1;
      let res = false;
      if (toks[1] === '=') res = cmp === 0;
      else if (toks[1] === '!=') res = cmp !== 0;
      else if (toks[1] === '<') res = cmp < 0;
      else if (toks[1] === '>') res = cmp > 0;
      return { out: [res ? '1' : '0'], mutated: false };
    }
    return { out: [toks.join(' ')], mutated: false };
  },

  bc: (a, stdin, e) => {
    const exprs = [];
    if (stdin && stdin.trim()) exprs.push(...stdin.split('\n').map(l => l.trim()).filter(Boolean));
    const inline = a.filter(x => !x.startsWith('-')).join(' ');
    if (inline) exprs.push(inline);
    const out = [];
    for (const ex of exprs) {
      if (/^(quit|exit)$/.test(ex)) break;
      try {
        const v = evalArith(ex);
        if (v === null || Number.isNaN(v) || !Number.isFinite(v)) { out.push('0'); continue; }
        out.push(Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(6))));
      } catch { out.push('0'); }
    }
    return { out, mutated: false };
  },

  seq: (a, stdin, e) => {
    let sep = '\n';
    const args = [...a];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-s') { sep = args[i + 1] || '\n'; args.splice(i, 2); i--; }
      else if (args[i]?.startsWith('-s') && args[i].length > 2) { sep = args[i].slice(2); args.splice(i, 1); i--; }
    }
    const nums = args.filter(x => !x.startsWith('-')).map(Number).filter(x => !isNaN(x));
    let first = 1, step = 1, last = 1;
    if (nums.length === 1) last = nums[0];
    else if (nums.length === 2) { first = nums[0]; last = nums[1]; }
    else if (nums.length >= 3) { first = nums[0]; step = nums[1]; last = nums[2]; }
    if (step === 0) return { out: [], err: ['seq: 步长不能为零'] };
    const out = [];
    if (step > 0) for (let i = first; i <= last && out.length < 100000; i += step) out.push(fmtNum(i));
    else for (let i = first; i >= last && out.length < 100000; i += step) out.push(fmtNum(i));
    return { out: sep === '\n' ? out : [out.join(sep)], mutated: false };
  },

  yes: (a, stdin, e) => {
    const msg = a.length ? a.join(' ') : 'y';
    return { out: Array(100).fill(msg), mutated: false };
  },

  dmesg: (a, stdin, e) => {
    const lines = [
      '[    0.000000] Linux version 6.1.0-termquest (builder@termquest) (gcc 12.2.0)',
      '[    0.000000] Command line: BOOT_IMAGE=/vmlinuz root=/dev/sda1 ro quiet',
      '[    0.234567] Memory: 4037892K/4194304K available',
      '[    0.345678] CPU: Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz',
      '[    1.023456] EXT4-fs (sda1): mounted filesystem with ordered data mode',
      '[    2.345678] systemd[1]: Detected virtualization qemu.',
      '[    3.456789] eth0: link up, 1000 Mbps, full-duplex',
    ];
    const lvl = a.find(x => x.startsWith('-l'));
    if (lvl) return { out: lines.slice(0, 3), mutated: false };
    return { out: lines, mutated: false };
  },

  /* ---- 查询 / 路径 ---- */
  which: (a, stdin, e) => {
    // 真实 which：找到打印路径，找不到什么都不打印
    const SYS = ['sh', 'bash', 'dash', 'su', 'passwd', 'sudo', 'useradd',
      'systemctl', 'journalctl', 'crontab', 'tar', 'gzip', 'gunzip', 'free', 'uptime',
      'lsof', 'vmstat', 'dmesg', 'lsblk', 'mount', 'umount', 'ping', 'traceroute', 'dig', 'nslookup',
      'host', 'curl', 'wget', 'nc', 'ss', 'netstat', 'ip', 'ifconfig', 'ssh', 'scp', 'rsync',
      'ssh-keygen', 'docker', 'docker-compose', 'kubectl', 'sqlite3', 'redis-cli', 'vim', 'find', 'xargs'];
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

  /* ---- 文件与目录（扩展） ---- */
  tree: (a, stdin, e) => {
    const path = a.filter(x => !x.startsWith('-'))[0] || e.cwd;
    if (!e.follow(path)) return { out: [], err: [`tree: ${path}: 没有那个文件或目录`] };
    const lines = [path === e.cwd ? '.' : path, ...e.treeLines(path)];
    let dirs = 0, files = 0;
    const count = abs => {
      const n = e.follow(abs);
      if (!n || n.type !== 'dir') return;
      for (const [name, c] of Object.entries(n.children)) {
        if (c.type === 'dir') { dirs++; count(abs.replace(/\/+$/, '') + '/' + name); }
        else files++;
      }
    };
    count(e.resolvePath(path));
    lines.push('', `${dirs} directories, ${files} files`);
    return { out: lines, mutated: false };
  },

  du: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const human = flags.includes('h');
    const summary = flags.includes('s');
    const target = a.filter(x => !x.startsWith('-'))[0] || '.';
    if (!e.follow(target)) return { out: [], err: [`du: 无法访问 '${target}': 没有那个文件或目录`] };
    const nodeSize = n => n.type === 'dir' ? 4096 : n.type === 'link' ? n.target.length : (n.content || '').length;
    const fmt = bytes => human
      ? (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'M' : bytes >= 1024 ? (bytes / 1024).toFixed(1) + 'K' : bytes + 'B')
      : String(Math.ceil(bytes / 1024) || 0);
    const rows = [];
    const walk = (abs, disp) => {
      const n = e.follow(abs);
      let total = nodeSize(n);
      if (n.type === 'dir') {
        for (const [name, c] of Object.entries(n.children)) {
          const childAbs = abs.replace(/\/+$/, '') + '/' + name;
          if (c.type === 'dir') total += walk(childAbs, disp === '.' ? './' + name : disp + '/' + name);
          else total += nodeSize(c);
        }
      }
      rows.push(`${fmt(total)}\t${disp}`);
      return total;
    };
    walk(e.resolvePath(target), target);
    const out = summary ? [rows[rows.length - 1]] : rows;
    return { out, mutated: false };
  },

  df: (a, stdin, e) => {
    const human = a.filter(x => x.startsWith('-')).join('').includes('h');
    const header = human ? 'Filesystem      Size  Used Avail Use% Mounted on'
      : 'Filesystem     1K-blocks     Used Available Use% Mounted on';
    const root = human ? '/dev/sda1        40G   12G   26G  32% /'
      : '/dev/sda1       41943040 12582912  27262976  32% /';
    const shm = human ? 'tmpfs           2.0G     0  2.0G   0% /dev/shm'
      : 'tmpfs           2097152        0   2097152   0% /dev/shm';
    return { out: [header, root, shm], mutated: false };
  },

  readlink: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const path = a.filter(x => !x.startsWith('-'))[0];
    if (!path) return { out: [], err: ['用法: readlink [-f] 链接'] };
    if (flags.includes('f') || flags.includes('e')) {
      let cur = e.resolvePath(path);
      let guard = 0;
      while (guard++ < 16) {
        const node = e.getNode(cur);
        if (!node) return { out: [], mutated: false };
        if (node.type !== 'link') break;
        cur = node.target.startsWith('/') ? e.resolvePath(node.target)
          : e.resolvePath(e.dirname(cur) + '/' + node.target);
      }
      return { out: [cur], mutated: false };
    }
    const node = e.getNode(e.resolvePath(path));
    if (!node || node.type !== 'link') return { out: [], mutated: false };
    return { out: [node.target], mutated: false };
  },

  realpath: (a, stdin, e) => {
    const path = a.filter(x => !x.startsWith('-'))[0];
    if (!path) return { out: [], err: ['用法: realpath 路径'] };
    if (!e.follow(path)) return { out: [], err: [`realpath: ${path}: 没有那个文件或目录`] };
    return { out: [e.resolvePath(path)], mutated: false };
  },

  mktemp: (a, stdin, e) => {
    const template = a.filter(x => !x.startsWith('-'))[0] || 'tmp.XXXXXXXXXX';
    const count = (e.listDir('/tmp') || []).length;
    const suffix = String(1000000 + count * 7919).slice(-10);
    const base = template.replace(/X+$/, suffix);
    const abs = template.includes('/') ? e.resolvePath(base) : '/tmp/' + base;
    e.writeFile(abs, '');
    return { out: [abs], sfx: 'file-create' };
  },

  install: (a, stdin, e) => {
    const args = [...a];
    let mode = null, mkDirFlag = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-m') { mode = args[i + 1]; args.splice(i, 2); i--; }
      else if (typeof args[i] === 'string' && args[i].startsWith('-m')) { mode = args[i].slice(2); args.splice(i, 1); i--; }
      else if (args[i] === '-d') { mkDirFlag = true; args.splice(i, 1); i--; }
      else if (typeof args[i] === 'string' && args[i].startsWith('-') && args[i].length > 1) { args.splice(i, 1); i--; }
    }
    if (mkDirFlag) {
      for (const d of args) {
        let cur = '';
        for (const seg of e.resolvePath(d).split('/').filter(Boolean)) { cur += '/' + seg; if (!e.exists(cur)) e.mkdir(cur); }
      }
      return { out: [], sfx: 'file-create' };
    }
    if (args.length < 2) return { out: [], err: ['用法: install [-m 模式] 源 目标'] };
    const r = e.copyTree(args[0], args[1]);
    if (r.err) return { out: [], err: [r.err] };
    if (mode) e.chmod(args[1], mode);
    return { out: [], sfx: 'file-copy' };
  },

  groups: (a, stdin, e) => {
    const who = a.filter(x => !x.startsWith('-'))[0];
    return { out: [who ? `${who} : ${who}` : (e.env.USER || 'user')], mutated: false };
  },

  shred: (a, stdin, e) => {
    const paths = a.filter(x => !x.startsWith('-'));
    if (!paths.length) return { out: [], err: ['用法: shred 文件'] };
    const out = [];
    for (const p of paths) {
      const r = e.readFile(p);
      if (r.err) return { out: [], err: [r.err] };
      e.writeFile(p, '\u0000'.repeat((r.content || '').length));
      out.push(`shred: ${p}: 已覆写（模拟）；为安全起见未真正删除，可用 rm 删除`);
    }
    return { out, sfx: 'file-write' };
  },

  /* ---- 文本处理（扩展） ---- */
  printf: (a, stdin, e) => {
    if (!a.length) return { out: [], err: ['用法: printf 格式 [参数]'] };
    const fmt = a[0].replace(/^["']|["']$/g, '');
    const args = a.slice(1).map(x => x.replace(/^["']|["']$/g, ''));
    const text = awkPrintf(fmt, args);
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return { out: lines, mutated: false };
  },

  paste: (a, stdin, e) => {
    const args = [...a];
    let delim = '\t';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-d') { delim = (args[i + 1] || '\t').replace(/^["']|["']$/g, ''); args.splice(i, 2); i--; }
      else if (typeof args[i] === 'string' && args[i].startsWith('-d')) { delim = args[i].slice(2) || '\t'; args.splice(i, 1); i--; }
      else if (typeof args[i] === 'string' && args[i].startsWith('-') && args[i].length > 1) { args.splice(i, 1); i--; }
    }
    const cols = [];
    if (!args.length) cols.push(stdin.split('\n'));
    else for (const f of args) {
      const r = e.readFile(f);
      if (r.err) return { out: [], err: [r.err] };
      cols.push(r.content.replace(/\n$/, '').split('\n'));
    }
    const rows = Math.max(0, ...cols.map(c => c.length));
    const out = [];
    for (let i = 0; i < rows; i++) out.push(cols.map(c => c[i] || '').join(delim));
    return { out, mutated: false };
  },

  join: (a, stdin, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: join 文件1 文件2'] };
    const read = f => { const r = e.readFile(f); return r.err ? null : r.content.replace(/\n$/, '').split('\n').filter(l => l); };
    const A = read(files[0]), B = read(files[1]);
    if (!A || !B) return { out: [], err: ['join: 无法读取输入文件'] };
    const mapB = {};
    for (const line of B) { const f = line.split(/\s+/); (mapB[f[0]] = mapB[f[0]] || []).push(f.slice(1).join(' ')); }
    const out = [];
    for (const line of A) {
      const f = line.split(/\s+/);
      if (mapB[f[0]]) for (const rest of mapB[f[0]]) out.push([f[0], f.slice(1).join(' '), rest].filter(Boolean).join(' '));
    }
    return { out, mutated: false };
  },

  comm: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: comm [-123] 文件1 文件2'] };
    const read = f => { const r = e.readFile(f); return r.err ? null : r.content.replace(/\n$/, '').split('\n').filter(l => l); };
    const A = read(files[0]), B = read(files[1]);
    if (!A || !B) return { out: [], err: ['comm: 无法读取输入文件'] };
    const setA = new Set(A), setB = new Set(B);
    const out = [];
    if (!flags.includes('1')) for (const l of A) if (!setB.has(l)) out.push(l);
    if (!flags.includes('2')) for (const l of B) if (!setA.has(l)) out.push('\t' + l);
    if (!flags.includes('3')) for (const l of A) if (setB.has(l)) out.push('\t\t' + l);
    return { out, mutated: false };
  },

  tee: (a, stdin, e) => {
    const append = a.includes('-a');
    const files = a.filter(x => !x.startsWith('-'));
    for (const f of files) {
      const content = stdin + (stdin ? '\n' : '');
      if (append) { const old = e.readFile(f); e.writeFile(f, (old.ok ? old.content : '') + content); }
      else e.writeFile(f, content);
    }
    return { out: stdin ? stdin.split('\n') : [], sfx: files.length ? 'file-write' : undefined };
  },

  column: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    let text = stdin;
    const file = a.filter(x => !x.startsWith('-'))[0];
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const lines = text.replace(/\n$/, '').split('\n').filter(l => l.length);
    if (!flags.includes('t')) return { out: lines, mutated: false };
    const rows = lines.map(l => l.split(/\s+/).filter(Boolean));
    const widths = [];
    for (const r of rows) r.forEach((c, i) => widths[i] = Math.max(widths[i] || 0, c.length));
    const out = rows.map(r => r.map((c, i) => i === r.length - 1 ? c : c.padEnd(widths[i])).join('  '));
    return { out, mutated: false };
  },

  rev: (a, stdin, e) => {
    let text = stdin;
    const file = a.filter(x => !x.startsWith('-'))[0];
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    return { out: text.replace(/\n$/, '').split('\n').map(l => [...l].reverse().join('')), mutated: false };
  },

  tac: (a, stdin, e) => {
    let text = stdin;
    const file = a.filter(x => !x.startsWith('-'))[0];
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    return { out: text.replace(/\n$/, '').split('\n').reverse(), mutated: false };
  },

  fold: (a, stdin, e) => {
    const args = [...a]; let width = 80;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-w') { width = parseInt(args[i + 1]) || 80; args.splice(i, 2); i--; }
      else if (/^-w\d+$/.test(args[i] || '')) { width = parseInt(args[i].slice(2)) || 80; args.splice(i, 1); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { width = parseInt(args[i].slice(1)) || 80; args.splice(i, 1); i--; }
    }
    let text = stdin;
    const file = args.find(x => !x.startsWith('-'));
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const out = [];
    for (const line of text.replace(/\n$/, '').split('\n')) {
      if (!line.length) { out.push(''); continue; }
      for (let i = 0; i < line.length; i += width) out.push(line.slice(i, i + width));
    }
    return { out, mutated: false };
  },

  fmt: (a, stdin, e) => {
    const args = [...a]; let width = 75;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-w') { width = parseInt(args[i + 1]) || 75; args.splice(i, 2); i--; }
      else if (/^-w?\d+$/.test(args[i] || '')) { width = parseInt(String(args[i]).replace(/\D/g, '')) || 75; args.splice(i, 1); i--; }
    }
    let text = stdin;
    const file = args.find(x => !x.startsWith('-'));
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const words = text.split(/\s+/).filter(Boolean);
    const out = []; let line = '';
    for (const word of words) {
      if ((line ? line + ' ' + word : word).length > width) { if (line) out.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) out.push(line);
    return { out, mutated: false };
  },

  expand: (a, stdin, e) => {
    const args = [...a]; let tab = 8;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') { tab = parseInt(args[i + 1]) || 8; args.splice(i, 2); i--; }
      else if (/^-t?\d+$/.test(args[i] || '')) { tab = parseInt(String(args[i]).replace(/\D/g, '')) || 8; args.splice(i, 1); i--; }
    }
    let text = stdin;
    const file = args.find(x => !x.startsWith('-'));
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const sp = ' '.repeat(tab);
    return { out: text.replace(/\n$/, '').split('\n').map(l => l.replace(/\t/g, sp)), mutated: false };
  },

  unexpand: (a, stdin, e) => {
    const args = [...a]; let tab = 8; const all = a.includes('-a');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') { tab = parseInt(args[i + 1]) || 8; args.splice(i, 2); i--; }
      else if (/^-\d+$/.test(args[i] || '')) { tab = parseInt(args[i].slice(1)) || 8; args.splice(i, 1); i--; }
    }
    let text = stdin;
    const file = args.find(x => !x.startsWith('-'));
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const sp = ' '.repeat(tab);
    const out = text.replace(/\n$/, '').split('\n').map(l => all
      ? l.split(sp).join('\t')
      : l.replace(new RegExp('^(?:' + sp + ')+'), m => '\t'.repeat(m.length / tab)));
    return { out, mutated: false };
  },

  nl: (a, stdin, e) => {
    let text = stdin;
    const file = a.filter(x => !x.startsWith('-'))[0];
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    let n = 0;
    const out = text.replace(/\n$/, '').split('\n').map(l => {
      if (!l) return l; // 默认空行不编号
      n++;
      return `${String(n).padStart(6)}\t${l}`;
    });
    return { out, mutated: false };
  },

  od: (a, stdin, e) => {
    let text = stdin;
    const file = a.filter(x => !x.startsWith('-'))[0];
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const bytes = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    const out = [];
    for (let i = 0; i < bytes.length; i += 16) {
      out.push(String(i).padStart(7, '0') + ' ' + bytes.slice(i, i + 16).map(b => b.toString(8).padStart(3, '0')).join(' '));
    }
    out.push(String(bytes.length).padStart(7, '0'));
    return { out, mutated: false };
  },

  strings: (a, stdin, e) => {
    const args = [...a]; let min = 4;
    const nArg = args.find(x => /^-\d+$/.test(x));
    if (nArg) min = parseInt(nArg.slice(1)) || 4;
    let text = stdin;
    const file = args.find(x => !x.startsWith('-'));
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const matches = text.match(new RegExp('[\\x20-\\x7E]{' + min + ',}', 'g')) || [];
    return { out: matches, mutated: false };
  },

  diff: (a, stdin, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: diff 文件1 文件2'] };
    const read = f => { const r = e.readFile(f); return r.err ? null : r.content.replace(/\n$/, '').split('\n'); };
    const A = read(files[0]), B = read(files[1]);
    if (!A || !B) return { out: [], err: ['diff: 无法读取输入文件'] };
    const ops = lcsDiff(A, B);
    if (ops.every(o => o[0] === '=')) return { out: [], mutated: false };
    const out = [];
    for (const [op, line] of ops) {
      if (op === '-') out.push(`< ${line}`);
      else if (op === '+') out.push(`> ${line}`);
    }
    return { out, mutated: false };
  },

  cmp: (a, stdin, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const files = a.filter(x => !x.startsWith('-'));
    if (files.length < 2) return { out: [], err: ['用法: cmp [-s] 文件1 文件2'] };
    const read = f => { const r = e.readFile(f); return r.err ? null : r.content; };
    const A = read(files[0]), B = read(files[1]);
    if (A === null || B === null) return { out: [], err: ['cmp: 无法读取输入文件'] };
    if (A === B) return { out: [], mutated: false };
    if (flags.includes('s')) return { out: [], mutated: false };
    let line = 1, pos = 0;
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) { if (A[i] === '\n') line++; if (A[i] !== B[i]) { pos = i + 1; break; } }
    if (!pos) pos = n + 1;
    const msg = (A.length !== B.length && !pos)
      ? `cmp: EOF on ${A.length < B.length ? files[0] : files[1]}`
      : `${files[0]} ${files[1]} differ: byte ${pos}, line ${line}`;
    return { out: [msg], mutated: false };
  },

  base64: (a, stdin, e) => {
    const decode = a.includes('-d') || a.includes('--decode');
    let text = stdin;
    const file = a.filter(x => !x.startsWith('-'))[0];
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    try {
      if (decode) return { out: b64Decode(text.trim()).split('\n'), mutated: false };
      const enc = b64Encode(text.replace(/\n$/, ''));
      return { out: enc.match(/.{1,76}/g) || [], mutated: false };
    } catch { return { out: [], err: ['base64: 无效输入'] }; }
  },

  md5sum: (a, stdin, e) => hashSum(a, stdin, e, 32, 'md5sum'),
  sha256sum: (a, stdin, e) => hashSum(a, stdin, e, 64, 'sha256sum'),

  shuf: (a, stdin, e) => {
    const args = [...a]; let headCount = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-n') { headCount = parseInt(args[i + 1]); args.splice(i, 2); i--; }
      else if (/^-n\d+$/.test(args[i] || '')) { headCount = parseInt(args[i].slice(2)); args.splice(i, 1); i--; }
    }
    let text = stdin;
    const file = args.find(x => !x.startsWith('-'));
    if (file) { const r = e.readFile(file); if (r.err) return { out: [], err: [r.err] }; text = r.content; }
    const lines = text.replace(/\n$/, '').split('\n');
    const shuffled = lines.map((l, i) => [mtimeOf(l + '#' + i), l]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    return { out: headCount !== null ? shuffled.slice(0, headCount) : shuffled, mutated: false };
  },

  factor: (a, stdin, e) => {
    const nums = a.filter(x => !x.startsWith('-'));
    const list = nums.length ? nums : (stdin.trim() ? stdin.trim().split(/\s+/) : []);
    if (!list.length) return { out: [], err: ['用法: factor 数字'] };
    const out = [];
    for (const tok of list) {
      const n = parseInt(tok);
      if (isNaN(n) || n < 0) { out.push(`factor: '${tok}' 不是一个有效的正整数`); continue; }
      const factors = [];
      let x = n;
      for (let d = 2; d * d <= x; d++) while (x % d === 0) { factors.push(d); x = Math.floor(x / d); }
      if (x > 1) factors.push(x);
      out.push(`${n}: ${factors.join(' ')}`);
    }
    return { out, mutated: false };
  },
};

/* ============ 辅助函数 ============ */
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
    '  pwd · cd 目录 · ls [-l|-a|-A|-h|-R|-t|-S|-1|-F|-s] [目录]',
    '  cat [-n|-A] 文件 · mkdir [-p] 目录 · touch 文件',
    '  cp [-r|-i|-v] 源 目标 · mv [-i|-v] 源 目标 · rm [-r|-i|-v] 目标',
    '  chmod [-R] 模式 文件 · chown 用户:组 文件 · ln [-s|-f|-v] 目标 链接',
    '  tree [目录] · du [-sh] [路径] · df [-h] · readlink 链接 · realpath 路径',
    '  mktemp · install 源 目标 · groups · shred 文件',
    '  stat 文件 · file 路径 · which 命令 · basename 路径 · dirname 路径',
    '── 文本处理（支持管道 | 和重定向 > >>）──',
    '  echo "文本" · printf 格式 [参数] · grep [-invE] [-r|-c|-l|-w|-o] [-A|-B|-C N] 模式 [文件]',
    '  sed [-n|-i|-e] \'s/旧/新/[g]\' [文件] · awk [-F 分隔符] [-v 名=值] \'条件{print}END{...}\' [文件]',
    '  sort [-nru] [-k 列] [-t 分隔符] [-f] · uniq [-cdui] · wc [-lwcm]',
    '  head [-n N|-c N] · tail [-n N|-n +N|-c N|-f] · cut -d 分隔符 -f 列 [--complement]',
    '  tr [-d|-s|-c] 集1 集2 · paste 文件... · join 文件1 文件2 · comm 文件1 文件2',
    '  tee [文件] · column [-t] · rev · tac · fold [-w N] · fmt · expand · unexpand',
    '  nl · od · strings · diff 文件1 文件2 · cmp 文件1 文件2 · shuf · factor N',
    '  base64 [-d] · md5sum 文件 · sha256sum 文件 · alias [名称=\'命令\']',
    '── 进程 ──',
    '  ps [aux|-ef|-p PID] · top · kill PID · pgrep 模式 · pkill 模式',
    '  jobs · bg · fg · disown · wait · nice · renice · time 命令 · timeout 秒 命令 · watch 命令',
    '  sleep 秒 & · nohup 命令 &',
    '── 系统 ──',
    '  whoami · hostname · uname [-a] · date · env · printenv · export K=V · set',
    '  free [-h] · uptime · nproc · lscpu · id · who · w · last · tty · dmesg',
    '  type 命令 · command 命令 · cal · clear 清屏 · true · false',
    '  test 表达式 / [ 表达式 ] · expr 表达式 · bc · seq [起] 止 [步] · yes [文本]',
    '  history · man · unalias 名称',
  ].forEach(l => print(l, 'info'));
}

/* ============ awk 迷你解释器 ============ */
function runAwk(prog, records, sep, initVars) {
  try {
    const out = [];
    const blocks = parseAwkProg(String(prog));
    const vars = Object.assign({ OFS: ' ' }, initVars || {});
    let NR = 0, lastFields = [''], lastNF = 0;
    for (const b of blocks) if (b.pattern === 'BEGIN') execAwkBlock(b.body, [''], 0, vars, 0, out);
    for (const line of records) {
      NR++;
      const fields = splitAwk(line, sep);
      const NF = fields.length - 1;
      lastFields = fields; lastNF = NF;
      for (const b of blocks) {
        if (b.pattern === 'BEGIN' || b.pattern === 'END') continue;
        if (awkCond(b.pattern, fields, NF, vars, NR)) execAwkBlock(b.body, fields, NF, vars, NR, out);
      }
    }
    for (const b of blocks) if (b.pattern === 'END') execAwkBlock(b.body, lastFields, lastNF, vars, NR, out);
    const lines = out.join('').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  } catch { return []; }
}

function parseAwkProg(prog) {
  const blocks = [];
  const n = prog.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s;]/.test(prog[i])) i++;
    if (i >= n) break;
    let pat = '';
    while (i < n && prog[i] !== '{') { pat += prog[i]; i++; }
    if (i >= n) break;
    i++; // 跳过 {
    let depth = 1, body = '';
    while (i < n && depth > 0) {
      const c = prog[i];
      if (c === '"' || c === "'") {
        const q = c; body += c; i++;
        while (i < n && prog[i] !== q) { body += prog[i]; i++; }
        if (i < n) { body += prog[i]; i++; }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
      body += c; i++;
    }
    blocks.push({ pattern: pat.trim(), body: body.trim() });
  }
  return blocks;
}

function splitAwk(line, sep) {
  let parts;
  if (sep === null) {
    const t = String(line).trim();
    parts = t === '' ? [] : t.split(/\s+/);
  } else {
    parts = String(line).split(sep);
  }
  return [String(line), ...parts]; // [0]=$0，[1..]=$1..
}

function awkCond(pat, fields, NF, vars, NR) {
  if (!pat) return true;
  const rx = pat.match(/^\/(.*)\/$/);
  if (rx) { try { return new RegExp(rx[1]).test(fields[0] || ''); } catch { return false; } }
  const cmp = pat.match(/^(.*?)\s*(>=|<=|==|!=|=|>|<)\s*(.*)$/);
  if (cmp && cmp[1] !== '') {
    return cmpOp(awkVal(cmp[1], fields, NF, vars, NR), awkVal(cmp[3], fields, NF, vars, NR), cmp[2]);
  }
  const v = awkVal(pat, fields, NF, vars, NR);
  return v !== '' && v !== 0 && v !== '0';
}

function cmpOp(l, r, op) {
  if (op === '=') op = '==';
  const isNum = v => typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v).trim());
  if (isNum(l) && isNum(r)) {
    const a = parseFloat(l), b = parseFloat(r);
    if (op === '>') return a > b; if (op === '<') return a < b;
    if (op === '>=') return a >= b; if (op === '<=') return a <= b;
    if (op === '==') return a === b; if (op === '!=') return a !== b;
  }
  const a = String(l), b = String(r);
  if (op === '>') return a > b; if (op === '<') return a < b;
  if (op === '>=') return a >= b; if (op === '<=') return a <= b;
  if (op === '==') return a === b; if (op === '!=') return a !== b;
  return false;
}

function awkVal(expr, fields, NF, vars, NR) {
  expr = String(expr).trim();
  if (expr === '') return '';
  if (/^".*"$/.test(expr) || /^'.*'$/.test(expr)) return expr.slice(1, -1);
  if (/^\$\d+$/.test(expr)) { const idx = parseInt(expr.slice(1), 10); return idx === 0 ? (fields[0] || '') : (fields[idx] !== undefined ? fields[idx] : ''); }
  if (expr === 'NR') return NR;
  if (expr === 'NF') return NF;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return parseFloat(expr);
  if (/^[A-Za-z_]\w*$/.test(expr)) return vars[expr] !== undefined ? vars[expr] : '';
  const ar = evalArith(expr, fields, NF, vars, NR);
  if (ar !== undefined && !isNaN(ar)) return ar;
  return expr;
}

function execAwkBlock(body, fields, NF, vars, NR, out) {
  for (const stmt of splitAwkStmts(body)) execAwkStmt(stmt, fields, NF, vars, NR, out);
}

function splitAwkStmts(body) {
  const stmts = []; let cur = '', q = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ';' || c === '\n') { if (cur.trim()) stmts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) stmts.push(cur.trim());
  return stmts;
}

function execAwkStmt(stmt, fields, NF, vars, NR, out) {
  stmt = stmt.trim();
  if (!stmt) return;
  let m;
  if ((m = stmt.match(/^printf\s+(.*)$/))) {
    const parts = splitTopComma(m[1]);
    const fmt = awkVal(parts[0], fields, NF, vars, NR);
    const args = parts.slice(1).map(p => awkVal(p, fields, NF, vars, NR));
    out.push(awkPrintf(String(fmt), args));
    return;
  }
  if (stmt === 'print') { out.push((fields[0] || '') + '\n'); return; }
  if ((m = stmt.match(/^print\s+(.*)$/))) {
    const parts = splitTopComma(m[1]).map(p => { const v = awkEvalConcat(p, fields, NF, vars, NR); return typeof v === 'number' ? fmtNum(v) : String(v); });
    out.push(parts.join(vars.OFS || ' ') + '\n');
    return;
  }
  if ((m = stmt.match(/^([A-Za-z_]\w*)\s*=\s*(.*)$/)) && !/^[=<>!]/.test(m[2])) {
    vars[m[1]] = awkEvalConcat(m[2], fields, NF, vars, NR);
    return;
  }
  // 其它语句（裸表达式等）忽略，不报错
}

function awkEvalConcat(expr, fields, NF, vars, NR) {
  expr = String(expr).trim();
  const noStr = expr.replace(/"[^"]*"|'[^']*'/g, '""');
  if (/[+\-*\/%]/.test(noStr)) {
    const ar = evalArith(expr, fields, NF, vars, NR);
    if (ar !== undefined && !isNaN(ar)) return fmtNum(ar);
  }
  const tokens = splitTopSpace(expr);
  if (tokens.length <= 1) return awkVal(expr, fields, NF, vars, NR);
  return tokens.map(t => { const v = awkVal(t, fields, NF, vars, NR); return typeof v === 'number' ? fmtNum(v) : String(v); }).join('');
}

function splitTopComma(s) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function splitTopSpace(s) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function evalArith(expr, fields, NF, vars, NR) {
  const s = String(expr).replace(/\s+/g, '');
  if (!s) return undefined;
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  function factor() {
    const c = s[i];
    if (c === '(') { i++; const v = expr_(); if (s[i] === ')') i++; return v; }
    if (c === '$') { i++; let d = ''; while (isDigit(s[i])) d += s[i++]; const idx = parseInt(d || '0', 10); const v = idx === 0 ? fields[0] : fields[idx]; return parseFloat(v) || 0; }
    if (c === '-') { i++; return -factor(); }
    if (c === '+') { i++; return factor(); }
    if (/[A-Za-z_]/.test(c || '')) { let id = ''; while (/[A-Za-z_0-9]/.test(s[i] || '')) id += s[i++]; if (id === 'NR') return NR; if (id === 'NF') return NF; return parseFloat(vars[id]) || 0; }
    let d = ''; while (isDigit(s[i]) || s[i] === '.') d += s[i++]; return d === '' ? NaN : parseFloat(d);
  }
  function term() { let v = factor(); while (s[i] === '*' || s[i] === '/' || s[i] === '%') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : op === '/' ? v / r : v % r; } return v; }
  function expr_() { let v = term(); while (s[i] === '+' || s[i] === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; }
  const result = expr_();
  if (i < s.length) return undefined;
  return result;
}

function fmtNum(v) {
  if (typeof v !== 'number' || isNaN(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(parseFloat(v.toPrecision(6)));
}

function awkPrintf(fmt, args) {
  const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', '0': '\0' };
  let f = String(fmt).replace(/\\(.)/g, (_, c) => esc[c] !== undefined ? esc[c] : c);
  let ai = 0, out = '', last = 0, m;
  const re = /%([-+ 0]*)(\d+)?(?:\.(\d+))?([sdfixXoceEgG%])/g;
  while ((m = re.exec(f))) {
    out += f.slice(last, m.index);
    last = re.lastIndex;
    if (m[4] === '%') { out += '%'; continue; }
    const val = args[ai++] !== undefined ? args[ai - 1] : '';
    const flags = m[1] || '', width = m[2] ? parseInt(m[2], 10) : 0, prec = m[3] !== undefined ? parseInt(m[3], 10) : null;
    const spec = m[4];
    let str;
    if (spec === 's') { str = String(val); if (prec !== null) str = str.slice(0, prec); }
    else if (spec === 'd' || spec === 'i') { str = String(parseInt(parseFloat(val), 10) || 0); }
    else if (spec === 'f' || spec === 'e' || spec === 'E' || spec === 'g' || spec === 'G') { const num = parseFloat(val) || 0; str = prec !== null ? num.toFixed(prec) : num.toFixed(6); }
    else if (spec === 'x') { str = (parseInt(parseFloat(val), 10) || 0).toString(16); }
    else if (spec === 'X') { str = (parseInt(parseFloat(val), 10) || 0).toString(16).toUpperCase(); }
    else if (spec === 'o') { str = (parseInt(parseFloat(val), 10) || 0).toString(8); }
    else if (spec === 'c') { str = typeof val === 'number' ? String.fromCharCode(val) : String(val).charAt(0); }
    else str = String(val);
    if (width && str.length < width) {
      const pad = flags.includes('0') && !flags.includes('-') ? '0' : ' ';
      str = flags.includes('-') ? str.padEnd(width, ' ') : str.padStart(width, pad);
    }
    out += str;
  }
  out += f.slice(last);
  return out;
}

/* ============ 哈希 / diff / base64 ============ */
function fakeHash(str, len) {
  const s = String(str);
  let out = '';
  let seed = 2166136261 >>> 0;
  while (out.length < len) {
    let h = (seed ^ 0x9e3779b9) >>> 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h ^ s.charCodeAt(i), 16777619)) >>> 0;
    out += h.toString(16).padStart(8, '0');
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  }
  return out.slice(0, len);
}

function hashSum(a, stdin, e, len, name) {
  const files = a.filter(x => !x.startsWith('-'));
  if (!files.length) return { out: [`${fakeHash(stdin, len)}  -`], mutated: false };
  const out = [];
  for (const f of files) {
    const r = e.readFile(f);
    if (r.err) return { out: [], err: [`${name}: ${f}: 没有那个文件或目录`] };
    out.push(`${fakeHash(r.content, len)}  ${f}`);
  }
  return { out, mutated: false };
}

function lcsDiff(A, B) {
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push(['=', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', A[i]]); i++; }
    else { ops.push(['+', B[j]]); j++; }
  }
  while (i < n) ops.push(['-', A[i++]]);
  while (j < m) ops.push(['+', B[j++]]);
  return ops;
}

function b64Encode(str) {
  const bytes = [];
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : chars[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return out;
}

function b64Decode(str) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const s = String(str).replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < s.length; i += 4) {
    const c0 = chars.indexOf(s[i]), c1 = chars.indexOf(s[i + 1]), c2 = chars.indexOf(s[i + 2]), c3 = chars.indexOf(s[i + 3]);
    if (c0 < 0 || c1 < 0) break;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (c3 >= 0) bytes.push(((c2 & 3) << 6) | c3);
  }
  let out = '', i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i++; }
    else if (b < 0xe0) { out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
    else if (b < 0xf0) { out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
    else { out += String.fromCodePoint(((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)); i += 4; }
  }
  return out;
}
