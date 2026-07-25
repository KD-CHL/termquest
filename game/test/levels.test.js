// Node 可解性测试 —— 在 Node 里模拟 DOM，逐关执行题解命令并断言 check() 通过
// 运行：npm test  （或 node test/levels.test.js）
// 说明：游戏模块本为浏览器设计，这里用最小 DOM mock 让其在 Node 中可被 import。
// 覆盖全部 4 个模块（git / linux / shellgit / ops）共 47 关。

/* ============ 最小 DOM mock（必须在 import 游戏模块之前就位） ============ */
function makeCtx() {
  return new Proxy({}, {
    get: () => () => {},
    set: () => true,
  });
}
function makeEl() {
  return {
    innerHTML: '', textContent: '', value: '',
    style: {}, hidden: false, scrollTop: 0, scrollHeight: 0, width: 0, height: 0,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    insertAdjacentHTML() {}, getContext: makeCtx,
    addEventListener() {}, focus() {},
  };
}
const els = {};
globalThis.document = {
  getElementById: id => els[id] || (els[id] = makeEl()),
  addEventListener() {},
  activeElement: null,
};
globalThis.addEventListener = () => {};
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis;

/* ============ 动态导入游戏模块 ============ */
const { app } = await import('../js/state.js');
const { getModules } = await import('../js/modules.js');
const { renderGraph } = await import('../js/graph.js');

/* ============ 每题的题解命令序列（按模块 id 分组） ============
 * 元素可以是：字符串数组，或 fn(engine) => 字符串数组（用于动态命令）。
 */
const SOLUTIONS = {
  // ── Git 闯关（17 关）──
  git: [
    ['echo "hello git" > hello.txt', 'git add hello.txt', 'git commit -m "first commit"'],
    ['echo "more" >> hello.txt', 'git status', 'git diff', 'git add .', 'git commit -m "update"'],
    ['echo "oops" >> hello.txt', 'git restore hello.txt'],
    ['echo "change" >> hello.txt', 'git add hello.txt', 'git restore --staged hello.txt'],
    ['echo "note" > note.txt', 'git add note.txt', 'git commit --amend --no-edit'],
    ['git reset --hard HEAD~1'],
    ['git switch -c feature-login'],
    ['echo "login page" > login.txt', 'git add login.txt', 'git commit -m "feat: login"'],
    ['git switch main', 'git merge feature-login'],
    ['git cherry-pick dev~1'],
    ['git rebase main'],
    ['git merge other', 'echo "resolved content" > story.txt', 'git add story.txt', 'git commit -m "merge: resolve conflict"'],
    ['echo "wip" >> hello.txt', 'git stash', 'git stash pop'],
    ['git tag v1.0.0'],
    ['git revert HEAD'],
    // reflog 关卡：丢失提交的 hash 是动态的，从引擎状态里找出来
    g => ['git reflog', `git reset --hard ${Object.keys(g.commits).find(id => g.commits[id].msg === 'important work').slice(0, 7)}`],
    ['git reset --soft HEAD~2', 'git commit -m "feat: complete feature"'],
  ],
  // ── Linux 基础（12 关）──
  linux: [
    ['mkdir projects', 'touch projects/readme.md', 'ls projects'],
    ['cp notes.txt docs/', 'mv data.csv users.csv', 'ls'],
    ['echo "buy milk" > todo.txt', 'cat todo.txt', 'echo "walk dog" >> todo.txt', 'cat todo.txt'],
    ['echo "#!/bin/bash" > secret.sh', 'chmod +x secret.sh', 'ln -s secret.sh run', 'ls -l'],
    ['grep ERROR server.log', 'grep ERROR server.log | wc -l'],
    ['echo "apple" > fruits.txt', 'echo "banana" >> fruits.txt', 'echo "apple" >> fruits.txt', 'sort fruits.txt | uniq'],
    ['grep is notes.txt | wc -l'],
    ['cut -d , -f 1 data.csv | sort'],
    ['ps aux', 'top'],
    // kill 关卡：PID 是动态的，从进程表里找 sleep 999
    e => ['ps aux', `kill ${e.procs.find(p => p.cmd === 'sleep 999').pid}`],
    ['sleep 60 &', 'jobs', 'fg'],
    ['mkdir report', 'grep ERROR server.log > report/errors.txt', 'grep ERROR server.log | wc -l > report/count.txt', 'sleep 10 &'],
  ],
  // ── Shell × Git（8 关）──
  shellgit: [
    [`sed -i 's/teh/the/g' README.md`, 'git add README.md', 'git commit -m "fix typo"'],
    ['grep debug config.ini', `sed -i 's/debug=true/debug=false/' config.ini`, 'git add config.ini', 'git commit -m "disable debug"'],
    ['echo "v1.1: 修复若干问题" >> CHANGELOG.md', 'cat CHANGELOG.md', 'git add CHANGELOG.md', 'git commit -m "update changelog"'],
    ['echo "note" > note.txt', 'echo "git add ." > commit.sh', 'echo "git commit -m \\"auto\\"" >> commit.sh', 'bash commit.sh'],
    ['echo "echo A > a.txt" > gen.sh', 'echo "echo B > b.txt" >> gen.sh', 'echo "echo C > c.txt" >> gen.sh', 'bash gen.sh', 'ls'],
    [`echo "sed -i 's/colour/color/g' en1.txt" > fix.sh`, `echo "sed -i 's/colour/color/g' en2.txt" >> fix.sh`, 'bash fix.sh', 'git add .', 'git commit -m "normalize spelling"'],
    ['grep ERROR app.log | wc -l > report.txt', 'git add report.txt', 'git commit -m "add error report"'],
    ['echo "echo v2.0 > version.txt" > release.sh', 'echo "git add version.txt" >> release.sh', 'echo "git commit -m \\"release v2.0\\"" >> release.sh', 'bash release.sh', 'git log --oneline'],
  ],
  // ── Docker 运维（10 关）──
  ops: [
    ['docker pull nginx:alpine', 'docker run -d --name web nginx:alpine', 'docker ps'],
    ['docker stop old-app', 'docker rm old-app'],
    ['docker ps', 'docker logs api'],
    ['docker run -d --name site -p 8080:80 nginx:alpine', 'docker ps'],
    ['echo "FROM node:18" > Dockerfile', 'echo "CMD node app.js" >> Dockerfile', 'docker build -t myapp:1.0 .'],
    ['docker build -t mysite:1.0 .', 'docker run -d --name site mysite:1.0', 'docker ps'],
    ['docker tag myapp:1.0 myapp:latest', 'docker rmi myapp:1.0', 'docker images'],
    ['docker-compose up -d', 'docker-compose ps'],
    ['ssh user@prod-server', 'cat /var/log/app.log', 'exit'],
    ['scp backup.sql user@prod-server:/tmp/', 'ssh user@prod-server ls /tmp'],
  ],
};

let pass = 0, fail = 0, gi = 0;
for (const mod of getModules()) {
  const sols = SOLUTIONS[mod.id] || [];
  // linux/docker 的 execute 通过 app.engine 取引擎；git/shellgit 直接用 G
  app.engine = mod.engine;
  app.currentModule = mod;
  console.log(`\n══ ${mod.icon} ${mod.name}（${mod.levels.length} 关）══`);
  mod.levels.forEach((lv, i) => {
    gi++;
    const raw = sols[i];
    if (!raw) { console.error(`✗ #${String(gi).padStart(2)} 缺少题解`); fail++; return; }
    lv.setup(mod.engine);
    mod.engine.used = new Set();
    const sol = typeof raw === 'function' ? raw(mod.engine) : raw;
    for (const cmd of sol) mod.execute(cmd);
    const ok = lv.check(mod.engine);
    // 对使用 git 图谱的模块冒烟测试渲染不抛错
    let graphOk = true;
    if (mod.id === 'git' || mod.id === 'shellgit') {
      try { renderGraph(); } catch (e) { graphOk = false; }
    }
    if (ok && graphOk) { console.log(`✓ #${String(gi).padStart(2)} 「${lv.title}」 通过（${sol.length} 步）`); pass++; }
    else { console.error(`✗ #${String(gi).padStart(2)} 「${lv.title}」 失败 check=${ok} graph=${graphOk}`); fail++; }
  });
}

const total = gi;
console.log(`\n${pass}/${total} 关通过${fail ? `，${fail} 关失败` : '，全部可解 🎉'}`);
process.exit(fail ? 1 : 0);
