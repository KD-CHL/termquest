// 关卡数据 —— 纯数据模块，不依赖任何 DOM / UI
// 每个关卡：setup(g) 初始化引擎状态，check(g) 判定是否通关，
// par 是目标步数（越少星越多），hints 是提示命令。

export function seed(g) {
  g.index['hello.txt'] = 'hello git\n'; g.files['hello.txt'] = 'hello git\n';
  const id = g.newId();
  g.commits[id] = { id, msg: 'first commit', parents: [], tree: g.snap(g.index) };
  g.branches.main = id;
}

export function commitTo(g, branch, msg, tree) {
  g.index = g.snap(tree); g.files = g.snap(tree);
  const id = g.newId();
  g.commits[id] = { id, msg, parents: [g.branches[branch]], tree: g.snap(tree) };
  g.branches[branch] = id;
  return id;
}

export const LEVELS = [
  {
    stage: '01 基础', id: '01', title: '初次提交', par: 3,
    desc: '用 <code>echo "hello git" > hello.txt</code> 创建文件，<code>git add</code> 暂存，再 <code>git commit -m "..."</code> 提交。',
    hints: ['echo "hello git" > hello.txt', 'git add hello.txt', 'git commit -m "first commit"'],
    setup(g) { g.reset(); },
    check(g) { const c = g.commits[g.branches.main]; return c && c.tree['hello.txt'] !== undefined; },
    done: 'add 把文件放入暂存区，commit 把暂存区快照存入仓库——这是 git 的心跳。'
  },
  {
    stage: '01 基础', id: '01', title: '观察状态', par: 5,
    desc: '追加一行到 hello.txt，必须先用 <code>git status</code> 和 <code>git diff</code> 观察变化，再提交。',
    hints: ['echo "more" >> hello.txt', 'git status', 'git diff', 'git add .', 'git commit -m "update"'],
    setup(g) { g.reset(); seed(g); },
    check(g) { return g.used.has('status') && g.used.has('diff') && g.commits[g.branches.main] && g.commits[g.branches.main].tree['hello.txt'] !== 'hello git\n'; },
    done: 'status 告诉你"发生了什么"，diff 告诉你"改了什么"，是每天用得最多的两个命令。'
  },
  {
    stage: '02 撤销', id: '02', title: '撤销工作区修改', par: 2,
    desc: '追加一行到 hello.txt 后反悔了——用 <code>git restore hello.txt</code> 丢弃未暂存的修改（不要提交）。',
    hints: ['echo "oops" >> hello.txt', 'git restore hello.txt'],
    setup(g) { g.reset(); seed(g); },
    check(g) { const c = g.commits[g.branches.main]; return g.used.has('restore') && c && c.tree['hello.txt'] === 'hello git\n' && g.files['hello.txt'] === 'hello git\n'; },
    done: 'restore 把工作区文件恢复到暂存区/HEAD 版本。注意：未暂存的修改 restore 后不可恢复！'
  },
  {
    stage: '02 撤销', id: '02', title: '取消暂存', par: 3,
    desc: '修改 hello.txt 并 <code>git add</code>，再用 <code>git restore --staged hello.txt</code> 移出暂存区（修改保留）。',
    hints: ['echo "change" >> hello.txt', 'git add hello.txt', 'git restore --staged hello.txt'],
    setup(g) { g.reset(); seed(g); },
    check(g) { return g.used.has('add') && g.used.has('restore') && g.index['hello.txt'] === 'hello git\n' && g.files['hello.txt'] !== 'hello git\n'; },
    done: '--staged 只动暂存区不碰工作区，文件回到"已修改未暂存"状态。'
  },
  {
    stage: '02 撤销', id: '02', title: 'amend 补救', par: 3,
    desc: '上一个提交漏掉了 note.txt！创建 <code>note.txt</code> 并 add，然后用 <code>git commit --amend --no-edit</code> 把它补进上一次提交。',
    hints: ['echo "note" > note.txt', 'git add note.txt', 'git commit --amend --no-edit'],
    setup(g) { g.reset(); seed(g); },
    check(g) { const c = g.commits[g.branches.main]; return c && c.tree['note.txt'] !== undefined && c.tree['hello.txt'] !== undefined; },
    done: 'amend 会"重写"上一次提交（生成新 hash）。只用于还没 push 的提交。'
  },
  {
    stage: '02 撤销', id: '02', title: '时光倒流', par: 1,
    desc: '现在有 3 个提交，用 <code>git reset --hard HEAD~1</code> 回退一个提交，丢弃最新改动。',
    hints: ['git log --oneline', 'git reset --hard HEAD~1'],
    setup(g) {
      g.reset(); seed(g);
      commitTo(g, 'main', 'v2', { 'hello.txt': 'hello git\nv2\n' });
      commitTo(g, 'main', 'v3', { 'hello.txt': 'hello git\nv2\nv3\n' });
    },
    check(g) { const c = g.commits[g.branches.main]; return c && c.msg !== 'v3' && g.files['hello.txt'] === 'hello git\nv2\n'; },
    done: '--hard 同时重置暂存区和工作区，威力最大。误删提交可以用 git reflog 找回（见教程 08）。'
  },
  {
    stage: '03 分支', id: '03', title: '创建并切换分支', par: 1,
    desc: '用 <code>git switch -c feature-login</code> 创建并切换到新分支。',
    hints: ['git switch -c feature-login'],
    setup(g) { g.reset(); seed(g); },
    check(g) { return g.headBranch === 'feature-login'; },
    done: 'switch -c = 创建 + 切换。新分支从当前提交出发，改动互不影响。'
  },
  {
    stage: '03 分支', id: '03', title: '分支上开发', par: 3,
    desc: '在 feature-login 分支上创建 login.txt 并提交。main 分支不会受影响。',
    hints: ['echo "login page" > login.txt', 'git add login.txt', 'git commit -m "feat: login"'],
    setup(g) { g.reset(); seed(g); g.branches['feature-login'] = g.branches.main; g.HEAD = 'feature-login'; },
    check(g) {
      const c = g.commits[g.branches['feature-login']];
      return g.headBranch === 'feature-login' && c && c.tree['login.txt'] !== undefined && g.commits[g.branches.main].tree['login.txt'] === undefined;
    },
    done: '提交只属于 feature-login。切回 main 看看，login.txt 并不在那里。'
  },
  {
    stage: '03 分支', id: '03', title: '合并分支', par: 2,
    desc: '切回 main（<code>git switch main</code>），用 <code>git merge feature-login</code> 合并功能。',
    hints: ['git switch main', 'git merge feature-login'],
    setup(g) {
      g.reset(); seed(g);
      g.branches['feature-login'] = g.branches.main; g.HEAD = 'feature-login';
      commitTo(g, 'feature-login', 'feat: login', { 'hello.txt': 'hello git\n', 'login.txt': 'login page\n' });
      g.HEAD = 'main'; const tr = g.headTree(); g.files = g.snap(tr); g.index = g.snap(tr);
    },
    check(g) { const c = g.commits[g.branches.main]; return g.headBranch === 'main' && c && c.tree['login.txt'] !== undefined; },
    done: '这次是 Fast-forward：main 没有新提交，指针直接前移。两边都有新提交时会产生 merge commit。'
  },
  {
    stage: '03 分支', id: '03', title: '精准摘取 cherry-pick', par: 2,
    desc: 'dev 分支上有两个提交，只把添加 <code>fix.txt</code> 的那个（较早的）摘到 main，不要另一个。提示：<code>git log dev --oneline</code> 查看，用 <code>git cherry-pick dev~1</code>。',
    hints: ['git log dev --oneline', 'git cherry-pick dev~1'],
    setup(g) {
      g.reset(); seed(g);
      g.branches['dev'] = g.branches.main;
      commitTo(g, 'dev', 'fix: hotfix', { 'hello.txt': 'hello git\n', 'fix.txt': 'hotfix\n' });
      commitTo(g, 'dev', 'wip: experiment', { 'hello.txt': 'hello git\n', 'fix.txt': 'hotfix\n', 'exp.txt': 'wip\n' });
    },
    check(g) { const c = g.commits[g.branches.main]; return c && c.tree['fix.txt'] !== undefined && c.tree['exp.txt'] === undefined; },
    done: 'cherry-pick 只复制某个提交的"改动"，而不是合并整个分支，适合挑选 hotfix。'
  },
  {
    stage: '03 分支', id: '03', title: '变基 rebase', par: 1,
    desc: 'main 和 feat 各自有新提交。站在 feat 分支上用 <code>git rebase main</code>，把 feat 的提交"搬"到 main 最新提交之后，让历史变成一条直线。',
    hints: ['git rebase main'],
    setup(g) {
      g.reset(); seed(g);
      g.branches['feat'] = g.branches.main;
      commitTo(g, 'main', 'main work', { 'hello.txt': 'hello git\n', 'main.txt': 'main\n' });
      g.HEAD = 'feat'; commitTo(g, 'feat', 'feat work', { 'hello.txt': 'hello git\n', 'feat.txt': 'feat\n' });
    },
    check(g) { return g.headBranch === 'feat' && g.isAncestor(g.branches.main, g.branches['feat']) && g.commits[g.branches['feat']].tree['main.txt'] !== undefined; },
    done: 'rebase 重放了你的提交，历史变成直线且包含 main 的最新内容。记住：不要 rebase 已推送的公共分支。'
  },
  {
    stage: '04 冲突', id: '04', title: '解决合并冲突', par: 4,
    desc: 'main 和 other 分支修改了 story.txt 的同一行。执行 <code>git merge other</code> 会冲突——打开文件会看到 <code><<<<<<</code> 标记，用 <code>echo "..." > story.txt</code> 写入解决后的内容，然后 <code>git add</code> + <code>git commit</code>。',
    hints: ['git merge other', 'echo "resolved content" > story.txt', 'git add story.txt', 'git commit -m "merge: resolve conflict"'],
    setup(g) {
      g.reset();
      g.index['story.txt'] = 'line A\nline B\n'; g.files['story.txt'] = 'line A\nline B\n';
      const id = g.newId();
      g.commits[id] = { id, msg: 'base story', parents: [], tree: g.snap(g.index) }; g.branches.main = id;
      g.branches['other'] = id;
      commitTo(g, 'main', 'main edit', { 'story.txt': 'main change\nline B\n' });
      g.HEAD = 'other'; commitTo(g, 'other', 'other edit', { 'story.txt': 'other change\nline B\n' });
      g.HEAD = 'main'; const tr = g.headTree(); g.files = g.snap(tr); g.index = g.snap(tr);
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return !g.mergeInProgress && c && c.parents.length === 2 && !g.files['story.txt'].includes('<<<<<<<');
    },
    done: '冲突不可怕：编辑文件去掉标记 → add → commit。解不了随时 git merge --abort 回到合并前。'
  },
  {
    stage: '05 暂存与标签', id: '05', title: '临时 stash', par: 3,
    desc: '改到一半（追加一行到 hello.txt）要切分支修 bug。用 <code>git stash</code> 保存现场，再 <code>git stash pop</code> 恢复。',
    hints: ['echo "wip" >> hello.txt', 'git stash', 'git stash pop'],
    setup(g) { g.reset(); seed(g); },
    check(g) { return g.used.has('stash') && g.stash.length === 0 && g.files['hello.txt'] !== 'hello git\n'; },
    done: 'stash 把工作区"收进抽屉"，pop 取出并删除记录，多任务切换的救命稻草。'
  },
  {
    stage: '05 暂存与标签', id: '05', title: '发布打标签', par: 1,
    desc: '项目稳定了，给当前提交打上版本标签 <code>git tag v1.0.0</code>，再用 <code>git tag</code> 确认。',
    hints: ['git tag v1.0.0', 'git tag'],
    setup(g) { g.reset(); seed(g); commitTo(g, 'main', 'release prep', { 'hello.txt': 'hello git\nfinal\n' }); },
    check(g) { return g.tags['v1.0.0'] !== undefined; },
    done: '标签是不可变的版本快照点，真实项目用 git tag -a v1.0.0 -m "..." 创建附注标签。准备好进入高级篇了吗？'
  },
  {
    stage: '06 高级', id: '06', title: '撤销已发布的提交 revert', par: 1,
    desc: 'feature.txt 所在的提交已经"发布"了，不能再用 reset 改写历史。用 <code>git revert HEAD</code> 生成一个新提交，反向抵消上一次提交的改动。',
    hints: ['git log --oneline', 'git revert HEAD'],
    setup(g) {
      g.reset(); seed(g);
      commitTo(g, 'main', 'feat: add feature', { 'hello.txt': 'hello git\n', 'feature.txt': 'shiny feature\n' });
    },
    check(g) {
      const head = g.commits[g.branches.main];
      return g.used.has('revert') && head && head.tree['feature.txt'] === undefined
        && head.tree['hello.txt'] !== undefined && head.msg.startsWith('Revert');
    },
    done: 'revert 不删除历史，而是新增一个"反向提交"。这是撤销已 push 提交的标准做法——对协作友好。'
  },
  {
    stage: '06 高级', id: '06', title: 'reflog 找回丢失的提交', par: 2,
    desc: '糟糕！刚才误执行了 <code>git reset --hard HEAD~1</code>，提交 "important work" 从分支上消失了。别慌：先用 <code>git reflog</code> 查看 HEAD 的移动历史，找到丢失提交的 hash，再用 <code>git reset --hard &lt;hash&gt;</code> 把它找回来。',
    hints: ['git reflog', 'git reset --hard <丢失提交的 hash 前 7 位>'],
    setup(g) {
      g.reset(); seed(g);
      const a = g.branches.main;
      const b = commitTo(g, 'main', 'add feature', { 'hello.txt': 'hello git\n', 'feature.txt': 'f\n' });
      const c = commitTo(g, 'main', 'important work', { 'hello.txt': 'hello git\n', 'feature.txt': 'f\n', 'report.txt': 'precious\n' });
      // 模拟误操作 reset --hard HEAD~1：main 回退到 b，c "丢失"
      g.branches.main = b;
      const tr = g.snap(g.commits[b].tree); g.files = tr; g.index = g.snap(tr);
      // 补上 reflog（最新在前），还原真实事故现场
      g.reflog = [
        { hash: b, action: 'reset (hard): moving to HEAD~1' },
        { hash: c, action: 'commit: important work' },
        { hash: b, action: 'commit: add feature' },
        { hash: a, action: 'commit (initial): first commit' },
      ];
    },
    check(g) {
      const head = g.commits[g.branches.main];
      return g.used.has('reflog') && g.used.has('reset') && head && head.msg === 'important work';
    },
    done: '只要提交过，git 几乎不会真的"弄丢"它。reflog 记录 HEAD 的每次移动（默认保留 90 天），是误删提交后的救命稻草。'
  },
  {
    stage: '06 高级', id: '06', title: 'soft reset 压缩提交', par: 2,
    desc: 'main 上最近两个提交是同一功能的碎片。用 <code>git reset --soft HEAD~2</code> 回退指针但保留改动，再 <code>git commit -m "feat: complete feature"</code> 把它们压缩成一个干净的提交。',
    hints: ['git reset --soft HEAD~2', 'git commit -m "feat: complete feature"'],
    setup(g) {
      g.reset(); seed(g);
      commitTo(g, 'main', 'feat: part 1', { 'hello.txt': 'hello git\n', 'part1.txt': 'part 1\n' });
      commitTo(g, 'main', 'feat: part 2', { 'hello.txt': 'hello git\n', 'part1.txt': 'part 1\n', 'part2.txt': 'part 2\n' });
    },
    check(g) {
      const head = g.commits[g.branches.main];
      if (!head || !g.used.has('reset') || !g.used.has('commit')) return false;
      let n = 0, c = g.branches.main;
      while (c) { n++; c = g.commits[c].parents[0]; }
      return n === 2 && head.tree['part1.txt'] !== undefined && head.tree['part2.txt'] !== undefined;
    },
    done: '--soft 只移动分支指针，改动留在暂存区，配合 commit 就能把多个提交压缩成一个——整理提交历史的必备技能。'
  },

  /* ============ 07 洞察 ============ */
  {
    stage: '07 洞察', id: '07', title: '图谱纵览', par: 5,
    desc: 'main 和 feat 分支已经分叉。用 <code>git log --graph --all</code> 画出全部分支的 ASCII 图谱，用 <code>git log --stat</code> 查看每个提交改了哪些文件，然后把审查笔记写入 review.txt 并提交。',
    hints: ['git log --graph --all', 'git log --stat', 'echo "history reviewed" > review.txt', 'git add review.txt', 'git commit -m "review history"'],
    setup(g) {
      g.reset(); seed(g);
      commitTo(g, 'main', 'v2', { 'hello.txt': 'hello git\nv2\n' });
      g.branches['feat'] = g.branches.main;
      commitTo(g, 'feat', 'feat: experiment', { 'hello.txt': 'hello git\nv2\n', 'exp.txt': 'try\n' });
      g.HEAD = 'main'; const tr = g.headTree(); g.files = g.snap(tr); g.index = g.snap(tr);
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('log') && g.headBranch === 'main' && c && c.msg === 'review history' && c.tree['review.txt'] !== undefined;
    },
    done: '--graph 把分叉与合并画成泳道图，--stat 逐个提交列出文件改动，--all 则把每个分支都纳入视野。'
  },
  {
    stage: '07 洞察', id: '07', title: '暂存区透视', par: 5,
    desc: '修改 hello.txt 并 <code>git add</code>，用 <code>git diff --staged</code> 审查"即将被提交的内容"；接着再改 app.txt，用 <code>git commit -am "..."</code> 自动暂存所有已跟踪文件的修改并一次提交。',
    hints: ['echo "v2" >> hello.txt', 'git add hello.txt', 'git diff --staged', 'echo "patch" >> app.txt', 'git commit -am "batch update"'],
    setup(g) {
      g.reset(); seed(g);
      commitTo(g, 'main', 'add app', { 'hello.txt': 'hello git\n', 'app.txt': 'v1\n' });
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('diff') && g.used.has('commit') && c && c.msg === 'batch update' &&
        c.tree['hello.txt'].includes('v2') && c.tree['app.txt'].includes('patch');
    },
    done: 'git diff 看"工作区 vs 暂存区"，git diff --staged 看"暂存区 vs HEAD"；commit -a 省去逐个 add 已跟踪文件的步骤。'
  },

  /* ============ 08 整理 ============ */
  {
    stage: '08 整理', id: '08', title: '命名暂存与丢弃', par: 4,
    desc: '改到一半（追加一行到 hello.txt）要去做别的事。用 <code>git stash push -m "wip: login"</code> 存一条带备注的暂存，<code>git stash list</code> 确认后，决定这次改动不要了——用 <code>git stash drop</code> 丢弃它。',
    hints: ['echo "wip" >> hello.txt', 'git stash push -m "wip: login"', 'git stash list', 'git stash drop'],
    setup(g) { g.reset(); seed(g); },
    check(g) {
      return g.used.has('stash') && g.stash.length === 0 && g.files['hello.txt'] === 'hello git\n';
    },
    done: 'push -m 让每条 stash 都有名字，show 可以预览内容，drop 则把最新一条彻底扔掉。'
  },
  {
    stage: '08 整理', id: '08', title: '清理标签与杂物', par: 3,
    desc: '打错的标签 <code>beta</code> 用 <code>git tag -d beta</code> 删除；工作区还散落着调试产生的未跟踪文件（debug.log、core.dump），用 <code>git clean -fd</code> 一次性清理干净。',
    hints: ['git tag -d beta', 'git clean -fd', 'git status'],
    setup(g) {
      g.reset(); seed(g);
      g.tags['beta'] = g.branches.main;
      g.files['debug.log'] = 'temp debug\n';
      g.files['core.dump'] = 'dump\n';
    },
    check(g) {
      return g.used.has('tag') && g.used.has('clean') &&
        g.tags['beta'] === undefined && g.files['debug.log'] === undefined && g.files['core.dump'] === undefined;
    },
    done: 'tag -d 删除打错的标签，clean -fd 清空未跟踪文件——前者安全，后者不可恢复，执行前最好先 git status 看一眼。'
  },

  /* ============ 09 远程 ============ */
  {
    stage: '09 远程', id: '09', title: '克隆推送拉取', par: 6,
    desc: '团队仓库在 <code>https://git.example.com/app.git</code>（模拟环境预设）。先 <code>git clone</code> 克隆（会带上队友的 util.js），新建 fix.txt 提交后 <code>git push</code> 推送，最后 <code>git pull</code> 确认与远程同步。',
    hints: ['git clone https://git.example.com/app.git', 'echo "hotfix" > fix.txt', 'git add fix.txt', 'git commit -m "fix: patch"', 'git push', 'git pull'],
    setup(g) {
      g.reset();
      g.remotes = {}; g.remoteStores = {};
      g.index['app.js'] = g.files['app.js'] = 'console.log("v1");\n';
      const a = g.newId();
      g.commits[a] = { id: a, msg: 'init', parents: [], tree: g.snap(g.index) };
      const b = g.newId();
      g.commits[b] = { id: b, msg: 'team: add util', parents: [a], tree: { 'app.js': 'console.log("v1");\n', 'util.js': 'export const util = 1;\n' } };
      g.remoteStores['https://git.example.com/app.git'] = { branches: { main: b } };
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('clone') && g.used.has('push') && g.used.has('pull') &&
        g.files['util.js'] !== undefined && c && c.tree['fix.txt'] !== undefined &&
        g.remotes.origin && g.remotes.origin.branches.main === g.branches.main;
    },
    done: 'clone 拉下整个仓库，push 上传本地提交，pull 快进合并远程更新——团队协作的三板斧。'
  },
];
