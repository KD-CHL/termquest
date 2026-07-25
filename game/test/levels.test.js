// Node 可解性测试 —— 在 Node 里模拟 DOM，逐关执行题解命令并断言 check() 通过
// 运行：npm test  （或 node test/levels.test.js）
// 说明：游戏模块本为浏览器设计，这里用最小 DOM mock 让其在 Node 中可被 import。
// 覆盖全部 10 个模块（git / linux / shellgit / ops / net / text / sys / vim / db / k8s）共 148 关。

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
  // ── Git 闯关（22 关）──
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
    // ── 新增：洞察 / 整理 / 远程（5 关）──
    ['git log --graph --all', 'git log --stat', 'echo "history reviewed" > review.txt', 'git add review.txt', 'git commit -m "review history"'],
    ['echo "v2" >> hello.txt', 'git add hello.txt', 'git diff --staged', 'echo "patch" >> app.txt', 'git commit -am "batch update"'],
    ['echo "wip" >> hello.txt', 'git stash push -m "wip: login"', 'git stash list', 'git stash drop'],
    ['git tag -d beta', 'git clean -fd', 'git status'],
    ['git clone https://git.example.com/app.git', 'echo "hotfix" > fix.txt', 'git add fix.txt', 'git commit -m "fix: patch"', 'git push', 'git pull'],
  ],
  // ── Linux 基础（17 关）──
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
    // ── 新增：进阶探查（5 关）──
    ['ls', 'ls -la'],
    ['grep -r NEEDLE src'],
    ['grep -c ERROR server.log', 'grep -l is notes.txt'],
    ['sort -t , -k 2 -n data.csv'],
    ['which grep', 'stat data.csv', 'basename /home/user/docs/notes.txt', 'dirname /home/user/docs/notes.txt'],
  ],
  // ── Shell × Git（11 关）──
  shellgit: [
    [`sed -i 's/teh/the/g' README.md`, 'git add README.md', 'git commit -m "fix typo"'],
    ['grep debug config.ini', `sed -i 's/debug=true/debug=false/' config.ini`, 'git add config.ini', 'git commit -m "disable debug"'],
    ['echo "v1.1: 修复若干问题" >> CHANGELOG.md', 'cat CHANGELOG.md', 'git add CHANGELOG.md', 'git commit -m "update changelog"'],
    ['echo "note" > note.txt', 'echo "git add ." > commit.sh', 'echo "git commit -m \\"auto\\"" >> commit.sh', 'bash commit.sh'],
    ['echo "echo A > a.txt" > gen.sh', 'echo "echo B > b.txt" >> gen.sh', 'echo "echo C > c.txt" >> gen.sh', 'bash gen.sh', 'ls'],
    [`echo "sed -i 's/colour/color/g' en1.txt" > fix.sh`, `echo "sed -i 's/colour/color/g' en2.txt" >> fix.sh`, 'bash fix.sh', 'git add .', 'git commit -m "normalize spelling"'],
    ['grep ERROR app.log | wc -l > report.txt', 'git add report.txt', 'git commit -m "add error report"'],
    ['echo "echo v2.0 > version.txt" > release.sh', 'echo "git add version.txt" >> release.sh', 'echo "git commit -m \\"release v2.0\\"" >> release.sh', 'bash release.sh', 'git log --oneline'],
    // ── 新增：文本进阶（3 关）──
    ['grep -l timeout errors.log', 'grep -n timeout errors.log > hits.txt', 'git add hits.txt', 'git commit -m "locate timeout"'],
    [`awk -F, '$2 > 28 {print $1}' members.csv`, `awk -F, '$2 > 28 {print $1}' members.csv > seniors.txt`, 'git add seniors.txt', 'git commit -m "senior members"'],
    [`sed -i '2d' config.txt`, 'cat config.txt', 'sort -k 2 -n users.txt > ranked.txt', 'git add .', 'git commit -m "cleanup"'],
  ],
  // ── Docker 运维（14 关）──
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
    // ── 新增：进阶运维（4 关）──
    ['docker run -d --name cache -e REDIS_PORT=6380 -v redis-data:/data redis:7', 'docker inspect cache'],
    ['docker ps -a', 'docker ps --filter name=web -q'],
    ['docker ps -a', 'docker system prune -f', 'docker ps -a'],
    ['cat Dockerfile.prod', 'docker build -t myapp:prod -f Dockerfile.prod .', 'docker history myapp:prod'],
  ],
  // ── 网络工具（14 关）──
  net: [
    ['ping example.com', 'ping -c 3 mysite.local'],
    ['ping -c 2 down-server.local', 'traceroute down-server.local'],
    ['dig example.com', 'dig example.com MX'],
    ['dig +short api.github.com', 'nslookup mysite.local', 'host db.internal'],
    ['curl http://example.com', 'curl -I http://example.com'],
    ['curl https://api.github.com/users/octocat', 'curl -o user.json https://api.github.com/users/octocat', 'cat user.json'],
    ['wget http://example.com/robots.txt', 'ls', 'cat robots.txt'],
    ['nc -zv mysite.local 22', 'nc -zv mysite.local 80', 'nc -zv mysite.local 9999'],
    ['ss -tlnp', 'netstat -an'],
    ['ssh-keygen -t rsa', 'cat ~/.ssh/id_rsa.pub', 'ip addr', 'curl http://mysite.local/health'],
    // ── 新增：网络进阶（4 关）──
    ['curl -X POST -d "user=alice&pass=s3cret" http://mysite.local/login', 'curl -H "Content-Type: application/json" -d \'{"user":"alice"}\' http://mysite.local/login'],
    ['dig example.com MX', 'dig -x 93.184.216.34', 'dig -x 10.0.0.5 +short'],
    ['arp -n', 'route -n', 'ip neigh'],
    ['ss -tlnp', 'ss -anp'],
  ],
  // ── 文本处理（16 关）──
  text: [
    ['find . -name "*.csv"', 'find . -name "config*"'],
    ['find . -type f', 'find . -type f | wc -l'],
    ['ls', 'find . -name "*.tmp" | xargs rm', 'ls'],
    ['cat people.csv', `awk -F, '$2 > 28 {print $1}' people.csv`],
    ['cat sales.txt', `awk '{sum+=$2} END {print sum}' sales.txt`],
    ['cat config.txt', `sed -i '2d' config.txt`, 'cat config.txt'],
    [`sed -n '3p' poem.txt`, `sed '/two/d' poem.txt`],
    ['paste names.txt scores.txt', 'join names.txt scores.txt'],
    ['cat v1.conf', 'cat v2.conf', 'diff v1.conf v2.conf'],
    ['grep beijing people.csv | wc -l', `awk -F, '{print $3}' people.csv | sort | uniq -c`],
    // ── 新增：进阶工具箱（6 关）──
    ['find . -iname "*.log"', 'find . -maxdepth 1 -iname "*.log"'],
    ['find . -name "*.bak"', 'find . -name "*.bak" -delete', 'ls'],
    ['cat people.csv', 'awk -F, -v title=AgeReport \'BEGIN {printf "== %s ==\\n", title} {printf "%s is %d years old\\n", $1, $2}\' people.csv'],
    ['sed -i \'1a\\# version 2\' config.txt', 'sed -i \'/timeout/a\\retries=3\' config.txt', 'cat config.txt'],
    ['cat users.json', 'jq .members users.json', 'jq .members[0].name users.json'],
    ['diff plan-old.txt plan-new.txt', 'diff -u plan-old.txt plan-new.txt'],
  ],
  // ── 系统管理（15 关）──
  sys: [
    ['useradd dev', 'passwd dev', 'id dev'],
    ['sudo systemctl restart nginx', 'systemctl status nginx'],
    ['systemctl start mysql', 'systemctl enable mysql', 'systemctl list-units'],
    ['journalctl -u mysql', 'journalctl -u mysql -p err'],
    ['df', 'du -sh /data', 'du -sh project'],
    ['lsblk', 'mkdir -p /mnt/backup', 'mount /dev/sdc1 /mnt/backup'],
    ['tar -czf project.tar.gz project', 'tar -tf project.tar.gz'],
    ['echo "0 2 * * * /usr/local/bin/backup.sh" > mycron', 'crontab mycron', 'crontab -l'],
    ['free', 'uptime', 'lsof'],
    ['useradd deploy', 'tar -czf release.tar.gz project', 'systemctl restart nginx', 'journalctl -u nginx -p err', 'df'],
    // ── 新增：进阶实战（5 关）──
    ['tar -czf site.tar.gz project', 'rm -r project', 'tar -xzf site.tar.gz', 'cat project/main.py'],
    ['df -h', 'du -sh /data', 'du -sh /var/log'],
    ['systemctl is-active redis', 'journalctl -u redis -n 5', 'systemctl start redis'],
    ['useradd -m -s /bin/sh ops', 'cat /etc/passwd', 'id ops'],
    ['fdisk -l', 'mkfs -t ext4 /dev/sdc', 'dd if=/dev/zero of=disk.img bs=1024 count=8'],
  ],
  // ── Vim 编辑器（12 关）──
  vim: [
    ['vim hello.txt', 'i', 'hello vim', 'Esc', ':wq'],
    ['vim notes.txt', 'j', 'o', 'inserted line', 'Esc', ':wq'],
    ['vim poem.txt', 'j', 'dd', ':wq'],
    ['vim config.ini', '3j', 'cc', 'host = 0.0.0.0', 'Esc', ':wq'],
    ['vim notes.txt', 'yy', 'p', ':wq'],
    ['vim config.ini', ':%s/8080/9090/g', ':wq'],
    ['vim poem.txt', '/awesome', 'dd', ':wq'],
    ['vim config.ini', ':%s/8080/9090/g', '2j', 'dd', 'gg', 'O', '# production config', 'Esc', ':wq'],
    // ── 新增：进阶编辑（4 关）──
    ['vim poem.txt', 'dd', 'u', ':wq'],
    ['vim poem.txt', '$', 'b', 'cw', 'blue', 'Esc', ':wq'],
    ['vim notes.txt', ':2,4s/line/row/g', ':s/FIRST/1st/gi', ':wq'],
    ['vim config.ini', ':%s/8080/9090/g', ':w config.bak', ':wq'],
  ],
  // ── 数据库（15 关）──
  db: [
    ['sqlite3 shop.db', 'CREATE TABLE products (id INTEGER, name TEXT, price INTEGER);', '.tables', '.quit'],
    ['sqlite3 shop.db', "INSERT INTO products VALUES (1, 'apple', 5);", "INSERT INTO products VALUES (2, 'keyboard', 12);", "INSERT INTO products VALUES (3, 'mouse', 8);", 'SELECT * FROM products;'],
    ['sqlite3 shop.db', 'SELECT name FROM products WHERE price > 10;'],
    ['sqlite3 shop.db', 'SELECT * FROM products ORDER BY price DESC LIMIT 2;'],
    ['sqlite3 shop.db', "UPDATE products SET price = 99 WHERE name = 'apple';", 'DELETE FROM products WHERE id = 3;'],
    ['sqlite3 shop.db', 'SELECT COUNT(*) FROM products;', 'SELECT AVG(price) FROM products;'],
    ['redis-cli', 'SET greeting hello-world', 'GET greeting', 'KEYS *', 'exit'],
    ['redis-cli', 'LPUSH queue first', 'RPUSH queue last', 'LRANGE queue 0 -1', 'INCR pageviews', 'INCR pageviews', 'INCR pageviews'],
    ['redis-cli', 'HSET user:1 name Alice', 'HSET user:1 age 30', 'HGET user:1 name', 'HGETALL user:1'],
    ['sqlite3 app.db', 'CREATE TABLE logs (id INTEGER, level TEXT, msg TEXT);', "INSERT INTO logs VALUES (1, 'ERROR', 'disk full');", "INSERT INTO logs VALUES (2, 'INFO', 'service started');", "SELECT * FROM logs WHERE level = 'ERROR';", '.quit', 'redis-cli', 'SET deploy_status done'],
    // ── 新增：进阶查询（5 关）──
    ['sqlite3 shop.db', 'SELECT category, COUNT(*) FROM orders GROUP BY category;', 'SELECT category, SUM(amount) FROM orders GROUP BY category HAVING SUM(amount) > 40;'],
    ['sqlite3 shop.db', 'SELECT name FROM products WHERE price < 10 OR price > 40;', "SELECT name FROM products WHERE name IN ('apple', 'mouse', 'cable');", 'SELECT name FROM products WHERE price BETWEEN 5 AND 12;'],
    ['sqlite3 shop.db', "INSERT INTO visits VALUES (1, 'beijing'), (2, 'shanghai'), (3, 'beijing'), (4, 'guangzhou');", 'SELECT DISTINCT city FROM visits;'],
    ['redis-cli', 'SET session:token abc123', 'EXPIRE session:token 300', 'TTL session:token', 'INCRBY pageviews 5', 'DECRBY pageviews 2'],
    ['redis-cli', 'HMSET user:2 name Bob age 25 city shanghai', 'HKEYS user:2', 'HLEN user:2', 'HINCRBY user:2 age 1', 'HDEL user:2 city', 'HEXISTS user:2 city'],
  ],
  // ── Kubernetes（12 关）──
  k8s: [
    ['kubectl get nodes', 'kubectl get pods', 'kubectl get ns'],
    ['kubectl create deployment web --image=nginx --replicas=3', 'kubectl get pods'],
    // Pod 名是动态的，从引擎里找 frontend 的 Pod
    g => { const p = g.pods.find(x => x.owner === 'frontend'); return ['kubectl get pods', `kubectl describe pod ${p.name}`, `kubectl logs ${p.name}`]; },
    ['kubectl scale deployment web --replicas=5', 'kubectl get pods'],
    ['kubectl expose deployment frontend --port=80 --type=NodePort', 'kubectl get services'],
    ['echo "kind: Deployment" > app.yaml', 'echo "name: api" >> app.yaml', 'echo "image: node:18" >> app.yaml', 'echo "replicas: 2" >> app.yaml', 'kubectl apply -f app.yaml'],
    // 崩溃 Pod 的名字是动态的
    g => { const bad = g.pods.find(x => x.owner === 'worker'); return ['kubectl get pods', `kubectl logs ${bad.name}`, `kubectl delete pod ${bad.name}`, 'kubectl get pods']; },
    ['kubectl create deployment shop --image=redis --replicas=2', 'kubectl scale deployment shop --replicas=4', 'kubectl expose deployment shop --port=6379', 'kubectl get all'],
    // ── 新增：进阶编排（4 关）──
    ['kubectl run debug --image=busybox', 'kubectl get pods', 'kubectl get pod debug -o wide'],
    g => { const p = g.pods.find(x => x.owner === 'frontend'); return ['kubectl get pods', `kubectl label pod ${p.name} env=canary`, 'kubectl get pods -l env=canary']; },
    ['kubectl rollout restart deployment frontend', 'kubectl get pods', 'kubectl rollout status deployment/frontend'],
    ['kubectl top pods -n tmp', 'kubectl delete deployments --all -n tmp', 'kubectl delete pods --all -n tmp', 'kubectl get pods -n tmp'],
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
