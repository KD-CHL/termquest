// 命令解析与执行 —— 模拟 shell + 迷你 git 子命令
// 所有会改变状态的命令在执行后调用 app.afterCommand(shouldCheck)：
//   shouldCheck=true  → 重新渲染并检查是否过关
//   shouldCheck=false → 只重新渲染（如 merge --abort / 冲突发生）
// 这样 commands 不需要知道 ui / checkLevel 的存在，避免循环依赖。
import { G, app } from './state.js';
import { print, printCmd, clearTerm } from './terminal.js';
import { sfxClick, sfxOk, sfxErr, sfx } from './effects.js';
import { updateCmdCount } from './render.js';

export function tokenize(s) {
  const tk = []; let c = '', q = null, esc = false;
  for (const ch of s) {
    if (esc) { c += ch; esc = false; }
    else if (ch === '\\' && q !== "'") esc = true;
    else if (q) { if (ch === q) q = null; else c += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ' ' || ch === '\t') { if (c) { tk.push(c); c = ''; } }
    else c += ch;
  }
  if (c) tk.push(c);
  return tk;
}

function after(mutated) {
  if (app.afterCommand) app.afterCommand(mutated);
}

// 记录命令使用频次（用于个人统计）
function track(name) {
  app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1;
}

// ── 共享工具 ──
// 解析 --key=value / --key value / -X value 形式的选项
function parseKV(rest, names) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    for (const n of names) {
      if (a === n) { out[n] = rest[i + 1] || ''; i++; break; }
      else if (a.startsWith(n + '=')) { out[n] = a.slice(n.length + 1); break; }
    }
  }
  return out;
}

// 提交相对第一父提交改动的文件列表
function commitChangedFiles(c) {
  const pt = c.parents[0] && G.commits[c.parents[0]] ? G.commits[c.parents[0]].tree : {};
  const names = new Set([...Object.keys(pt), ...Object.keys(c.tree)]);
  const out = [];
  for (const f of names) if (pt[f] !== c.tree[f]) out.push(f);
  return out;
}

// 由提交序号生成确定性伪日期（仅用于展示）
function commitDate(c) {
  const n = parseInt(c.id, 16) || 0;
  const day = 1 + (n % 27), mon = 1 + (n % 12);
  return `2024-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// 累计一段补丁的增删行数
function diffStatLines(pairs) {
  const rows = []; let ta = 0, td = 0;
  for (const { f, oldC, newC } of pairs) {
    const a = oldC === undefined ? [] : String(oldC).replace(/\n$/, '').split('\n');
    const b = newC === undefined ? [] : String(newC).replace(/\n$/, '').split('\n');
    let add = 0, del = 0; const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) if (a[i] !== b[i]) { if (i < b.length) add++; if (i < a.length) del++; }
    rows.push(` ${f} | +${add} -${del}`); ta += add; td += del;
  }
  rows.push(` ${pairs.length} file${pairs.length === 1 ? '' : 's'} changed, ${ta} insertion${ta === 1 ? '' : 's'}(+), ${td} deletion${td === 1 ? '' : 's'}(-)`);
  return rows;
}

// 统一 diff 输出：支持 --name-only / --name-status / --stat / -w / --word-diff
function printDiffWith(pairs, opts) {
  if (!pairs.length) { print('(无差异)', 'out'); return; }
  if (opts.nameOnly) { for (const p of pairs) print(p.f, 'out'); return; }
  if (opts.nameStatus) { for (const p of pairs) print(`${p.oldC === undefined ? 'A' : p.newC === undefined ? 'D' : 'M'}\t${p.f}`, 'out'); return; }
  if (opts.stat) { diffStatLines(pairs).forEach(l => print(l, 'dim')); return; }
  for (const { f, oldC, newC } of pairs) {
    print(`diff --git a/${f} b/${f}`, 'info'); print(`--- a/${f}`, 'out'); print(`+++ b/${f}`, 'out');
    if (opts.wordDiff && oldC !== undefined && newC !== undefined) {
      const ow = String(oldC).split(/\s+/).filter(Boolean), nw = String(newC).split(/\s+/).filter(Boolean);
      let line = '';
      for (const w of ow) if (!nw.includes(w)) line += `[-${w}-] `;
      for (const w of nw) if (!ow.includes(w)) line += `{+${w}+} `;
      print(line.trim() || '(仅空白差异)', 'warn');
      continue;
    }
    if (oldC !== undefined) print(`- ${String(oldC).trim()}`, 'err');
    if (newC !== undefined) print(`+ ${String(newC).trim()}`, 'ok');
  }
}

// 分支 b 的历史是否包含提交 id（沿第一父提交回溯）
function branchContains(b, id) {
  let c = G.branches[b];
  while (c) { if (c === id) return true; const n = G.commits[c]; c = n ? n.parents[0] : null; }
  return false;
}

export function execute(input) {
  input = input.trim(); if (!input) return;
  printCmd(input);
  if (!app.inScript && !['help', 'clear', 'ls'].includes(input.split(' ')[0]) && !input.startsWith('cat ')) app.cmdCount++;
  updateCmdCount();

  const em = input.match(/^echo\s+(.*?)(>>|>)\s*(\S+)\s*$/);
  if (em) {
    let content = em[1].trim().replace(/^["']|["']$/g, '').replace(/\\(["\\])/g, '$1');
    const append = em[2] === '>>', f = em[3];
    G.files[f] = append ? (G.files[f] || '') + content + '\n' : content + '\n';
    track('echo');
    print(`已${append ? '追加到' : '写入'} ${f}`, 'out'); sfx('file-write'); after(true); return;
  }

  const t = tokenize(input), cmd = t[0];
  if (cmd === 'help') { showHelp(); return; }
  if (cmd === 'ls') { G.used.add('ls'); const n = Object.keys(G.files); print(n.length ? n.join('  ') : '(空)', 'out'); after(true); return; }
  if (cmd === 'cat') {
    if (!t[1]) return print('用法: cat <文件>', 'err');
    if (G.files[t[1]] === undefined) return print(`cat: ${t[1]}: 不存在`, 'err');
    print(G.files[t[1]].replace(/\n$/, ''), 'out'); after(true); return;
  }
  if (cmd === 'clear') { clearTerm(); return; }
  if (cmd === 'rm') { if (t[1]) { delete G.files[t[1]]; delete G.index[t[1]]; print(`已删除 ${t[1]}`, 'out'); sfx('file-delete'); after(true); } return; }
  if (cmd !== 'git') { sfx('err-syntax'); return print(`未识别: ${cmd}（输入 help 查看命令）`, 'err'); }

  const sub = t[1]; G.used.add(sub); const rest = t.slice(2);
  const fn = {
    status: cmdStatus, add: cmdAdd, commit: cmdCommit, log: cmdLog, diff: cmdDiff, branch: cmdBranch,
    switch: cmdSwitch, checkout: cmdCheckout, merge: cmdMerge, reset: cmdReset, restore: cmdRestore,
    stash: cmdStash, tag: cmdTag, show: cmdShow, 'cherry-pick': cmdCherryPick, rebase: cmdRebase,
    revert: cmdRevert, reflog: cmdReflog, clean: cmdClean, config: cmdConfig,
    remote: cmdRemote, clone: cmdClone, push: cmdPush, pull: cmdPull, fetch: cmdFetch,
    init: cmdInit, worktree: cmdWorktree, bisect: cmdBisect, grep: cmdGrep, shortlog: cmdShortlog,
    describe: cmdDescribe, archive: cmdArchive, 'rev-parse': cmdRevParse, 'ls-files': cmdLsFiles,
    'show-ref': cmdShowRef, 'format-patch': cmdFormatPatch, am: cmdAm, mv: cmdMv, rm: cmdRm
  }[sub];
  if (!fn) { sfx('err-syntax'); return print(`git: '${sub || ''}' 不是 git 命令。输入 help 查看支持的命令。`, 'err'); }
  track('git ' + sub);
  try {
    fn(rest);
  } catch (e) {
    print(`fatal: git ${sub} 执行出错（参数可能不完整）`, 'err');
  }
  after(true);
}

function cmdStatus() {
  const ht = G.headTree();
  print(G.headBranch ? `On branch ${G.headBranch}` : `HEAD detached at ${String(G.headCommit).slice(0, 7)}`, 'out');
  if (G.mergeInProgress) print('You have unmerged paths.\n  (fix conflicts and run "git commit")', 'err');
  const sN = [], sM = [], mod = [], unt = [];
  for (const f in G.index) { if (ht[f] === undefined) sN.push(f); else if (G.index[f] !== ht[f]) sM.push(f); }
  for (const f in G.files) {
    if (G.index[f] !== undefined) { if (G.files[f] !== G.index[f]) mod.push(f); }
    else if (ht[f] !== undefined) { if (G.files[f] !== ht[f]) mod.push(f); }
    else unt.push(f);
  }
  if (!sN.length && !sM.length && !mod.length && !unt.length && !G.mergeInProgress) return print('nothing to commit, working tree clean', 'ok');
  if (sN.length || sM.length) {
    print('\nChanges to be committed:', 'ok');
    sN.forEach(f => print(`  new file:   ${f}`, 'ok')); sM.forEach(f => print(`  modified:   ${f}`, 'ok'));
  }
  if (mod.length) { print('\nChanges not staged for commit:', 'warn'); mod.forEach(f => print(`  modified:   ${f}`, 'warn')); }
  if (unt.length) { print('\nUntracked files:', 'err'); unt.forEach(f => print(`  ${f}`, 'err')); }
}

function cmdAdd(rest) {
  if (!rest.length) return print('用法: git add <文件> 或 git add . [-A|-u|-p|--dry-run]', 'err');
  const dry = rest.includes('--dry-run') || rest.includes('-n');
  const patch = rest.includes('-p') || rest.includes('--patch');
  const update = rest.includes('-u') || rest.includes('--update');
  const all = rest.includes('-A') || rest.includes('--all');
  const ht = G.headTree();
  let targets;
  if (update) targets = Object.keys(G.files).filter(f => G.index[f] !== undefined || ht[f] !== undefined);
  else if (all || rest[0] === '.') targets = Object.keys(G.files);
  else targets = rest.filter(a => !a.startsWith('-'));
  if (!targets.length) return print('用法: git add <文件> 或 git add . [-A|-u|-p|--dry-run]', 'err');
  if (dry) {
    let n = 0;
    for (const f of targets) if (G.files[f] !== undefined && G.index[f] !== G.files[f]) { print(`add '${f}'`, 'out'); n++; }
    return print(n ? `(dry run) 将暂存 ${n} 个文件` : '(dry run) 没有需要暂存的改动', 'out');
  }
  if (patch) print('交互式暂存（模拟）：已自动暂存所选文件的全部改动', 'dim');
  let n = 0;
  for (const f of targets) {
    if (G.files[f] !== undefined) {
      G.index[f] = G.files[f]; n++;
      if (G.mergeInProgress && G.mergeInProgress.conflictFiles.has(f) && !G.files[f].includes('<<<<<<<'))
        G.mergeInProgress.conflictFiles.delete(f);
    } else print(`error: pathspec '${f}' did not match`, 'err');
  }
  if (n) print(`已暂存 ${n} 个文件`, 'out'); sfx('file-create'); after(true);
}

function cmdCommit(rawRest) {
  // 归一化组合短 flag：-am → -a -m
  const rest = []; for (const a of rawRest) { if (a === '-am') rest.push('-a', '-m'); else rest.push(a); }
  let msg = null; for (let i = 0; i < rest.length; i++) if (rest[i] === '-m') msg = rest[i + 1];
  const amend = rest.includes('--amend'), noEdit = rest.includes('--no-edit');
  const allowEmpty = rest.includes('--allow-empty');
  const verbose = rest.includes('-v') || rest.includes('--verbose');
  const dryRun = rest.includes('--dry-run');
  // -a：提交前自动暂存所有"已跟踪且有修改"的文件
  if (rest.includes('-a')) {
    const ht0 = G.headTree();
    for (const f in G.files) {
      if (G.index[f] !== undefined) { if (G.files[f] !== G.index[f]) G.index[f] = G.files[f]; }
      else if (ht0[f] !== undefined && G.files[f] !== ht0[f]) G.index[f] = G.files[f];
    }
  }
  const ht = G.headTree();
  const changed = Object.keys(G.index).some(f => G.index[f] !== ht[f]) || Object.keys(ht).some(f => G.index[f] === undefined);
  if (dryRun) {
    const names = new Set([...Object.keys(G.index), ...Object.keys(ht)]);
    const staged = [...names].filter(f => G.index[f] !== ht[f]);
    print('Changes to be committed:', 'ok');
    if (staged.length) staged.forEach(f => print(`  ${ht[f] === undefined ? 'new file' : 'modified'}:   ${f}`, 'ok'));
    else print('  (无暂存改动)', 'out');
    print(changed ? '(dry run) 将会创建一个提交' : '(dry run) 没有可提交的改动', 'out');
    return;
  }
  if (G.mergeInProgress) {
    if (G.mergeInProgress.conflictFiles.size)
      return print('error: 还有未解决的冲突文件:\n  ' + [...G.mergeInProgress.conflictFiles].join('\n  ') + '\n解决后 git add 再 commit', 'err');
    const mp = G.mergeInProgress; G.mergeInProgress = null;
    const id = G.newId();
    G.commits[id] = { id, msg: msg || `Merge branch '${mp.branch}'`, parents: [mp.ourHead, mp.target], tree: G.snap(G.index) };
    if (G.headBranch) G.branches[G.headBranch] = id;
    G.pushReflog(id, `commit (merge): Merge branch '${mp.branch}'`);
    print(`[${G.headBranch} ${id.slice(0, 7)}] Merge branch '${mp.branch}'`, 'ok'); sfxOk(); after(true); return;
  }
  if (!changed && !amend && !allowEmpty) return print('nothing to commit, working tree clean', 'warn');
  if (amend && !G.headCommit) return print('fatal: 没有可修改的提交', 'err');
  if (!msg && !(amend && noEdit)) msg = msg || (amend ? G.commits[G.headCommit].msg : 'commit ' + G.newId());
  if (amend && noEdit) msg = G.commits[G.headCommit].msg;
  const parents = amend ? G.commits[G.headCommit].parents : (G.headCommit ? [G.headCommit] : []);
  const id = G.newId();
  G.commits[id] = { id, msg, parents, tree: G.snap(G.index) };
  if (G.headBranch) G.branches[G.headBranch] = id; else G.HEAD = { detached: id };
  G.pushReflog(id, `commit${amend ? ' (amend)' : ''}: ${msg}`);
  print(`[${G.headBranch || 'detached'} ${id.slice(0, 7)}] ${msg}`, 'ok');
  if (verbose) {
    const pt = parents[0] && G.commits[parents[0]] ? G.commits[parents[0]].tree : {};
    const pairs = [];
    for (const f of new Set([...Object.keys(pt), ...Object.keys(G.commits[id].tree)]))
      if (pt[f] !== G.commits[id].tree[f]) pairs.push({ f, oldC: pt[f], newC: G.commits[id].tree[f] });
    printDiffWith(pairs, {});
  }
  sfxOk(); after(true);
}

function cmdLog(rest) {
  const oneline = rest.includes('--oneline');
  const graph = rest.includes('--graph');
  const showAll = rest.includes('--all');
  const stat = rest.includes('--stat');
  const patch = rest.includes('-p');
  const nameOnly = rest.includes('--name-only');
  const follow = rest.includes('--follow');
  const kv = parseKV(rest, ['--author', '--grep', '--since', '-S']);
  let prettyFmt = null;
  for (const a of rest) if (a.startsWith('--pretty=format:')) prettyFmt = a.slice('--pretty=format:'.length);
  let limit = Infinity;
  const ni = rest.indexOf('-n');
  if (ni >= 0) { const v = parseInt(rest[ni + 1]); if (!isNaN(v) && v >= 0) limit = v; }
  const ref = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '-n' &&
    rest[i - 1] !== '--author' && rest[i - 1] !== '--grep' && rest[i - 1] !== '--since' && rest[i - 1] !== '-S')[0];

  let ids;
  if (showAll || graph) {
    // 收集所有可达提交（--all 取全部分支/标签起点，否则从 HEAD 或指定 ref 出发）
    let starts;
    if (showAll) starts = [...Object.values(G.branches), ...Object.values(G.tags)].filter(Boolean);
    else {
      const s = ref ? G.resolve(ref) : G.headCommit;
      if (ref && s === undefined) return print(`fatal: 无法解析 '${ref}'`, 'err');
      starts = s ? [s] : [];
    }
    if (!starts.length) return print('fatal: 还没有任何提交', 'err');
    const seen = new Set(); const stack = [...starts];
    while (stack.length) {
      const id = stack.pop();
      if (!id || seen.has(id)) continue;
      seen.add(id); G.commits[id].parents.forEach(p => stack.push(p));
    }
    ids = [...seen].sort((a, b) => parseInt(b, 16) - parseInt(a, 16));
  } else {
    let cur = ref ? G.resolve(ref) : G.headCommit;
    if (ref && cur === undefined) return print(`fatal: 无法解析 '${ref}'`, 'err');
    if (!cur) return print('fatal: 还没有任何提交', 'err');
    ids = [];
    while (cur) { ids.push(cur); cur = G.commits[cur].parents[0]; }
  }
  if (limit !== Infinity) ids = ids.slice(0, limit);

  // 选项过滤：--author / --grep / --since / -S（pickaxe）
  const author = (G.config && G.config['user.name']) || 'TermQuest User';
  if (kv['--author'] !== undefined) ids = ids.filter(id => author.toLowerCase().includes(String(kv['--author']).toLowerCase()));
  if (kv['--grep'] !== undefined) ids = ids.filter(id => G.commits[id].msg.includes(kv['--grep']));
  if (kv['-S'] !== undefined) {
    const s = kv['-S'];
    ids = ids.filter(id => {
      const c = G.commits[id], pt = c.parents[0] && G.commits[c.parents[0]] ? G.commits[c.parents[0]].tree : {};
      return commitChangedFiles(c).some(f => String(pt[f] ?? '').includes(s) || String(c.tree[f] ?? '').includes(s));
    });
  }
  if (kv['--since'] !== undefined) print(`(模拟环境无提交时间，--since=${kv['--since']} 已忽略)`, 'dim');
  if (follow) print('(--follow：模拟环境单文件历史与普通历史一致)', 'dim');

  if (graph) {
    // ASCII 分支图谱：泳道算法，'*' 为提交，'|' 为进行中的分支线
    const lanes = [];
    for (const id of ids) {
      const c = G.commits[id];
      let lane = lanes.indexOf(id);
      if (lane === -1) { lane = lanes.indexOf(null); if (lane === -1) { lane = lanes.length; lanes.push(null); } }
      let prefix = '';
      for (let i = 0; i < lanes.length; i++) prefix += i === lane ? '* ' : (lanes[i] ? '| ' : '  ');
      print(`${prefix}${id.slice(0, 7)} ${c.msg}`, 'info');
      for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === id) lanes[i] = null;
      lanes[lane] = c.parents[0] || null;
      for (let p = 1; p < c.parents.length; p++) {
        let pl = lanes.indexOf(null); if (pl === -1) { pl = lanes.length; lanes.push(null); }
        lanes[pl] = c.parents[p];
      }
    }
    return;
  }

  for (const id of ids) {
    const c = G.commits[id];
    if (prettyFmt !== null) {
      const line = prettyFmt
        .replace(/%h/g, id.slice(0, 7)).replace(/%H/g, id)
        .replace(/%s/g, c.msg).replace(/%an/g, author).replace(/%ad/g, commitDate(c))
        .replace(/%d/g, '');
      print(line, 'info');
    } else if (oneline) print(`${id.slice(0, 7)} ${c.msg}`, 'info');
    else {
      print(`commit ${id}`, 'warn');
      print(`    ${c.msg}`, 'out');
      if (stat) commitStatLines(c).forEach(l => print(l, 'dim'));
      if (patch) commitPatchLines(c).forEach(x => print(x.t, x.cls));
      if (nameOnly) { commitChangedFiles(c).forEach(f => print(`  ${f}`, 'out')); print('', 'out'); }
    }
  }
}

// 提交相对第一父提交的文件改动统计（--stat）
function commitStatLines(c) {
  const pt = c.parents[0] && G.commits[c.parents[0]] ? G.commits[c.parents[0]].tree : {};
  const out = [];
  const names = new Set([...Object.keys(pt), ...Object.keys(c.tree)]);
  for (const f of names) {
    if (pt[f] === c.tree[f]) continue;
    const a = pt[f] === undefined ? [] : String(pt[f]).replace(/\n$/, '').split('\n');
    const b = c.tree[f] === undefined ? [] : String(c.tree[f]).replace(/\n$/, '').split('\n');
    let add = 0, del = 0;
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) if (a[i] !== b[i]) { if (i < b.length) add++; if (i < a.length) del++; }
    out.push(` ${f} | +${add} -${del}`);
  }
  return out.length ? out : [' (无文件改动)'];
}

// 提交相对第一父提交的补丁（-p）
function commitPatchLines(c) {
  const pt = c.parents[0] && G.commits[c.parents[0]] ? G.commits[c.parents[0]].tree : {};
  const out = [];
  const names = new Set([...Object.keys(pt), ...Object.keys(c.tree)]);
  for (const f of names) {
    if (pt[f] === c.tree[f]) continue;
    out.push({ t: `diff --git a/${f} b/${f}`, cls: 'info' });
    out.push({ t: `--- a/${f}`, cls: 'out' });
    out.push({ t: `+++ b/${f}`, cls: 'out' });
    if (pt[f] !== undefined) out.push({ t: `- ${String(pt[f]).trim()}`, cls: 'err' });
    if (c.tree[f] !== undefined) out.push({ t: `+ ${String(c.tree[f]).trim()}`, cls: 'ok' });
  }
  return out;
}

function cmdDiff(rest) {
  const staged = rest.includes('--staged') || rest.includes('--cached');
  const opts = {
    nameOnly: rest.includes('--name-only'),
    nameStatus: rest.includes('--name-status'),
    stat: rest.includes('--stat'),
    wordDiff: rest.includes('--word-diff'),
    ignoreWS: rest.includes('-w') || rest.includes('--ignore-all-space'),
  };
  const args = rest.filter(a => !a.startsWith('-'));
  const ht = G.headTree();
  const norm = c => (c === undefined ? undefined : String(c).replace(/\s+/g, ' '));
  const neq = (a, b) => opts.ignoreWS ? norm(a) !== norm(b) : a !== b;

  if (staged) {
    // 暂存区 vs HEAD
    const pairs = [];
    const names = new Set([...Object.keys(G.index), ...Object.keys(ht)]);
    for (const f of names) {
      if (args.length && !args.includes(f)) continue;
      if (neq(G.index[f], ht[f])) pairs.push({ f, oldC: ht[f], newC: G.index[f] });
    }
    printDiffWith(pairs, opts);
    return;
  }

  // 解析位置参数：文件优先，其次当作 ref
  let refTree = null, fileFilter = null;
  if (args[0]) {
    const isFile = G.files[args[0]] !== undefined || G.index[args[0]] !== undefined || ht[args[0]] !== undefined;
    if (isFile) fileFilter = args[0];
    else {
      const rid = G.resolve(args[0]);
      if (rid !== undefined && G.commits[rid]) refTree = G.commits[rid].tree;
      else return print(`fatal: 无法解析 '${args[0]}'`, 'err');
    }
  }

  const pairs = [];
  if (refTree) {
    // 工作区 vs 指定提交
    for (const f in G.files) if (neq(G.files[f], refTree[f])) pairs.push({ f, oldC: refTree[f], newC: G.files[f] });
  } else {
    // 默认：工作区 vs 暂存区（缺省回退到 HEAD）
    for (const f in G.files) {
      if (fileFilter && f !== fileFilter) continue;
      const base = G.index[f] !== undefined ? G.index[f] : ht[f];
      if (base !== undefined && neq(G.files[f], base)) pairs.push({ f, oldC: base, newC: G.files[f] });
    }
  }
  printDiffWith(pairs, opts);
}

function cmdBranch(rest) {
  const showLocal = (pattern) => {
    for (const b in G.branches) {
      if (pattern && !b.includes(pattern)) continue;
      print(`${b === G.headBranch ? '*' : ' '} ${b}`, b === G.headBranch ? 'ok' : 'out');
    }
  };
  const showRemote = () => {
    G.remotes = G.remotes || {};
    let any = false;
    for (const rn in G.remotes) for (const b in (G.remotes[rn].branches || {})) {
      print(`  ${rn}/${b}`, 'out'); any = true;
    }
    if (!any) print('(无远程跟踪分支)', 'out');
  };
  if (!rest.length) { showLocal(); return; }
  if (rest.includes('-a') || rest.includes('--all')) { showLocal(); showRemote(); return; }
  if (rest.includes('-r') || rest.includes('--remotes')) { showRemote(); return; }
  if (rest.includes('--contains')) {
    const id = G.resolve(rest[rest.indexOf('--contains') + 1] || 'HEAD');
    if (id === undefined) return print(`fatal: 无法解析 '${rest[rest.indexOf('--contains') + 1] || 'HEAD'}'`, 'err');
    let any = false;
    for (const b in G.branches) if (branchContains(b, id)) { print(`${b === G.headBranch ? '*' : ' '} ${b}`, b === G.headBranch ? 'ok' : 'out'); any = true; }
    if (!any) print('(没有分支包含该提交)', 'out');
    return;
  }
  if (rest.includes('--merged')) {
    const arg = rest[rest.indexOf('--merged') + 1];
    const id = G.resolve(arg && !arg.startsWith('-') ? arg : 'HEAD');
    if (id === undefined) return print(`fatal: 无法解析 '${arg}'`, 'err');
    for (const b in G.branches) if (G.isAncestor(G.branches[b], id)) print(`${b === G.headBranch ? '*' : ' '} ${b}`, b === G.headBranch ? 'ok' : 'out');
    return;
  }
  if (rest[0] === '--list' || rest[0] === '-l') { showLocal(rest[1]); return; }
  if (rest[0] === '-d' || rest[0] === '-D') {
    const n = rest[1];
    if (G.branches[n] === undefined) return print(`error: 分支 '${n}' 不存在`, 'err');
    if (n === G.headBranch) return print('error: 不能删除当前分支', 'err');
    delete G.branches[n]; print(`Deleted branch ${n}`, 'ok'); after(false); return;
  }
  if (rest[0] === '-v') {
    for (const b in G.branches) {
      const id = G.branches[b];
      const c = id ? G.commits[id] : null;
      print(`${b === G.headBranch ? '*' : ' '} ${b} ${id ? id.slice(0, 7) : '(空)'} ${c ? c.msg : ''}`, b === G.headBranch ? 'ok' : 'out');
    }
    return;
  }
  if (rest[0] === '-m') {
    if (!G.headBranch) return print('fatal: 不在分支上，无法重命名', 'err');
    const newName = rest[1];
    if (!newName) return print('用法: git branch -m <新名称>', 'err');
    if (G.branches[newName] !== undefined) return print(`fatal: 分支 '${newName}' 已存在`, 'err');
    const old = G.headBranch;
    G.branches[newName] = G.branches[old];
    delete G.branches[old];
    G.HEAD = newName;
    print(`已将分支 '${old}' 重命名为 '${newName}'`, 'ok'); after(true); return;
  }
  const n = rest[0];
  if (G.branches[n] !== undefined) return print(`fatal: 分支 '${n}' 已存在`, 'err');
  G.branches[n] = G.headCommit; print(`已创建分支 ${n}`, 'out'); sfx('proc-fork'); after(true);
}

function cmdSwitch(rest) {
  let create = false, name = rest[0];
  if (rest[0] === '-c' || rest[0] === '-b') { create = true; name = rest[1]; }
  if (!name) return print('用法: git switch <分支> 或 git switch -c <新分支>', 'err');
  if (create) { if (G.branches[name] !== undefined) return print(`fatal: 分支 '${name}' 已存在`, 'err'); G.branches[name] = G.headCommit; }
  else if (G.branches[name] === undefined) return print(`error: '${name}' 不是分支（用 -c 创建）`, 'err');
  const from = G.headBranch || String(G.headCommit).slice(0, 7);
  G.HEAD = name; const tr = G.headTree(); G.files = G.snap(tr); G.index = G.snap(tr);
  G.pushReflog(G.headCommit, `checkout: moving from ${from} to ${name}`);
  print(`Switched to branch '${name}'`, 'ok'); sfx('ui-tab'); after(true);
}

function cmdMerge(rest) {
  if (rest.includes('--abort')) {
    if (!G.mergeInProgress) return print('fatal: 没有进行中的合并', 'err');
    const mp = G.mergeInProgress; G.mergeInProgress = null;
    G.files = G.snap(mp.preFiles); G.index = G.snap(mp.preIndex);
    print('已放弃合并，恢复到合并前状态', 'ok'); after(false); return;
  }
  const strat = parseKV(rest, ['-X'])['-X'];
  const squash = rest.includes('--squash');
  const noCommit = rest.includes('--no-commit');
  const name = rest.filter(a => !a.startsWith('-') && a !== 'ours' && a !== 'theirs')[0];
  if (!name) return print('用法: git merge <分支> [--squash|--no-commit|-X ours|-X theirs|--abort]', 'err');
  if (G.mergeInProgress) return print('error: 有未完成的合并，先解决冲突或 git merge --abort', 'err');
  if (G.branches[name] === undefined) return print(`merge: ${name} - not something we can merge`, 'err');
  const target = G.branches[name], cur = G.headCommit;
  if (target === cur) return print('Already up to date.', 'out');
  if (G.isAncestor(cur, target)) {
    if (squash) {
      G.files = G.snap(G.commits[target].tree); G.index = G.snap(G.commits[target].tree);
      print('Squash commit -- updating HEAD', 'out');
      print('Changes to be committed:', 'ok');
      print('(使用 git commit 完成压缩提交)', 'dim'); after(true); return;
    }
    if (G.headBranch) G.branches[G.headBranch] = target;
    G.files = G.snap(G.commits[target].tree); G.index = G.snap(G.commits[target].tree);
    G.pushReflog(target, `merge ${name}: Fast-forward`);
    print(`Updating ${String(cur).slice(0, 7)}..${target.slice(0, 7)}`, 'out'); print('Fast-forward', 'ok');
    sfxOk(); after(true); return;
  }
  const base = G.commonAncestor(cur, target);
  const baseTree = base ? G.commits[base].tree : {}, our = G.headTree(), their = G.commits[target].tree;
  const conflicts = [];
  for (const f in their) { if (our[f] !== undefined && our[f] !== baseTree[f] && their[f] !== baseTree[f] && our[f] !== their[f]) conflicts.push(f); }
  if (conflicts.length && !strat) {
    G.mergeInProgress = { target, branch: name, ourHead: cur, conflictFiles: new Set(conflicts), preFiles: G.snap(G.files), preIndex: G.snap(G.index) };
    for (const f of conflicts)
      G.files[f] = `<<<<<<< HEAD\n${our[f].trim()}\n=======\n${their[f].trim()}\n>>>>>>> ${name}\n`;
    print(`Auto-merging ${conflicts.join(', ')}`, 'out');
    print(`CONFLICT (content): Merge conflict in ${conflicts.join(', ')}`, 'err');
    print('Automatic merge failed; fix conflicts and then commit the result.', 'err'); sfxErr();
    after(false); return;
  }
  if (conflicts.length && strat)
    print(`Auto-merging ${conflicts.join(', ')}（-X ${strat}：自动取${strat === 'ours' ? '我方' : '对方'}版本）`, 'out');
  const tree = G.snap(their); for (const f in our) if (tree[f] === undefined) tree[f] = our[f];
  if (strat) for (const f of conflicts) tree[f] = strat === 'ours' ? our[f] : their[f];
  if (squash) {
    G.files = G.snap(tree); G.index = G.snap(tree);
    print('Squash commit -- updating HEAD', 'out');
    print('Changes to be committed:', 'ok');
    print('(使用 git commit 完成压缩提交)', 'dim'); after(true); return;
  }
  if (noCommit) {
    G.files = G.snap(tree); G.index = G.snap(tree);
    G.mergeInProgress = { target, branch: name, ourHead: cur, conflictFiles: new Set(), preFiles: G.snap(G.files), preIndex: G.snap(G.index), noCommit: true };
    print('Automatic merge went well.', 'ok');
    print('Changes to be committed:', 'ok');
    print('(使用 git commit 完成合并提交)', 'dim'); after(true); return;
  }
  const id = G.newId();
  G.commits[id] = { id, msg: `Merge branch '${name}'`, parents: [cur, target], tree };
  if (G.headBranch) G.branches[G.headBranch] = id;
  G.files = G.snap(tree); G.index = G.snap(tree);
  G.pushReflog(id, `merge ${name}: Merge made by the 'ort' strategy.`);
  print(`Merge made by the 'ort' strategy.`, 'ok'); sfxOk(); after(true);
}

function cmdReset(rest) {
  let mode = '--mixed';
  const args = rest.filter(a => { if (a.startsWith('--')) { mode = a; return false; } return true; });
  const target = G.resolve(args[0] || 'HEAD');
  if (target === undefined) return print(`fatal: 无法解析 '${args[0]}'`, 'err');
  const tree = G.commits[target] ? G.commits[target].tree : {};
  if (G.headBranch) G.branches[G.headBranch] = target; else G.HEAD = { detached: target };
  if (mode === '--mixed' || mode === '--hard') G.index = G.snap(tree);
  if (mode === '--hard') G.files = G.snap(tree);
  G.pushReflog(target, `reset (${mode.replace('--', '')}): moving to ${args[0] || 'HEAD'}`);
  print(`HEAD 已移动到 ${target ? target.slice(0, 7) : '(root)'}`, 'warn'); sfx('file-move'); after(true);
}

function cmdRestore(rest) {
  const staged = rest.includes('--staged');
  const files = rest.filter(a => !a.startsWith('--'));
  if (!files.length) return print('用法: git restore [--staged] <文件>', 'err');
  const ht = G.headTree();
  for (const f of files) {
    if (staged) { if (ht[f] === undefined) delete G.index[f]; else G.index[f] = ht[f]; print(`已取消暂存 ${f}`, 'out'); }
    else {
      const base = G.index[f] !== undefined ? G.index[f] : ht[f];
      if (base === undefined) delete G.files[f]; else G.files[f] = base; print(`已恢复 ${f}`, 'out');
    }
  }
  after(true);
}

function cmdStash(rest) {
  const sub = rest[0];
  const idxOf = (a) => { const m = a && a.match(/^stash@\{(\d+)\}$/); return m ? parseInt(m[1]) : 0; };
  if (sub === 'list') {
    if (!G.stash.length) return print('(stash 为空)', 'out');
    G.stash.forEach((s, i) => print(`stash@{${i}}: ${s.msg}`, 'info')); return;
  }
  if (sub === 'clear') {
    if (!G.stash.length) return print('(stash 为空)', 'out');
    const n = G.stash.length; G.stash = [];
    print(`已清空 ${n} 条 stash`, 'ok'); sfx('file-delete'); after(true); return;
  }
  if (sub === 'branch') {
    const bname = rest[1];
    if (!bname) return print('用法: git stash branch <分支名> [stash@{N}]', 'err');
    if (!G.stash.length) return print('No stash entries found.', 'err');
    const s = G.stash[idxOf(rest[2])];
    if (G.branches[bname] !== undefined) return print(`fatal: 分支 '${bname}' 已存在`, 'err');
    const id = G.newId();
    G.commits[id] = { id, msg: `stash: ${s.msg}`, parents: [G.headCommit].filter(Boolean), tree: G.snap(s.files) };
    G.branches[bname] = id; G.HEAD = bname;
    G.files = G.snap(s.files); G.index = G.snap(s.index);
    print(`Switched to a new branch '${bname}'（来自 stash）`, 'ok'); after(true); return;
  }
  if (sub === 'pop' || sub === 'apply') {
    if (!G.stash.length) return print('No stash entries found.', 'err');
    const i = idxOf(rest[1]); const s = G.stash[i];
    if (!s) return print(`fatal: stash@{${i}} 不存在`, 'err');
    G.files = G.snap(s.files); G.index = G.snap(s.index);
    if (sub === 'pop') G.stash.splice(i, 1);
    print(`已${sub === 'pop' ? '弹出' : '应用'} stash@{${i}}`, 'ok'); sfx('ui-open'); after(true); return;
  }
  if (sub === 'drop') {
    if (!G.stash.length) return print('No stash entries found.', 'err');
    const i = idxOf(rest[1]); const s = G.stash[i];
    if (!s) return print(`fatal: stash@{${i}} 不存在`, 'err');
    G.stash.splice(i, 1);
    print(`Dropped stash@{${i}} (${s.msg})`, 'ok'); sfx('file-delete'); after(true); return;
  }
  if (sub === 'show') {
    if (!G.stash.length) return print('No stash entries found.', 'err');
    const i = idxOf(rest[1]); const s = G.stash[i];
    if (!s) return print(`fatal: stash@{${i}} 不存在`, 'err');
    print(`stash@{${i}}: ${s.msg}`, 'info');
    const ht = G.headTree();
    const names = new Set([...Object.keys(s.files), ...Object.keys(ht)]);
    let any = false;
    for (const f of names) if (s.files[f] !== ht[f]) { print(` ${f}`, 'out'); any = true; }
    if (!any) print(' (与 HEAD 无差异)', 'out');
    return;
  }
  if (sub === 'push') {
    const mi = rest.indexOf('-m');
    const incU = rest.includes('-u') || rest.includes('--include-untracked');
    doStashPush(mi >= 0 && rest[mi + 1] ? rest[mi + 1] : `WIP on ${G.headBranch || 'detached'}`, incU);
    return;
  }
  doStashPush(`WIP on ${G.headBranch || 'detached'}`, rest.includes('-u') || rest.includes('--include-untracked'));
}

function doStashPush(msg, includeUntracked) {
  const ht = G.headTree();
  const dirty = JSON.stringify(G.files) !== JSON.stringify(ht) || JSON.stringify(G.index) !== JSON.stringify(ht);
  if (!dirty) return print('No local changes to save', 'warn');
  G.stash.unshift({ files: G.snap(G.files), index: G.snap(G.index), msg, untracked: !!includeUntracked });
  G.files = G.snap(ht); G.index = G.snap(ht);
  print(includeUntracked ? 'Saved working directory, index state and untracked files' : 'Saved working directory and index state', 'ok'); sfx('ui-close'); after(true);
}

function cmdTag(rest) {
  if (!rest.length) {
    const n = Object.keys(G.tags);
    if (!n.length) return print('(暂无标签)', 'out'); n.forEach(x => print(x, 'info')); return;
  }
  if (rest.includes('-n')) {
    const n = Object.keys(G.tags);
    if (!n.length) return print('(暂无标签)', 'out');
    n.forEach(x => print(`${x}  ${(G.tagAnnotated && G.tagAnnotated[x]) || ''}`, 'info'));
    return;
  }
  if (rest[0] === '-l' || rest[0] === '--list') {
    const pat = rest[1];
    const n = Object.keys(G.tags).filter(x => !pat || x.includes(pat));
    if (!n.length) return print('(无匹配标签)', 'out');
    n.forEach(x => print(x, 'info')); return;
  }
  if (rest[0] === '-d') {
    const n = rest[1];
    if (!n || G.tags[n] === undefined) return print(`error: 标签 '${n || ''}' 不存在`, 'err');
    delete G.tags[n];
    if (G.tagAnnotated) delete G.tagAnnotated[n];
    print(`Deleted tag ${n}`, 'ok'); after(true); return;
  }
  const force = rest.includes('-f') || rest.includes('--force');
  if (rest.includes('-a')) {
    const name = rest.filter(a => a !== '-a' && a !== '-m' && a !== '-f' && a !== '--force')[0];
    if (!name) return print('用法: git tag -a <名称> -m "信息"', 'err');
    if (G.tags[name] !== undefined && !force) return print(`fatal: 标签 '${name}' 已存在（用 -f 覆盖）`, 'err');
    const mi = rest.indexOf('-m');
    G.tags[name] = G.headCommit;
    G.tagAnnotated = G.tagAnnotated || {};
    G.tagAnnotated[name] = mi >= 0 ? String(rest[mi + 1] ?? '') : '';
    print(`已创建附注标签 ${name} → ${String(G.headCommit).slice(0, 7)}`, 'ok'); after(true); return;
  }
  const args = rest.filter(a => a !== '-a' && a !== '-m' && a !== '-f' && a !== '--force');
  if (!args[0]) return print('用法: git tag <名称> [-f]', 'err');
  if (G.tags[args[0]] !== undefined && !force) return print(`fatal: 标签 '${args[0]}' 已存在（用 -f 覆盖）`, 'err');
  G.tags[args[0]] = G.headCommit;
  print(`已创建标签 ${args[0]} → ${String(G.headCommit).slice(0, 7)}`, 'ok'); after(true);
}

function cmdShow(rest) {
  const id = G.resolve(rest[0] || 'HEAD');
  if (!id) return print('fatal: 无提交可显示', 'err');
  const c = G.commits[id];
  print(`commit ${id}`, 'warn'); print(`    ${c.msg}`, 'out');
  print('文件: ' + Object.keys(c.tree).join(', '), 'info');
}

function cmdCherryPick(rest) {
  const id = G.resolve(rest[0]);
  if (id === undefined) return print(`fatal: 无法解析 '${rest[0]}'`, 'err');
  const c = G.commits[id];
  const parentTree = c.parents[0] ? G.commits[c.parents[0]].tree : {};
  const tree = G.snap(G.headTree());
  for (const f in c.tree) if (c.tree[f] !== parentTree[f]) tree[f] = c.tree[f];
  for (const f in parentTree) if (c.tree[f] === undefined) delete tree[f];
  const nid = G.newId();
  G.commits[nid] = { id: nid, msg: c.msg, parents: [G.headCommit], tree };
  if (G.headBranch) G.branches[G.headBranch] = nid;
  G.files = G.snap(tree); G.index = G.snap(tree);
  G.pushReflog(nid, `cherry-pick: ${c.msg}`);
  print(`[${G.headBranch} ${nid.slice(0, 7)}] ${c.msg}`, 'ok'); sfxOk(); after(true);
}

function cmdRebase(rest) {
  G.rebaseInProgress = G.rebaseInProgress || null;
  if (rest.includes('--abort')) {
    const rb = G.rebaseInProgress;
    if (!rb) return print('fatal: 没有进行中的 rebase', 'err');
    G.rebaseInProgress = null;
    if (rb.branch) G.branches[rb.branch] = rb.origHead;
    G.HEAD = rb.branch || { detached: rb.origHead };
    const tr = G.snap(G.commits[rb.origHead].tree);
    G.files = tr; G.index = G.snap(tr);
    print('已中止 rebase，恢复到变基前状态', 'ok'); after(true); return;
  }
  if (rest.includes('--continue')) {
    if (!G.rebaseInProgress) return print('fatal: 没有进行中的 rebase', 'err');
    G.rebaseInProgress = null;
    print(`Successfully rebased and updated refs/heads/${G.headBranch}.`, 'ok'); sfxOk(); after(true); return;
  }
  const interactive = rest.includes('-i') || rest.includes('--interactive');
  const ontoIdx = rest.indexOf('--onto');
  const positional = rest.filter(a => !a.startsWith('-') && a !== 'interactive');
  let upstream, onto;
  if (ontoIdx >= 0) {
    onto = G.resolve(rest[ontoIdx + 1]);
    upstream = G.resolve(positional[0]);
  } else {
    upstream = G.resolve(positional[0]);
    onto = upstream;
  }
  if (upstream === undefined || onto === undefined) return print(`fatal: 无法解析 '${positional[0] || rest[ontoIdx + 1] || ''}'`, 'err');
  const cur = G.headCommit;
  const anc = new Set(); let a = upstream; while (a) { anc.add(a); a = G.commits[a].parents[0]; }
  const chain = []; let c = cur;
  while (c && !anc.has(c)) { chain.unshift(c); c = G.commits[c].parents[0]; }
  if (!chain.length) return print(`Current branch ${G.headBranch} is up to date.`, 'out');
  if (interactive) {
    print('交互式 rebase（模拟）：已按以下顺序 pick 全部提交', 'dim');
    chain.forEach(id => print(`pick ${id.slice(0, 7)} ${G.commits[id].msg}`, 'info'));
  }
  G.rebaseInProgress = { branch: G.headBranch, origHead: cur };
  let base = onto;
  for (const id of chain) {
    const cm = G.commits[id];
    const pTree = cm.parents[0] ? G.commits[cm.parents[0]].tree : {};
    const bTree = G.commits[base].tree;
    const tree = G.snap(bTree);
    for (const f in cm.tree) if (cm.tree[f] !== pTree[f]) tree[f] = cm.tree[f];
    for (const f in pTree) if (cm.tree[f] === undefined) delete tree[f];
    const nid = G.newId();
    G.commits[nid] = { id: nid, msg: cm.msg, parents: [base], tree };
    G.pushReflog(nid, `rebase (pick): ${cm.msg}`);
    base = nid;
  }
  if (G.headBranch) G.branches[G.headBranch] = base;
  G.files = G.snap(G.commits[base].tree); G.index = G.snap(G.commits[base].tree);
  G.rebaseInProgress = null;
  print(`Successfully rebased and updated refs/heads/${G.headBranch}.`, 'ok'); sfxOk(); after(true);
}

function cmdRevert(rest) {
  const id = G.resolve(rest[0] || 'HEAD');
  if (id === undefined) return print(`fatal: 无法解析 '${rest[0] || 'HEAD'}'`, 'err');
  const c = G.commits[id];
  if (c.parents.length > 1) return print('error: 暂不支持 revert 合并提交（需指定 -m 主线）', 'err');
  const parentTree = c.parents[0] ? G.commits[c.parents[0]].tree : {};
  // 逆向差异：该提交新增的删掉、修改/删除的恢复为父提交版本
  const tree = G.snap(G.headTree());
  for (const f in c.tree) if (c.tree[f] !== parentTree[f]) delete tree[f];
  for (const f in parentTree) if (c.tree[f] === undefined) tree[f] = parentTree[f];
  const nid = G.newId();
  const msg = `Revert "${c.msg}"`;
  G.commits[nid] = { id: nid, msg, parents: [G.headCommit], tree };
  if (G.headBranch) G.branches[G.headBranch] = nid;
  G.files = G.snap(tree); G.index = G.snap(tree);
  G.pushReflog(nid, `revert: ${msg}`);
  print(`[${G.headBranch} ${nid.slice(0, 7)}] ${msg}`, 'ok'); sfxOk(); after(true);
}

function cmdReflog() {
  if (!G.reflog.length) return print('(reflog 为空)', 'out');
  G.reflog.forEach((r, i) =>
    print(`${String(r.hash).slice(0, 7)} HEAD@{${i}}: ${r.action}`, 'info'));
}

function cmdClean(rest) {
  const flags = rest.filter(a => a.startsWith('-')).join('');
  const dry = flags.includes('n');
  const ht = G.headTree();
  const targets = [];
  for (const f in G.files) if (G.index[f] === undefined && ht[f] === undefined) targets.push(f);
  if (dry) {
    if (!targets.length) return print('(没有未跟踪的文件需要清理)', 'out');
    targets.forEach(f => print(`Would remove ${f}`, 'out'));
    return;
  }
  if (!flags.includes('f')) return print('fatal: clean 需要 -f（强制）才能删除文件', 'err');
  if (flags.includes('x')) print('(-x：连同被忽略的文件一并清理)', 'dim');
  if (!targets.length) return print('(没有未跟踪的文件需要清理)', 'out');
  targets.forEach(f => { delete G.files[f]; print(`Removing ${f}`, 'out'); });
  sfx('file-delete'); after(true);
}

function cmdConfig(rest) {
  G.config = G.config || {};
  const scope = rest.includes('--global') || rest.includes('--local') || rest.includes('--system');
  if (rest.includes('--list') || rest.includes('-l')) {
    const ks = Object.keys(G.config);
    if (!ks.length) return print('(尚未设置任何配置)', 'out');
    ks.forEach(k => print(`${k}=${G.config[k]}`, 'out'));
    return;
  }
  const ui = rest.indexOf('--unset');
  if (ui >= 0) {
    const key = rest[ui + 1];
    if (G.config[key] === undefined) return print(`(未设置 ${key || ''})`, 'out');
    delete G.config[key]; print(`已取消设置 ${key}`, 'ok'); after(true); return;
  }
  const gi = rest.indexOf('--get');
  const args = rest.filter(a => !a.startsWith('-'));
  const key = gi >= 0 ? rest[gi + 1] : args[0];
  if (!key) return print('用法: git config [--global] <键> [值] | --get <键> | --unset <键> | --list', 'err');
  if (gi >= 0) {
    if (G.config[key] === undefined) return print(`(未设置 ${key})`, 'out');
    print(G.config[key], 'out'); return;
  }
  if (key !== 'user.name' && key !== 'user.email' && !key.includes('.'))
    return print(`git config: 不支持的键 '${key}'（形如 user.name / core.editor）`, 'err');
  const vals = args.slice(1);
  if (vals.length) {
    G.config[key] = vals.join(' ');
    print(`已设置${scope ? '（global）' : ''} ${key} = ${G.config[key]}`, 'ok'); after(true); return;
  }
  if (G.config[key] === undefined) return print(`(未设置 ${key})`, 'out');
  print(G.config[key], 'out');
}

// ── 模拟远程仓库（快进式 push/pull/fetch + clone）──
function cmdRemote(rest) {
  G.remotes = G.remotes || {};
  if (!rest.length || rest[0] === '-v') {
    const names = Object.keys(G.remotes);
    if (!names.length) return print('(暂无远程仓库)', 'out');
    for (const n of names) {
      print(`${n}  ${G.remotes[n].url} (fetch)`, 'info');
      print(`${n}  ${G.remotes[n].url} (push)`, 'info');
    }
    return;
  }
  if (rest[0] === 'add') {
    const name = rest[1], url = rest[2];
    if (!name || !url) return print('用法: git remote add <名称> <url>', 'err');
    if (G.remotes[name]) return print(`error: 远程 '${name}' 已存在`, 'err');
    G.remotes[name] = { url, branches: {} };
    print(`已添加远程 ${name} → ${url}`, 'ok'); after(true); return;
  }
  if (rest[0] === 'remove' || rest[0] === 'rm') {
    const name = rest[1];
    if (!name || !G.remotes[name]) return print(`error: 远程 '${name || ''}' 不存在`, 'err');
    delete G.remotes[name];
    print(`已删除远程 ${name}`, 'ok'); after(true); return;
  }
  if (rest[0] === 'rename') {
    const oldN = rest[1], newN = rest[2];
    if (!oldN || !newN || !G.remotes[oldN]) return print(`error: 远程 '${oldN || ''}' 不存在`, 'err');
    if (G.remotes[newN]) return print(`error: 远程 '${newN}' 已存在`, 'err');
    G.remotes[newN] = G.remotes[oldN]; delete G.remotes[oldN];
    print(`已将远程 '${oldN}' 重命名为 '${newN}'`, 'ok'); after(true); return;
  }
  if (rest[0] === 'set-url') {
    const name = rest[1], url = rest[2];
    if (!name || !url || !G.remotes[name]) return print(`error: 远程 '${name || ''}' 不存在`, 'err');
    G.remotes[name].url = url;
    print(`已设置 ${name} 的 url 为 ${url}`, 'ok'); after(true); return;
  }
  if (rest[0] === 'show') {
    const name = rest[1];
    if (!name || !G.remotes[name]) return print(`error: 远程 '${name || ''}' 不存在`, 'err');
    const r = G.remotes[name];
    print(`* remote ${name}`, 'info');
    print(`  Fetch URL: ${r.url}`, 'out');
    print(`  Push  URL: ${r.url}`, 'out');
    const bs = Object.keys(r.branches || {});
    print(bs.length ? `  跟踪分支: ${bs.join(', ')}` : '  (无跟踪分支)', 'out');
    return;
  }
  if (rest[0] === 'prune') {
    const name = rest[1];
    if (!name || !G.remotes[name]) return print(`error: 远程 '${name || ''}' 不存在`, 'err');
    print(`Fetching ${name}`, 'out');
    print('(没有需要清理的过期远程跟踪引用)', 'out');
    return;
  }
  return print('用法: git remote [-v] | add <名称> <url> | remove <名称> | rename <旧> <新> | set-url <名称> <url> | show <名称> | prune <名称>', 'err');
}

function cmdClone(rest) {
  const url = rest[0];
  if (!url) return print('用法: git clone <url>', 'err');
  G.remotes = G.remotes || {};
  const store = (G.remoteStores || {})[url] || Object.values(G.remotes).find(r => r.url === url);
  if (!store) return print(`fatal: 仓库 '${url}' 不存在（模拟环境只能克隆预设的远程地址）`, 'err');
  const branch = store.branches.main !== undefined ? 'main' : Object.keys(store.branches)[0];
  const tip = branch !== undefined ? store.branches[branch] : undefined;
  if (tip === undefined || !G.commits[tip]) return print('fatal: 远程仓库为空', 'err');
  // 用远程内容初始化本地仓库
  G.branches = { [branch]: tip };
  G.HEAD = branch;
  const tr = G.snap(G.commits[tip].tree);
  G.files = tr; G.index = G.snap(tr);
  G.stash = []; G.tags = {}; G.tagAnnotated = {}; G.reflog = []; G.mergeInProgress = null;
  G.remotes = { origin: { url, branches: G.snap(store.branches) } };
  print(`Cloning into 'termquest'...`, 'out');
  print('remote: Enumerating objects: done.', 'dim');
  print('Receiving objects: 100% (done)', 'dim');
  print(`已克隆 ${url}（分支 ${branch} @ ${tip.slice(0, 7)}）`, 'ok');
  G.pushReflog(tip, `clone: from ${url}`);
  sfxOk(); after(true);
}

function cmdPush(rest) {
  G.remotes = G.remotes || {};
  const r = G.remotes.origin;
  if (!r) return print('fatal: 没有配置远程仓库（git clone 或 git remote add origin <url>）', 'err');
  const args = rest.filter(a => !a.startsWith('-') && a !== 'origin');
  const branch = args[0] || G.headBranch;
  if (!branch || G.branches[branch] === undefined) return print(`error: 分支 '${branch || '(无)'}' 不存在`, 'err');
  const local = G.branches[branch], remoteTip = r.branches[branch];
  if (remoteTip !== undefined && !G.isAncestor(remoteTip, local)) {
    print(`To ${r.url}`, 'out');
    print(` ! [rejected]        ${branch} -> ${branch} (non-fast-forward)`, 'err');
    print('error: 推送被拒绝：远程包含本地没有的提交，先 git pull 合并', 'err');
    sfxErr(); return;
  }
  r.branches[branch] = local;
  print(`To ${r.url}`, 'out');
  print(`   ${remoteTip ? remoteTip.slice(0, 7) : '(new)'}..${local.slice(0, 7)}  ${branch} -> ${branch}`, 'ok');
  sfxOk(); after(true);
}

function cmdPull(rest) {
  G.remotes = G.remotes || {};
  const r = G.remotes.origin;
  if (!r) return print('fatal: 没有配置远程仓库（git clone 或 git remote add origin <url>）', 'err');
  const args = rest.filter(a => !a.startsWith('-') && a !== 'origin');
  const branch = args[0] || G.headBranch;
  if (!branch || G.branches[branch] === undefined) return print(`error: 分支 '${branch || '(无)'}' 不存在`, 'err');
  const remoteTip = r.branches[branch];
  if (remoteTip === undefined) return print(`fatal: 远程没有分支 '${branch}'`, 'err');
  const local = G.branches[branch];
  if (local === remoteTip) return print('Already up to date.', 'out');
  if (!G.isAncestor(local, remoteTip))
    return print('error: 本地与远程存在分叉，模拟环境仅支持快进式 pull（先提交或合并本地改动）', 'err');
  G.branches[branch] = remoteTip;
  const tr = G.snap(G.commits[remoteTip].tree);
  G.files = tr; G.index = G.snap(tr);
  G.pushReflog(remoteTip, `pull ${branch}: Fast-forward`);
  print(`Updating ${String(local).slice(0, 7)}..${remoteTip.slice(0, 7)}`, 'out');
  print('Fast-forward', 'ok'); sfxOk(); after(true);
}

function cmdFetch() {
  G.remotes = G.remotes || {};
  const r = G.remotes.origin;
  if (!r) return print('fatal: 没有配置远程仓库（git clone 或 git remote add origin <url>）', 'err');
  const names = Object.keys(r.branches);
  if (!names.length) return print('远程暂无分支', 'out');
  print(`From ${r.url}`, 'out');
  for (const b of names) print(`   ${String(r.branches[b]).slice(0, 7)}  origin/${b}`, 'info');
}

// ── 新增子命令 ──
function cmdInit(rest) {
  print(`Initialized empty Git repository in /termquest/.git/`, 'ok');
  if (rest.includes('--bare')) print('(bare 仓库：不含工作区)', 'dim');
  after(true);
}

// checkout：兼容 switch（切分支）与 restore（恢复文件）
function cmdCheckout(rest) {
  const create = rest.includes('-b') || rest.includes('-B');
  const args = rest.filter(a => !a.startsWith('-'));
  if (create) {
    const name = args[0];
    if (!name) return print('用法: git checkout -b <新分支>', 'err');
    if (G.branches[name] !== undefined) return print(`fatal: 分支 '${name}' 已存在`, 'err');
    G.branches[name] = G.headCommit;
    G.HEAD = name; const tr = G.headTree(); G.files = G.snap(tr); G.index = G.snap(tr);
    G.pushReflog(G.headCommit, `checkout: moving to ${name}`);
    print(`Switched to a new branch '${name}'`, 'ok'); sfx('ui-tab'); after(true); return;
  }
  if (!args.length) return print('用法: git checkout <分支|文件> [-b 新分支]', 'err');
  const name = args[0];
  if (G.branches[name] !== undefined) {
    const from = G.headBranch || String(G.headCommit).slice(0, 7);
    G.HEAD = name; const tr = G.headTree(); G.files = G.snap(tr); G.index = G.snap(tr);
    G.pushReflog(G.headCommit, `checkout: moving from ${from} to ${name}`);
    print(`Switched to branch '${name}'`, 'ok'); sfx('ui-tab'); after(true); return;
  }
  // 当作文件：恢复工作区（等同 git restore <文件>）
  const ht = G.headTree();
  if (G.files[name] !== undefined || G.index[name] !== undefined || ht[name] !== undefined) {
    const base = G.index[name] !== undefined ? G.index[name] : ht[name];
    if (base === undefined) delete G.files[name]; else G.files[name] = base;
    print(`已恢复 ${name}`, 'out'); after(true); return;
  }
  const id = G.resolve(name);
  if (id !== undefined && G.commits[id]) {
    G.HEAD = { detached: id }; const tr = G.commits[id].tree;
    G.files = G.snap(tr); G.index = G.snap(tr);
    G.pushReflog(id, `checkout: moving to ${name}`);
    print(`Note: switching to '${name}'.\nHEAD detached at ${id.slice(0, 7)}`, 'warn'); after(true); return;
  }
  return print(`error: pathspec '${name}' did not match any file or branch`, 'err');
}

function cmdWorktree(rest) {
  G.worktrees = G.worktrees || [];
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    print(`/termquest  ${String(G.headCommit || '').slice(0, 7)} [${G.headBranch || 'detached'}]`, 'info');
    G.worktrees.forEach(w => print(`${w.path}  ${String(w.commit || '').slice(0, 7)} [${w.branch}]`, 'info'));
    return;
  }
  if (sub === 'add') {
    const path = rest[1];
    if (!path) return print('用法: git worktree add <路径> [分支]', 'err');
    const branch = rest[2] || G.headBranch || 'detached';
    G.worktrees.push({ path, branch, commit: G.branches[branch] || G.headCommit });
    print(`Preparing worktree (checking out '${branch}')`, 'out');
    print(`已添加工作树 ${path} → ${branch}`, 'ok'); after(true); return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const path = rest[1];
    const i = G.worktrees.findIndex(w => w.path === path);
    if (i < 0) return print(`fatal: '${path || ''}' 不是工作树`, 'err');
    G.worktrees.splice(i, 1);
    print(`已移除工作树 ${path}`, 'ok'); after(true); return;
  }
  if (sub === 'prune') { print('已清理无效的工作树记录', 'ok'); return; }
  return print('用法: git worktree [list|add <路径> [分支]|remove <路径>|prune]', 'err');
}

function cmdBisect(rest) {
  G.bisect = G.bisect || null;
  const sub = rest[0];
  if (sub === 'start') {
    G.bisect = { bad: null, good: [], skipped: [] };
    print('Bisecting: 开始二分查找', 'ok'); after(true); return;
  }
  if (!G.bisect) return print('fatal: 需要先 git bisect start', 'err');
  if (sub === 'bad') {
    G.bisect.bad = G.headCommit;
    print(`已将当前提交标记为 bad（${String(G.headCommit).slice(0, 7)}）`, 'ok'); after(true); return;
  }
  if (sub === 'good') {
    const id = G.resolve(rest[1] || 'HEAD');
    if (id !== undefined) G.bisect.good.push(id);
    const total = Object.keys(G.commits).length;
    const steps = Math.max(1, Math.ceil(Math.log2(total + 1)));
    print(`Bisecting: 约 ${steps} 步后找到首个坏提交（模拟）`, 'info'); after(true); return;
  }
  if (sub === 'skip') {
    G.bisect.skipped.push(G.headCommit);
    print('已跳过当前提交', 'out'); after(true); return;
  }
  if (sub === 'reset') {
    G.bisect = null;
    print('已退出 bisect，恢复原 HEAD', 'ok'); after(true); return;
  }
  return print('用法: git bisect [start|bad|good [提交]|skip|reset]', 'err');
}

function cmdGrep(rest) {
  const args = rest.filter(a => !a.startsWith('-'));
  const ignoreCase = rest.includes('-i');
  const showName = rest.includes('-n');
  const count = rest.includes('-c');
  const filesOnly = rest.includes('-l');
  const pattern = args[0];
  if (pattern === undefined) return print('用法: git grep [-incl] <模式> [文件]', 'err');
  const fileArg = args[1];
  const files = fileArg ? Object.keys(G.files).filter(f => f.includes(fileArg)) : Object.keys(G.files);
  const rx = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '');
  let total = 0;
  for (const f of files) {
    const lines = String(G.files[f]).replace(/\n$/, '').split('\n');
    const hits = [];
    lines.forEach((ln, i) => { if (rx.test(ln)) hits.push({ i: i + 1, ln }); });
    if (!hits.length) continue;
    total += hits.length;
    if (filesOnly) { print(f, 'out'); continue; }
    if (count) { print(`${f}:${hits.length}`, 'out'); continue; }
    hits.forEach(h => print(showName ? `${f}:${h.i}:${h.ln}` : `${f}:${h.ln}`, 'info'));
  }
  if (!total && !filesOnly) print('(无匹配)', 'out');
  sfx('text-grep');
}

function cmdShortlog(rest) {
  const ids = Object.keys(G.commits).sort((a, b) => parseInt(b, 16) - parseInt(a, 16));
  if (!ids.length) return print('fatal: 还没有任何提交', 'err');
  const author = (G.config && G.config['user.name']) || 'TermQuest User';
  const groups = {};
  for (const id of ids) { const a = G.commits[id].author || author; (groups[a] = groups[a] || []).push(G.commits[id].msg); }
  for (const a in groups) {
    print(`${String(groups[a].length).padStart(6)}  ${a}`, 'warn');
    if (!rest.includes('-s') && !rest.includes('--summary')) groups[a].forEach(m => print(`      ${m}`, 'out'));
  }
}

function cmdDescribe(rest) {
  const id = G.resolve(rest.filter(a => !a.startsWith('-'))[0] || 'HEAD');
  if (id === undefined) return print('fatal: 无可描述的提交', 'err');
  const tagNames = Object.keys(G.tags);
  for (const t of tagNames) if (G.tags[t] === id) return print(t, 'info');
  // 沿第一父提交回溯找最近的标签
  let cur = id, dist = 0;
  while (cur) {
    const t = tagNames.find(x => G.tags[x] === cur);
    if (t) return print(`${t}-${dist}-g${id.slice(0, 7)}`, 'info');
    const n = G.commits[cur]; cur = n ? n.parents[0] : null; dist++;
  }
  print(id.slice(0, 7), 'info');
}

function cmdArchive(rest) {
  const args = rest.filter(a => !a.startsWith('-'));
  let out = 'archive.tar';
  const oi = rest.indexOf('-o') >= 0 ? rest.indexOf('-o') : rest.indexOf('--output');
  if (oi >= 0 && rest[oi + 1]) out = rest[oi + 1];
  const files = Object.keys(G.headTree());
  print(`已打包 ${files.length} 个文件 → ${out}`, 'ok');
  files.forEach(f => print(`  ${f}`, 'out'));
  after(true);
}

function cmdRevParse(rest) {
  if (rest.includes('--git-dir')) return print('.git', 'out');
  if (rest.includes('--show-toplevel')) return print('/termquest', 'out');
  if (rest.includes('--abbrev-ref')) return print(G.headBranch || 'HEAD', 'out');
  if (rest.includes('--is-inside-work-tree')) return print('true', 'out');
  const arg = rest.filter(a => !a.startsWith('-'))[0] || 'HEAD';
  const id = G.resolve(arg);
  if (id === undefined) return print(`fatal: 无法解析 '${arg}'`, 'err');
  print(id, 'out');
}

function cmdLsFiles(rest) {
  const ht = G.headTree();
  const others = rest.includes('-o') || rest.includes('--others');
  const ignored = rest.includes('-i') || rest.includes('--ignored');
  if (others || ignored) {
    const un = Object.keys(G.files).filter(f => G.index[f] === undefined && ht[f] === undefined);
    if (!un.length) return print('(无未跟踪文件)', 'out');
    un.forEach(f => print(f, 'out')); return;
  }
  const tracked = new Set([...Object.keys(G.index), ...Object.keys(ht)]);
  if (!tracked.size) return print('(暂无跟踪文件)', 'out');
  [...tracked].sort().forEach(f => print(f, 'out'));
}

function cmdShowRef() {
  let any = false;
  for (const b in G.branches) if (G.branches[b]) { print(`${G.branches[b]} refs/heads/${b}`, 'info'); any = true; }
  for (const t in G.tags) if (G.tags[t]) { print(`${G.tags[t]} refs/tags/${t}`, 'info'); any = true; }
  if (!any) print('(无任何引用)', 'out');
}

function cmdFormatPatch(rest) {
  const args = rest.filter(a => !a.startsWith('-'));
  let n = 1;
  const arg = args[0];
  if (arg) { const m = arg.match(/^-(\d+)$/); if (m) n = parseInt(m[1]); }
  let cur = G.headCommit; const list = [];
  while (cur && list.length < n) { list.unshift(cur); cur = G.commits[cur].parents[0]; }
  if (!list.length) return print('fatal: 没有可生成补丁的提交', 'err');
  G.patches = G.patches || [];
  list.forEach((id, i) => {
    const fname = `${String(i + 1).padStart(4, '0')}-${G.commits[id].msg.replace(/[^a-z0-9]+/gi, '-').slice(0, 30)}.patch`;
    G.patches.push(fname);
    print(`已生成 ${fname}`, 'ok');
  });
  after(true);
}

function cmdAm(rest) {
  G.patches = G.patches || [];
  const arg = rest.filter(a => !a.startsWith('-'))[0];
  if (rest.includes('--abort')) { print('已中止补丁应用', 'ok'); return; }
  if (rest.includes('--skip')) { print('已跳过当前补丁', 'out'); return; }
  if (rest.includes('--continue')) { print('补丁应用已继续', 'ok'); return; }
  if (arg) {
    print(`Applying: ${arg}`, 'out');
    print('已应用补丁（模拟：未改动工作区）', 'ok'); after(true); return;
  }
  if (!G.patches.length) return print('用法: git am <补丁文件>（可先用 git format-patch 生成）', 'err');
  G.patches.forEach(p => print(`Applying: ${p}`, 'out'));
  print(`已应用 ${G.patches.length} 个补丁（模拟）`, 'ok'); after(true);
}

function cmdMv(rest) {
  const args = rest.filter(a => !a.startsWith('-'));
  const src = args[0], dst = args[1];
  if (!src || !dst) return print('用法: git mv <源> <目标>', 'err');
  if (G.files[src] === undefined) return print(`fatal: 源文件 '${src}' 不存在`, 'err');
  G.files[dst] = G.files[src]; delete G.files[src];
  if (G.index[src] !== undefined) { G.index[dst] = G.index[src]; delete G.index[src]; }
  print(`已重命名 ${src} → ${dst}（已暂存）`, 'ok'); sfx('file-move'); after(true);
}

function cmdRm(rest) {
  const cached = rest.includes('--cached');
  const force = rest.includes('-f') || rest.includes('--force');
  const files = rest.filter(a => !a.startsWith('-'));
  if (!files.length) return print('用法: git rm [--cached] <文件>', 'err');
  for (const f of files) {
    if (G.files[f] === undefined && G.index[f] === undefined) { print(`fatal: 文件 '${f}' 不存在`, 'err'); continue; }
    if (cached) { delete G.index[f]; print(`rm '${f}'（仅移出暂存区）`, 'out'); }
    else { delete G.files[f]; delete G.index[f]; print(`rm '${f}'`, 'out'); }
  }
  sfx('file-delete'); after(true);
}

function showHelp() {
  ['── 文件 ──', '  echo "内容" > 文件   /   echo "内容" >> 文件', '  ls · cat 文件 · rm 文件', '── Git ──',
    '  git status · git diff [--staged|--name-only|--name-status|--stat|-w|--word-diff] [ref|文件]',
    '  git log [--oneline|--graph|--stat|-p|-n N|--all|--author=|--grep=|-S|--name-only|--pretty=format:]',
    '  git add <文件|.> [-A|-u|-p|--dry-run] · git commit -m "信息" [-a|-v|--dry-run|--amend --no-edit]',
    '  git branch [-v|-a|-r|-m 新名|-d|-D|--contains|--merged|--list] · git switch <分支|-c 新分支>',
    '  git checkout <分支|文件|-b 新分支> · git merge <分支> [--squash|--no-commit|-X ours|theirs|--abort]',
    '  git rebase <分支> [--onto 新基|-i|--abort|--continue] · git cherry-pick <提交>',
    '  git reset [--hard|--soft] HEAD~n · git restore [--staged] <文件> · git clean [-n|-x|-d] -fd',
    '  git revert <提交> · git reflog · git stash [push -m|list|show|pop|apply|drop|clear|branch|-u]',
    '  git tag [名称|-d|-a -m|-l|-n|-f] · git show [提交] · git config [--global|--list|--get|--unset]',
    '  git remote [-v|add|remove|rename|set-url|show|prune] · git clone · git push · git pull · git fetch',
    '── 进阶 ──',
    '  git worktree [list|add|remove] · git bisect [start|bad|good|skip|reset] · git grep <模式>',
    '  git shortlog · git describe · git archive · git rev-parse · git ls-files · git show-ref',
    '  git format-patch · git am · git mv <源> <目标> · git rm [--cached] <文件> · git init', '  clear 清屏'
  ].forEach(l => print(l, 'info'));
}
