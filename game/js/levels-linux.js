// Linux 基础模块关卡 —— 文件操作 / 管道文本 / 进程管理
// setup(e) 初始化 LinuxEngine 状态，check(e) 判定通关。

// 预置一个有内容的工作目录
function seedHome(e) {
  e.reset();
  const home = '/home/user';
  e.mkdir(home + '/docs');
  e.writeFile(home + '/notes.txt', 'git is fun\nlinux is powerful\npipes are magic\npractice makes perfect\n');
  e.writeFile(home + '/data.csv', 'name,age,city\nalice,30,beijing\nbob,25,shanghai\ncarol,35,shenzhen\n');
  e.writeFile(home + '/server.log', 'INFO started\nERROR timeout\nINFO ok\nWARN slow\nERROR crash\nINFO done\n');
}

export const LINUX_LEVELS = [
  /* ============ 01 文件操作 ============ */
  {
    stage: '01 文件操作', id: 'L01', title: '创建目录和文件', par: 3,
    desc: '用 <code>mkdir projects</code> 创建目录，<code>touch projects/readme.md</code> 创建空文件，再 <code>ls projects</code> 确认。',
    hints: ['mkdir projects', 'touch projects/readme.md', 'ls projects'],
    setup(e) { e.reset(); },
    check(e) { return e.isDir('projects') && e.exists('projects/readme.md') && e.used.has('ls'); },
    done: 'mkdir 建目录、touch 建空文件、ls 看内容——Linux 文件操作三板斧。'
  },
  {
    stage: '01 文件操作', id: 'L02', title: '复制与移动', par: 4,
    desc: '把 <code>notes.txt</code> 复制到 <code>docs/</code> 目录，再把 <code>data.csv</code> 重命名为 <code>users.csv</code>，最后 <code>ls</code> 确认。',
    hints: ['cp notes.txt docs/', 'mv data.csv users.csv', 'ls', 'ls docs'],
    setup(e) { seedHome(e); },
    check(e) { return e.exists('docs/notes.txt') && e.exists('users.csv') && !e.exists('data.csv') && e.used.has('ls'); },
    done: 'cp 复制一份副本，mv 既能移动也能重命名——目标不存在就是改名。'
  },
  {
    stage: '01 文件操作', id: 'L03', title: '写入与查看', par: 4,
    desc: '用 <code>echo</code> 和重定向创建 <code>todo.txt</code>（内容含 "buy milk"），用 <code>cat</code> 查看，再追加一行，再 <code>cat</code> 一次。',
    hints: ['echo "buy milk" > todo.txt', 'cat todo.txt', 'echo "walk dog" >> todo.txt', 'cat todo.txt'],
    setup(e) { e.reset(); },
    check(e) {
      const r = e.readFile('todo.txt');
      return r.ok && r.content.includes('buy milk') && r.content.includes('walk dog') && e.used.has('cat');
    },
    done: '> 覆盖写入，>> 追加写入。配合 echo 就能在终端里快速造文件。'
  },
  {
    stage: '01 文件操作', id: 'L04', title: '权限与链接', par: 4,
    desc: '创建 <code>secret.sh</code>，用 <code>chmod +x</code> 给它执行权限，再 <code>ln -s</code> 创建快捷方式 <code>run</code>，<code>ls -l</code> 查看结果。',
    hints: ['echo "#!/bin/bash" > secret.sh', 'chmod +x secret.sh', 'ln -s secret.sh run', 'ls -l'],
    setup(e) { e.reset(); },
    check(e) {
      const f = e.getNode('secret.sh');
      const link = e.getNode('run');
      return f && f.mode.includes('x') && link && link.type === 'link' && e.used.has('ls');
    },
    done: 'chmod 改权限（u+x 给所有者加执行），ln -s 建符号链接——类似 Windows 快捷方式。'
  },

  /* ============ 02 管道与文本 ============ */
  {
    stage: '02 管道与文本', id: 'L05', title: 'grep 搜索', par: 3,
    desc: '<code>server.log</code> 里藏着故障。用 <code>grep ERROR server.log</code> 找出所有错误行，再用 <code>grep -c</code> 或管道 <code>wc -l</code> 统计数量。',
    hints: ['grep ERROR server.log', 'grep ERROR server.log | wc -l'],
    setup(e) { seedHome(e); },
    check(e) { return e.used.has('grep') && (e.used.has('wc') || /^\d+$/.test(e.lastOut.trim()) || e.lastOut.includes('ERROR')); },
    done: 'grep 是日志排查的第一把刀：grep 关键词 文件，瞬间定位问题行。'
  },
  {
    stage: '02 管道与文本', id: 'L06', title: '排序与去重', par: 4,
    desc: '创建 <code>fruits.txt</code>（三行：apple、banana、apple），用 <code>sort</code> 排序，再用管道 <code>sort | uniq</code> 去重。',
    hints: ['printf 不支持，用 echo 分行写入', 'echo "apple" > fruits.txt', 'echo "banana" >> fruits.txt', 'echo "apple" >> fruits.txt', 'sort fruits.txt', 'sort fruits.txt | uniq'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('sort') && e.used.has('uniq') && e.lastOut === 'apple\nbanana'; },
    done: 'sort | uniq 是统计词频、去重列表的黄金组合，uniq -c 还能计数。'
  },
  {
    stage: '02 管道与文本', id: 'L07', title: '管道组合拳', par: 3,
    desc: '用一条管道命令统计 <code>notes.txt</code> 里包含 "is" 的行数：<code>grep is notes.txt | wc -l</code>，结果应为 2。',
    hints: ['grep is notes.txt | wc -l'],
    setup(e) { seedHome(e); },
    check(e) { return e.used.has('grep') && e.used.has('wc') && e.lastOut.trim() === '2'; },
    done: '管道把小工具串成流水线：grep 过滤 → wc 统计，一条命令搞定。'
  },
  {
    stage: '02 管道与文本', id: 'L08', title: 'cut 提取列', par: 3,
    desc: '<code>data.csv</code> 是逗号分隔的表格。用 <code>cut -d , -f 1 data.csv</code> 提取姓名列，再用管道传给 <code>sort</code> 排序。',
    hints: ['cut -d , -f 1 data.csv', 'cut -d , -f 1 data.csv | sort'],
    setup(e) { seedHome(e); },
    check(e) { return e.used.has('cut') && e.used.has('sort') && e.lastOut.includes('alice') && e.lastOut.indexOf('alice') < e.lastOut.indexOf('name'); },
    done: 'cut -d 指定分隔符、-f 选列，处理 CSV 日志信手拈来。'
  },

  /* ============ 03 进程管理 ============ */
  {
    stage: '03 进程管理', id: 'L09', title: '查看进程', par: 3,
    desc: '用 <code>ps aux</code> 查看所有进程，找到 <code>sshd</code> 的 PID，再用 <code>top</code> 看一眼系统概况。',
    hints: ['ps aux', 'top'],
    setup(e) { seedHome(e); },
    check(e) { return e.used.has('ps') && e.used.has('top'); },
    done: 'ps 看进程快照，top 看实时排行——运维排查性能问题的起点。'
  },
  {
    stage: '03 进程管理', id: 'L10', title: '结束进程', par: 3,
    desc: '有个失控的 <code>sleep 999</code> 进程在后台跑。用 <code>ps aux</code> 找到它的 PID，然后 <code>kill</code> 掉它。',
    hints: ['ps aux', 'kill <PID>'],
    setup(e) {
      seedHome(e);
      e.spawn('sleep', 'sleep 999', 'S');
    },
    check(e) { return e.used.has('kill') && !e.procs.some(p => p.cmd === 'sleep 999'); },
    done: 'kill 默认发 SIGTERM 优雅退出，kill -9 是强制 SIGKILL——先礼后兵。'
  },
  {
    stage: '03 进程管理', id: 'L11', title: '后台任务', par: 4,
    desc: '用 <code>sleep 60 &</code> 启动后台任务，<code>jobs</code> 查看任务列表，再 <code>fg</code> 把它拉回前台（会自动结束）。',
    hints: ['sleep 60 &', 'jobs', 'fg'],
    setup(e) { seedHome(e); },
    check(e) { return e.used.has('sleep') && e.used.has('jobs') && e.used.has('fg'); },
    done: '& 让命令在后台跑，jobs 看任务，fg/bg 在前后台之间切换。'
  },
  {
    stage: '03 进程管理', id: 'L12', title: '综合演练', par: 6,
    desc: '综合挑战：① 创建 <code>report/</code> 目录；② 用管道把 <code>server.log</code> 中的 ERROR 行提取到 <code>report/errors.txt</code>；③ 统计错误数量写入 <code>report/count.txt</code>；④ 启动一个后台 <code>sleep 10 &</code>。',
    hints: ['mkdir report', 'grep ERROR server.log > report/errors.txt', 'grep ERROR server.log | wc -l > report/count.txt', 'sleep 10 &'],
    setup(e) { seedHome(e); },
    check(e) {
      const err = e.readFile('report/errors.txt');
      const cnt = e.readFile('report/count.txt');
      return e.isDir('report') && err.ok && err.content.includes('ERROR') && cnt.ok && cnt.content.trim() === '2' && e.used.has('sleep');
    },
    done: '目录 + 管道 + 重定向 + 后台任务——恭喜，你已经能组合 Linux 命令解决实际问题了！'
  },
];
