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
    switch: cmdSwitch, checkout: cmdSwitch, merge: cmdMerge, reset: cmdReset, restore: cmdRestore,
    stash: cmdStash, tag: cmdTag, show: cmdShow, 'cherry-pick': cmdCherryPick, rebase: cmdRebase,
    revert: cmdRevert, reflog: cmdReflog
  }[sub];
  if (!fn) { sfx('err-syntax'); return print(`git ${sub}: 暂不支持`, 'err'); }
  track('git ' + sub);
  fn(rest);
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
  if (!rest.length) return print('用法: git add <文件> 或 git add .', 'err');
  const targets = (rest[0] === '.' || rest[0] === '-A') ? Object.keys(G.files) : rest; let n = 0;
  for (const f of targets) {
    if (G.files[f] !== undefined) {
      G.index[f] = G.files[f]; n++;
      if (G.mergeInProgress && G.mergeInProgress.conflictFiles.has(f) && !G.files[f].includes('<<<<<<<'))
        G.mergeInProgress.conflictFiles.delete(f);
    } else print(`error: pathspec '${f}' did not match`, 'err');
  }
  if (n) print(`已暂存 ${n} 个文件`, 'out'); sfx('file-create'); after(true);
}

function cmdCommit(rest) {
  let msg = null; for (let i = 0; i < rest.length; i++) if (rest[i] === '-m') msg = rest[i + 1];
  const amend = rest.includes('--amend'), noEdit = rest.includes('--no-edit');
  const ht = G.headTree();
  const changed = Object.keys(G.index).some(f => G.index[f] !== ht[f]) || Object.keys(ht).some(f => G.index[f] === undefined);
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
  if (!changed && !amend) return print('nothing to commit, working tree clean', 'warn');
  if (amend && !G.headCommit) return print('fatal: 没有可修改的提交', 'err');
  if (!msg && !(amend && noEdit)) msg = msg || (amend ? G.commits[G.headCommit].msg : 'commit ' + G.newId());
  if (amend && noEdit) msg = G.commits[G.headCommit].msg;
  const parents = amend ? G.commits[G.headCommit].parents : (G.headCommit ? [G.headCommit] : []);
  const id = G.newId();
  G.commits[id] = { id, msg, parents, tree: G.snap(G.index) };
  if (G.headBranch) G.branches[G.headBranch] = id; else G.HEAD = { detached: id };
  G.pushReflog(id, `commit${amend ? ' (amend)' : ''}: ${msg}`);
  print(`[${G.headBranch || 'detached'} ${id.slice(0, 7)}] ${msg}`, 'ok'); sfxOk(); after(true);
}

function cmdLog(rest) {
  const oneline = rest.includes('--oneline');
  const ref = rest.filter(a => !a.startsWith('--'))[0];
  let cur = ref ? G.resolve(ref) : G.headCommit;
  if (ref && cur === undefined) return print(`fatal: 无法解析 '${ref}'`, 'err');
  if (!cur) return print('fatal: 还没有任何提交', 'err');
  while (cur) {
    const c = G.commits[cur];
    if (oneline) print(`${cur.slice(0, 7)} ${c.msg}`, 'info');
    else { print(`commit ${cur}`, 'warn'); print(`    ${c.msg}`, 'out'); }
    cur = c.parents[0];
  }
}

function cmdDiff() {
  const ht = G.headTree(); let any = false;
  for (const f in G.files) {
    const base = G.index[f] !== undefined ? G.index[f] : ht[f];
    if (base !== undefined && G.files[f] !== base) {
      any = true;
      print(`diff --git a/${f} b/${f}`, 'info'); print(`--- a/${f}`, 'out'); print(`+++ b/${f}`, 'out');
      print(`- ${base.trim()}`, 'err'); print(`+ ${G.files[f].trim()}`, 'ok');
    }
  }
  if (!any) print('(无差异)', 'out');
}

function cmdBranch(rest) {
  if (!rest.length) {
    for (const b in G.branches) print(`${b === G.headBranch ? '*' : ' '} ${b}`, b === G.headBranch ? 'ok' : 'out');
    return;
  }
  if (rest[0] === '-d' || rest[0] === '-D') {
    const n = rest[1];
    if (G.branches[n] === undefined) return print(`error: 分支 '${n}' 不存在`, 'err');
    if (n === G.headBranch) return print('error: 不能删除当前分支', 'err');
    delete G.branches[n]; print(`Deleted branch ${n}`, 'ok'); after(false); return;
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
  const name = rest[0];
  if (!name) return print('用法: git merge <分支>', 'err');
  if (rest.includes('--abort')) {
    if (!G.mergeInProgress) return print('fatal: 没有进行中的合并', 'err');
    const mp = G.mergeInProgress; G.mergeInProgress = null;
    G.files = G.snap(mp.preFiles); G.index = G.snap(mp.preIndex);
    print('已放弃合并，恢复到合并前状态', 'ok'); after(false); return;
  }
  if (G.mergeInProgress) return print('error: 有未完成的合并，先解决冲突或 git merge --abort', 'err');
  if (G.branches[name] === undefined) return print(`merge: ${name} - not something we can merge`, 'err');
  const target = G.branches[name], cur = G.headCommit;
  if (target === cur) return print('Already up to date.', 'out');
  if (G.isAncestor(cur, target)) {
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
  if (conflicts.length) {
    G.mergeInProgress = { target, branch: name, ourHead: cur, conflictFiles: new Set(conflicts), preFiles: G.snap(G.files), preIndex: G.snap(G.index) };
    for (const f of conflicts)
      G.files[f] = `<<<<<<< HEAD\n${our[f].trim()}\n=======\n${their[f].trim()}\n>>>>>>> ${name}\n`;
    print(`Auto-merging ${conflicts.join(', ')}`, 'out');
    print(`CONFLICT (content): Merge conflict in ${conflicts.join(', ')}`, 'err');
    print('Automatic merge failed; fix conflicts and then commit the result.', 'err'); sfxErr();
    after(false); return;
  }
  const tree = G.snap(their); for (const f in our) if (tree[f] === undefined) tree[f] = our[f];
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
  if (sub === 'list') {
    if (!G.stash.length) return print('(stash 为空)', 'out');
    G.stash.forEach((s, i) => print(`stash@{${i}}: ${s.msg}`, 'info')); return;
  }
  if (sub === 'pop' || sub === 'apply') {
    if (!G.stash.length) return print('No stash entries found.', 'err');
    const s = G.stash[0]; G.files = G.snap(s.files); G.index = G.snap(s.index);
    if (sub === 'pop') G.stash.shift();
    print('已恢复暂存的工作', 'ok'); sfx('ui-open'); after(true); return;
  }
  const ht = G.headTree();
  const dirty = JSON.stringify(G.files) !== JSON.stringify(ht) || JSON.stringify(G.index) !== JSON.stringify(ht);
  if (!dirty) return print('No local changes to save', 'warn');
  G.stash.unshift({ files: G.snap(G.files), index: G.snap(G.index), msg: `WIP on ${G.headBranch || 'detached'}` });
  G.files = G.snap(ht); G.index = G.snap(ht);
  print('Saved working directory and index state', 'ok'); sfx('ui-close'); after(true);
}

function cmdTag(rest) {
  const args = rest.filter(a => a !== '-a' && a !== '-m');
  if (!rest.length) {
    const n = Object.keys(G.tags);
    if (!n.length) return print('(暂无标签)', 'out'); n.forEach(x => print(x, 'info')); return;
  }
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
  const target = G.resolve(rest[0]);
  if (target === undefined) return print(`fatal: 无法解析 '${rest[0]}'`, 'err');
  const cur = G.headCommit;
  if (G.isAncestor(cur, target)) return print(`Current branch ${G.headBranch} is up to date.`, 'out');
  const anc = new Set(); let a = target; while (a) { anc.add(a); a = G.commits[a].parents[0]; }
  const chain = []; let c = cur;
  while (c && !anc.has(c)) { chain.unshift(c); c = G.commits[c].parents[0]; }
  if (!chain.length) return print(`Current branch ${G.headBranch} is up to date.`, 'out');
  let base = target;
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

function showHelp() {
  ['── 文件 ──', '  echo "内容" > 文件   /   echo "内容" >> 文件', '  ls · cat 文件 · rm 文件', '── Git ──',
    '  git status · git diff · git log [--oneline] [分支]', '  git add <文件|.> · git commit -m "信息" [--amend --no-edit]',
    '  git branch [名|-d] · git switch <分支|-c 新分支>', '  git merge <分支> [--abort] · git rebase <分支> · git cherry-pick <提交>',
    '  git reset [--hard|--soft] HEAD~n · git restore [--staged] <文件>', '  git revert <提交> · git reflog · git stash [list|pop] · git tag [名称] · git show [提交]', '  clear 清屏'
  ].forEach(l => print(l, 'info'));
}
