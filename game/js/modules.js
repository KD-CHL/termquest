// 模块注册表 —— 多模块命令练习平台的核心调度
// 每个模块是一个描述符，包含引擎、命令执行、渲染面板、关卡等。
// Git 模块包装现有代码，新模块并列注册。
import { G, app } from './state.js';
import { LEVELS } from './levels.js';
import { execute as gitExecute } from './commands.js';
import { render as gitRender } from './render.js';
import { gitFsAdapter } from './fs.js';
import { LinuxEngine } from './linux-engine.js';
import { linuxExecute } from './linux-commands.js';
import { linuxRender } from './linux-render.js';
import { LINUX_LEVELS } from './levels-linux.js';
import { shellgitExecute } from './shellgit-commands.js';
import { SHELLGIT_LEVELS } from './levels-shellgit.js';
import { DockerEngine } from './docker-engine.js';
import { dockerExecute } from './docker-commands.js';
import { dockerRender } from './docker-render.js';
import { OPS_LEVELS } from './levels-docker.js';
import { NetEngine } from './net-engine.js';
import { netExecute } from './net-commands.js';
import { NET_LEVELS } from './levels-net.js';
import { textExecute } from './text-commands.js';
import { TEXT_LEVELS } from './levels-text.js';
import { SysEngine } from './sys-engine.js';
import { sysExecute } from './sys-commands.js';
import { SYS_LEVELS } from './levels-sys.js';
import { VimEngine } from './vim-engine.js';
import { vimExecute } from './vim-commands.js';
import { vimRender } from './vim-render.js';
import { VIM_LEVELS } from './levels-vim.js';
import { DbEngine } from './db-engine.js';
import { dbExecute } from './db-commands.js';
import { dbRender } from './db-render.js';
import { DB_LEVELS } from './levels-db.js';
import { K8sEngine } from './k8s-engine.js';
import { k8sExecute } from './k8s-commands.js';
import { k8sRender } from './k8s-render.js';
import { K8S_LEVELS } from './levels-k8s.js';

// ─── Git 模块描述符 ───
const gitModule = {
  id: 'git',
  name: 'Git 闯关',
  icon: '⎇',
  color: '#3fb950',
  desc: '22 关从提交到变基、远程协作与 reflog 救援',
  engine: G,
  fs: gitFsAdapter(G),
  execute: gitExecute,
  render: gitRender,
  levels: LEVELS,
  offset: 0, // 在 ALL_LEVELS 中的起始索引
  prompt(engine) { return `termquest (${engine.headBranch || 'detached'}) $`; },
  panels: [
    { id: 'graphBox', title: '提交图谱', dot: 'var(--green)', grow: true },
    { id: 'branchList', title: '分支', dot: 'var(--blue)', maxHeight: '130px' },
    { id: 'fileState', title: '工作区 / 暂存区', dot: 'var(--amber)', maxHeight: '150px' },
  ],
  sheet: [
    ['基础', ['git init', 'git status', 'git add .', 'git commit -m "msg"', 'git log --oneline', 'git diff']],
    ['撤销', ['git restore <f>', 'git restore --staged <f>', 'git commit --amend', 'git reset --hard HEAD~1', 'git revert <c>']],
    ['分支', ['git branch', 'git switch -c <b>', 'git merge <b>', 'git merge --no-ff <b>', 'git rebase <b>', 'git cherry-pick <c>']],
    ['洞察', ['git log --graph --all', 'git log --stat', 'git log -n 3', 'git diff --staged', 'git diff <ref>', 'git show <c>']],
    ['远程', ['git clone <url>', 'git push -u origin <b>', 'git pull', 'git fetch', 'git remote -v']],
    ['暂存/标签', ['git stash', 'git stash push -m "msg"', 'git stash list', 'git stash drop', 'git stash pop', 'git tag v1.0.0', 'git tag -d <t>', 'git clean -fd']],
    ['高级', ['git commit -am "msg"', 'git reflog', 'git branch -v', 'git branch -m 新名', 'git config user.name 名']],
  ],
  cmds: [
    'git status', 'git add .', 'git add ', 'git commit -m ""', 'git commit -am ""', 'git log --oneline',
    'git log --graph --all', 'git log --stat', 'git diff', 'git diff --staged',
    'git branch', 'git branch -v', 'git switch -c ', 'git merge ', 'git rebase ', 'git cherry-pick ',
    'git reset --hard HEAD~1', 'git restore ', 'git restore --staged ', 'git stash', 'git stash push -m ""',
    'git stash drop', 'git stash pop', 'git tag ', 'git tag -d ', 'git clean -fd', 'git show ', 'git revert ',
    'git reflog', 'git clone ', 'git push', 'git pull', 'git remote -v',
    'echo "" > ', 'ls', 'cat ', 'rm ', 'clear', 'help',
  ],
  helpLines: [
    '── 文件 ──', '  echo "内容" > 文件   /   echo "内容" >> 文件', '  ls · cat 文件 · rm 文件',
    '── Git ──',
    '  git status · git diff · git log [--oneline] [分支]',
    '  git add <文件|.> · git commit -m "信息" [--amend --no-edit]',
    '  git branch [名|-d] · git switch <分支|-c 新分支>',
    '  git merge <分支> [--abort] · git rebase <分支> · git cherry-pick <提交>',
    '  git reset [--hard|--soft] HEAD~n · git restore [--staged] <文件>',
    '  git revert <提交> · git reflog · git stash [list|pop] · git tag [名称] · git show [提交]',
    '  clear 清屏',
  ],
};

// ─── Linux 模块描述符 ───
const linuxEngine = new LinuxEngine();
const linuxModule = {
  id: 'linux',
  name: 'Linux 基础',
  icon: '🐧',
  color: '#58a6ff',
  desc: '文件操作、管道文本处理与进程管理 17 关',
  engine: linuxEngine,
  fs: null, // Linux 引擎自带完整文件系统
  execute: linuxExecute,
  render: linuxRender,
  levels: LINUX_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@termquest:${cwd}$`;
  },
  panels: [
    { id: 'linuxTree', title: '文件树', dot: 'var(--blue)', grow: true },
    { id: 'linuxProcs', title: '进程', dot: 'var(--amber)', maxHeight: '170px' },
  ],
  sheet: [
    ['文件', ['pwd', 'cd 目录', 'ls -l', 'ls -la', 'ls -R', 'cat -n 文件', 'mkdir -p 目录', 'touch 文件', 'cp 源 目标', 'mv 源 目标', 'rm -r 目录']],
    ['权限', ['chmod +x 文件', 'chmod 755 文件', 'chown 用户:组 文件', 'ln -s 目标 链接']],
    ['文本', ['grep 模式 文件', 'grep -r 模式 目录', 'grep -c 模式 文件', 'grep -l 模式 文件', 'grep -v 模式', 'sed \'s/旧/新/g\'', 'sort -n', 'sort -t , -k 2', 'uniq -c', 'wc -l', 'head -n 5', 'tail -n 5', 'cut -d , -f 1', 'tr a-z A-Z']],
    ['管道', ['cmd1 | cmd2', 'cmd > 文件', 'cmd >> 文件', 'grep ERR log | wc -l']],
    ['进程', ['ps aux', 'top', 'kill PID', 'jobs', 'bg', 'fg', 'sleep 60 &', 'nohup cmd &']],
    ['探查', ['which 命令', 'stat 文件', 'basename 路径', 'dirname 路径', 'file 文件', 'whoami', 'hostname', 'uname -a', 'date', 'env', 'history']],
  ],
  cmds: [
    'ls', 'ls -l', 'ls -la', 'ls -R', 'pwd', 'cd ', 'cat ', 'cat -n ', 'mkdir ', 'touch ', 'cp ', 'mv ', 'rm ',
    'chmod +x ', 'ln -s ', 'echo "" > ', 'grep ', 'grep -r ', 'grep -c ', 'grep -l ', 'sed ', 'sort', 'sort -t , -k 2 ',
    'uniq', 'wc -l', 'head -n 5 ', 'tail -n 5 ', 'cut -d , -f 1 ', 'ps aux', 'top', 'kill ', 'jobs',
    'sleep 60 &', 'which ', 'stat ', 'basename ', 'dirname ', 'whoami', 'env', 'history', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── Shell + Git 混合模块描述符 ───
// 共享 GitEngine（G）与 git 渲染，命令层自行处理文本/脚本并委托 git 子命令。
const shellgitModule = {
  id: 'shellgit',
  name: 'Shell × Git',
  icon: '⚡',
  color: '#bc8cff',
  desc: '文本处理 + 脚本自动化驱动 git 工作流 11 关',
  engine: G,
  fs: gitFsAdapter(G),
  execute: shellgitExecute,
  render: gitRender,
  levels: SHELLGIT_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) { return `termquest (${engine.headBranch || 'detached'}) $`; },
  panels: [
    { id: 'graphBox', title: '提交图谱', dot: 'var(--green)', grow: true },
    { id: 'branchList', title: '分支', dot: 'var(--blue)', maxHeight: '130px' },
    { id: 'fileState', title: '工作区 / 暂存区', dot: 'var(--amber)', maxHeight: '150px' },
  ],
  sheet: [
    ['文本处理', ['grep 模式 文件', 'grep -n 模式 文件', 'grep -l 模式 文件', 'grep -c 模式', 'sed -i \'s/旧/新/g\' 文件', 'sed -i \'2d\' 文件', 'awk \'{print $1}\'', 'awk -F , \'$2>28\'', 'sort [-nru]', 'sort -k 2 -n', 'uniq -c', 'uniq -d', 'wc -l', 'head -n 5', 'tail -n 5']],
    ['管道/重定向', ['cmd1 | cmd2', 'cmd > 文件', 'cmd >> 文件', 'grep ERR log | wc -l']],
    ['脚本', ['echo "cmd" > 脚本.sh', 'bash 脚本.sh', '# 注释行']],
    ['Git 复习', ['git add .', 'git commit -m "msg"', 'git log --oneline', 'git status']],
  ],
  cmds: [
    'grep ', 'grep -n ', 'grep -l ', 'grep -c ', 'sed -i \'s///g\' ', 'sed -i \'2d\' ', 'awk \'{print $1}\'',
    'awk -F , ', 'sort', 'sort -k 2 -n ', 'uniq -c', 'uniq -d', 'wc -l',
    'head -n 5 ', 'tail -n 5 ', 'echo "" > ', 'echo "" >> ', 'bash ', 'cat ', 'ls',
    'git add .', 'git commit -m ""', 'git log --oneline', 'git status', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── Docker / SSH / 运维模块描述符 ───
const dockerEngine = new DockerEngine();
const opsModule = {
  id: 'ops',
  name: 'Docker 运维',
  icon: '🐳',
  color: '#2dd4bf',
  desc: '容器、镜像、Compose 编排与 SSH 远程运维 14 关',
  engine: dockerEngine,
  fs: null,
  execute: dockerExecute,
  render: dockerRender,
  levels: OPS_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    if (engine.sshHost) {
      const [user, host] = engine.sshHost.split('@');
      return `${user}@${host}:~$`;
    }
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@docker-host:${cwd}$`;
  },
  panels: [
    { id: 'dockerBox', title: '容器 / SSH', dot: '#2dd4bf', grow: true },
    { id: 'dockerImages', title: '镜像', dot: 'var(--amber)', maxHeight: '190px' },
    { id: 'dockerTree', title: '文件树', dot: 'var(--blue)', maxHeight: '150px' },
  ],
  sheet: [
    ['镜像', ['docker images', 'docker images -q', 'docker pull 镜像:标签', 'docker build -t 名:标签 .', 'docker build -f Dockerfile.prod -t 名 .', 'docker history 镜像', 'docker tag 源 目标', 'docker rmi 镜像:标签', 'docker inspect 对象']],
    ['容器', ['docker ps [-a]', 'docker ps --filter name=名 -q', 'docker run -d --name n [-p 8080:80] 镜像', 'docker run -e K=V -v 卷:路径 镜像', 'docker stop 容器', 'docker start 容器', 'docker rm [-f] 容器', 'docker logs 容器', 'docker exec -it 容器 cmd', 'docker system prune -f']],
    ['网络/卷', ['docker network ls', 'docker network create 名', 'docker volume ls', 'docker volume create 名']],
    ['Compose', ['docker-compose up -d', 'docker-compose ps', 'docker-compose logs [服务]', 'docker-compose down']],
    ['SSH', ['ssh 用户@主机', 'ssh 用户@主机 命令', 'scp 本地 用户@主机:路径', 'scp -r 目录 用户@主机:路径', 'rsync -avz 源 用户@主机:目标', 'exit']],
  ],
  cmds: [
    'docker images', 'docker ps', 'docker ps -a', 'docker ps --filter name=', 'docker pull ', 'docker build -t ',
    'docker build -f ', 'docker history ', 'docker run -d --name ', 'docker run -e ', 'docker stop ', 'docker start ',
    'docker rm ', 'docker logs ', 'docker tag ', 'docker rmi ', 'docker exec -it ', 'docker inspect ',
    'docker system prune -f', 'docker network ls', 'docker volume ls',
    'docker-compose up -d', 'docker-compose ps', 'docker-compose logs', 'docker-compose down',
    'ssh user@prod-server', 'scp  user@prod-server:', 'rsync -avz ', 'exit',
    'ls', 'cat ', 'echo "" > ', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── 网络工具模块描述符 ───
const netEngine = new NetEngine();
const netModule = {
  id: 'net',
  name: '网络工具',
  icon: '🌐',
  color: '#f0883e',
  desc: 'ping/DNS/curl/端口扫描与网络排障 14 关',
  engine: netEngine,
  fs: null,
  execute: netExecute,
  render: linuxRender,
  levels: NET_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@net-host:${cwd}$`;
  },
  panels: [
    { id: 'linuxTree', title: '文件树', dot: 'var(--blue)', grow: true },
    { id: 'linuxProcs', title: '进程', dot: 'var(--amber)', maxHeight: '170px' },
  ],
  sheet: [
    ['连通性', ['ping 主机', 'ping -c 3 主机', 'traceroute 主机']],
    ['DNS', ['dig 域名', 'dig MX 域名', 'dig -x IP', 'dig +short 域名', 'nslookup 域名', 'host 域名']],
    ['HTTP', ['curl URL', 'curl -I URL', 'curl -o 文件 URL', 'curl -X POST -d "数据" URL', 'curl -H "头" URL', 'wget URL']],
    ['端口/连接', ['nc -zv 主机 端口', 'ss -tlnp', 'ss -anp', 'netstat -an', 'telnet 主机 端口']],
    ['路由/接口', ['arp -n', 'route -n', 'ip neigh', 'ip addr', 'ip route', 'ifconfig', 'ssh-keygen']],
  ],
  cmds: [
    'ping ', 'ping -c 3 ', 'traceroute ', 'dig ', 'dig MX ', 'dig -x ', 'nslookup ', 'host ',
    'curl ', 'curl -I ', 'curl -o  ', 'curl -X POST -d "" ', 'wget ', 'nc -zv ', 'ss -tlnp', 'ss -anp', 'netstat -an',
    'arp -n', 'route -n', 'ip neigh', 'ip addr', 'ifconfig', 'ssh-keygen', 'ls', 'cat ', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── 文本处理模块描述符 ───
const textEngine = new LinuxEngine();
const textModule = {
  id: 'text',
  name: '文本处理',
  icon: '✂️',
  color: '#d29922',
  desc: 'find/xargs/awk/sed/jq 高级文本流水线 16 关',
  engine: textEngine,
  fs: null,
  execute: textExecute,
  render: linuxRender,
  levels: TEXT_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@text:${cwd}$`;
  },
  panels: [
    { id: 'linuxTree', title: '文件树', dot: 'var(--blue)', grow: true },
    { id: 'linuxProcs', title: '进程', dot: 'var(--amber)', maxHeight: '170px' },
  ],
  sheet: [
    ['查找', ['find . -name "*.txt"', 'find . -iname "*.log"', 'find . -maxdepth 1 -type f', 'find . -name "*.bak" -delete', 'find . -name "*.log" -exec rm {} \\;', 'find 目录 | xargs 命令']],
    ['awk', ['awk \'{print $1}\' 文件', 'awk -F , \'{print $2}\'', 'awk \'$2>28\' 文件', 'awk -v x=1 \'BEGIN{print x}\'', 'awk \'{sum+=$2} END{print sum}\'']],
    ['sed', ['sed \'s/旧/新/g\' 文件', 'sed -i \'2d\' 文件', 'sed -n \'3p\' 文件', 'sed \'/模式/d\' 文件', 'sed -i \'1a\\新行\' 文件', 'sed -i \'/键/a\\新行\' 文件']],
    ['JSON', ['jq . 文件', 'jq .键 文件', 'jq .a[0].b 文件', 'jq .[] 文件', 'jq .length 文件']],
    ['组合', ['paste a b', 'join a b', 'diff a b', 'diff -u a b', 'comm a b', 'tee 文件', 'column -t', 'rev', 'seq 5']],
  ],
  cmds: [
    'find . -name ""', 'find . -iname ""', 'find . -maxdepth 1', 'find  -delete', 'find  | xargs ', 'awk \'{print $1}\' ',
    'awk -F , ', 'awk -v ', 'sed \'s///g\' ', 'sed -i \'2d\' ', 'sed -n \'3p\' ', 'jq . ', 'paste ', 'join ',
    'diff ', 'diff -u ', 'tee ', 'column -t', 'seq 5', 'ls', 'cat ', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── 系统管理模块描述符 ───
const sysEngine = new SysEngine();
const sysModule = {
  id: 'sys',
  name: '系统管理',
  icon: '🔧',
  color: '#f778ba',
  desc: '用户/服务/日志/磁盘/备份/性能 15 关',
  engine: sysEngine,
  fs: null,
  execute: sysExecute,
  render: linuxRender,
  levels: SYS_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@server:${cwd}$`;
  },
  panels: [
    { id: 'linuxTree', title: '文件树', dot: 'var(--blue)', grow: true },
    { id: 'linuxProcs', title: '进程', dot: 'var(--amber)', maxHeight: '170px' },
  ],
  sheet: [
    ['用户', ['useradd 用户', 'useradd -m -s /bin/sh 用户', 'passwd 用户', 'id 用户', 'groups', 'sudo 命令', 'su -']],
    ['服务/日志', ['systemctl start|stop|restart|status 服务', 'systemctl is-active 服务', 'systemctl enable 服务', 'systemctl list-units', 'journalctl -u 服务 -p err', 'journalctl -u 服务 -n 5', 'dmesg']],
    ['磁盘/挂载', ['df', 'df -h', 'du -sh 目录', 'lsblk', 'fdisk -l', 'mkfs -t ext4 设备', 'dd if=源 of=目标 bs=1024 count=N', 'mount 设备 挂载点', 'umount 挂载点']],
    ['备份/压缩', ['tar -czf 包 目录', 'tar -tf 包', 'tar -xzf 包', 'gzip 文件', 'gunzip 文件']],
    ['定时/性能', ['crontab -l', 'crontab 文件', 'free', 'uptime', 'vmstat', 'lsof']],
  ],
  cmds: [
    'useradd ', 'useradd -m -s /bin/sh ', 'passwd ', 'id ', 'sudo ', 'systemctl status ', 'systemctl restart ',
    'systemctl start ', 'systemctl is-active ', 'systemctl enable ', 'systemctl list-units', 'journalctl -u ',
    'journalctl -u  -n 5', 'df', 'df -h', 'du -sh ', 'lsblk', 'fdisk -l', 'mkfs -t ext4 ', 'dd if=/dev/zero of=',
    'mount ', 'tar -czf ', 'tar -tf ', 'tar -xzf ', 'crontab -l',
    'free', 'uptime', 'lsof', 'ls', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── Vim 编辑器模块描述符 ───
const vimEngine = new VimEngine();
const vimModule = {
  id: 'vim',
  name: 'Vim 编辑器',
  icon: '⌨️',
  color: '#7ee787',
  desc: '模态编辑、删除复制替换与撤销 12 关',
  engine: vimEngine,
  fs: null,
  execute: vimExecute,
  render: vimRender,
  levels: VIM_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    if (engine.vim) return `-- ${engine.vim.mode === 'insert' ? 'INSERT' : 'NORMAL'} -- ${engine.vim.file}`;
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@vim:${cwd}$`;
  },
  panels: [
    { id: 'vimBox', title: '编辑缓冲区', dot: '#7ee787', grow: true },
    { id: 'vimTree', title: '文件树', dot: 'var(--blue)', maxHeight: '150px' },
  ],
  sheet: [
    ['模式', ['vim 文件', 'i 插入', 'Esc 回到普通', ':wq 保存退出', ':q! 不保存退出', 'ZZ 保存退出']],
    ['移动', ['h j k l 方向', '0 行首 / $ 行尾', 'gg 文件头 / G 文件尾', 'w 下一词 / b 上一词 / e 词尾']],
    ['编辑', ['x 删字符', 'r{字符} 替换字符', 's 删字符进插入', 'dd 删行', 'dw 删词 / d$ 删到行尾', 'cw 改词 / cc 改行', 'yy 复制行', 'p 粘贴', 'u 撤销', 'D 删到行尾']],
    ['命令', [':w 保存', ':w 新文件 另存为', ':q 退出', ':set number', ':s/旧/新/gi', ':N,Ms/旧/新/g', ':%s/旧/新/g', '/模式 搜索']],
  ],
  cmds: [
    'vim ', 'i', 'Esc', ':wq', ':q!', ':w', ':w ', ':q', 'dd', 'dw', 'yy', 'p', 'cc', 'cw', 'x', 'r', 's', 'u',
    'gg', 'G', 'b', 'e', ':set number', ':%s///g', ':2,4s///g', '/搜索', 'ls', 'cat ', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── 数据库模块描述符 ───
const dbEngine = new DbEngine();
const dbModule = {
  id: 'db',
  name: '数据库',
  icon: '🗄️',
  color: '#ff7b72',
  desc: 'SQLite 增删改查 + Redis 缓存 15 关',
  engine: dbEngine,
  fs: null,
  execute: dbExecute,
  render: dbRender,
  levels: DB_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    if (engine.sqlSession) return `sqlite> `;
    if (engine.redisSession) return `127.0.0.1:6379> `;
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@db-host:${cwd}$`;
  },
  panels: [
    { id: 'dbTables', title: 'SQLite 表', dot: '#ff7b72', grow: true },
    { id: 'dbRedis', title: 'Redis 键值', dot: 'var(--amber)', maxHeight: '190px' },
  ],
  sheet: [
    ['SQLite', ['sqlite3 库名', 'CREATE TABLE 表 (列 类型, ...)', 'INSERT INTO 表 VALUES (...),(...)', 'SELECT 列|* FROM 表 [WHERE 条件]', 'SELECT DISTINCT 列 FROM 表', 'SELECT 列,COUNT(*) FROM 表 GROUP BY 列 [HAVING 条件]', 'WHERE a OR b / IN (...) / BETWEEN x AND y', 'SELECT ... ORDER BY 列 LIMIT 偏移,数量', 'UPDATE 表 SET 列=值 WHERE 条件', 'DELETE FROM 表 WHERE 条件', '.tables / .schema / .quit']],
    ['Redis 字符串', ['redis-cli', 'SET k v', 'GET k', 'DEL k', 'KEYS *', 'INCR k', 'INCRBY k n / DECRBY k n', 'EXPIRE k 秒', 'TTL k', 'PERSIST k', 'MSET k v ... / MGET k ...', 'EXISTS k', 'TYPE k']],
    ['Redis 结构', ['LPUSH/RPUSH k v', 'LRANGE k 0 -1', 'LLEN k', 'LPOP/RPOP k', 'HSET k 字段 值', 'HMSET k 字段 值 ...', 'HGET k 字段', 'HGETALL k', 'HKEYS/HVALS k', 'HLEN k', 'HDEL k 字段', 'HEXISTS k 字段', 'HINCRBY k 字段 n', 'exit']],
  ],
  cmds: [
    'sqlite3 shop.db', 'CREATE TABLE ', 'INSERT INTO ', 'SELECT * FROM ', 'SELECT DISTINCT ', 'SELECT COUNT(*) FROM ',
    ' GROUP BY ', 'UPDATE ', 'DELETE FROM ', '.tables', '.quit', 'redis-cli', 'SET ', 'GET ', 'DEL ',
    'KEYS *', 'INCR ', 'INCRBY ', 'EXPIRE ', 'TTL ', 'LPUSH ', 'LRANGE ', 'HSET ', 'HMSET ', 'HKEYS ', 'HGETALL ', 'exit', 'ls', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── Kubernetes 模块描述符 ───
const k8sEngine = new K8sEngine();
const k8sModule = {
  id: 'k8s',
  name: 'Kubernetes',
  icon: '☸',
  color: '#79c0ff',
  desc: 'Deployment/扩缩容/Service/标签/滚动排障 12 关',
  engine: k8sEngine,
  fs: null,
  execute: k8sExecute,
  render: k8sRender,
  levels: K8S_LEVELS,
  offset: 0, // registerModule 会设置
  prompt(engine) {
    const cwd = (engine.cwd || '~').replace(engine.env?.HOME || '/home/user', '~');
    return `user@k8s-master:${cwd}$`;
  },
  panels: [
    { id: 'k8sBox', title: 'Pods', dot: '#79c0ff', grow: true },
    { id: 'k8sDeploys', title: 'Deployment / Service', dot: 'var(--green)', maxHeight: '170px' },
    { id: 'k8sNodes', title: '节点', dot: 'var(--amber)', maxHeight: '120px' },
  ],
  sheet: [
    ['查看', ['kubectl get pods|deployments|services|nodes|ns', 'kubectl get all', 'kubectl get pod 名 -o wide', 'kubectl get pods -l 键=值', 'kubectl describe pod 名', 'kubectl logs pod名 [--tail=N]', 'kubectl top pods|nodes']],
    ['部署', ['kubectl create deployment 名 --image=镜像 --replicas=N', 'kubectl run 名 --image=镜像', 'kubectl apply -f 文件.yaml', 'kubectl label pod 名 键=值', 'kubectl delete pod|deployment 名', 'kubectl delete pods --all']],
    ['伸缩/暴露', ['kubectl scale deployment 名 --replicas=N', 'kubectl expose deployment 名 --port=80 --type=NodePort', 'kubectl rollout restart deployment 名', 'kubectl rollout status deployment/名']],
    ['调试', ['kubectl exec pod名 -- 命令', 'kubectl version', 'kubectl cluster-info']],
  ],
  cmds: [
    'kubectl get pods', 'kubectl get deployments', 'kubectl get services', 'kubectl get nodes',
    'kubectl get all', 'kubectl get pod  -o wide', 'kubectl get pods -l ', 'kubectl describe pod ', 'kubectl logs ',
    'kubectl top pods', 'kubectl create deployment ', 'kubectl run ', 'kubectl label pod ', 'kubectl scale deployment ',
    'kubectl expose deployment ', 'kubectl rollout restart deployment ', 'kubectl rollout status deployment/',
    'kubectl apply -f ', 'kubectl delete pod ', 'kubectl delete pods --all', 'kubectl exec ', 'ls', 'cat ', 'echo "" > ', 'clear', 'help',
  ],
  helpLines: [],
};

// ─── 模块注册表 ───
const MODULES = [gitModule];

// 后续模块注册入口（Phase 2/3/4 会调用）
export function registerModule(mod) {
  mod.offset = ALL_LEVELS.length;
  MODULES.push(mod);
  ALL_LEVELS.push(...mod.levels);
}

// ─── 全局关卡数组（git 在前，新模块追加） ───
export const ALL_LEVELS = [...LEVELS];

// 注册 Linux 模块
registerModule(linuxModule);
// 注册 Shell + Git 模块
registerModule(shellgitModule);
// 注册 Docker / SSH / 运维模块
registerModule(opsModule);
// 注册网络工具模块
registerModule(netModule);
// 注册文本处理模块
registerModule(textModule);
// 注册系统管理模块
registerModule(sysModule);
// 注册 Vim 编辑器模块
registerModule(vimModule);
// 注册数据库模块
registerModule(dbModule);
// 注册 Kubernetes 模块
registerModule(k8sModule);

export function getModules() { return MODULES; }
export function getModule(id) { return MODULES.find(m => m.id === id); }
export function getCurrentModule() { return app.currentModule || gitModule; }

// 某模块内已解锁的关卡数（模块内独立进度）
export function moduleUnlockedCount(mod) {
  const start = mod.offset;
  const count = mod.levels.length;
  let n = 1;
  for (let i = 0; i < count - 1; i++) {
    if (app.levelStars[start + i] > 0) n = i + 2; else break;
  }
  return n;
}

// 根据全局关卡索引找到所属模块
export function moduleForLevel(globalIdx) {
  for (let i = MODULES.length - 1; i >= 0; i--) {
    if (globalIdx >= MODULES[i].offset) return MODULES[i];
  }
  return MODULES[0];
}

// 初始化：设置默认模块
export function initModules() {
  app.currentModule = gitModule;
  app.engine = G;
}
