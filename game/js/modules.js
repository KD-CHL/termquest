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

// ─── Git 模块描述符 ───
const gitModule = {
  id: 'git',
  name: 'Git 闯关',
  icon: '⎇',
  color: '#3fb950',
  desc: '17 关从提交到变基、冲突解决与 reflog 救援',
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
    ['远程', ['git clone <url>', 'git push -u origin <b>', 'git pull --rebase', 'git fetch --prune']],
    ['暂存/标签', ['git stash', 'git stash pop', 'git tag v1.0.0', 'git tag -a v1 -m "msg"']],
    ['高级', ['git reflog', 'git bisect', 'git worktree add', 'git blame <f>', 'git submodule add']],
  ],
  cmds: [
    'git status', 'git add .', 'git add ', 'git commit -m ""', 'git log --oneline', 'git diff',
    'git branch', 'git switch -c ', 'git merge ', 'git rebase ', 'git cherry-pick ',
    'git reset --hard HEAD~1', 'git restore ', 'git restore --staged ', 'git stash',
    'git stash pop', 'git tag ', 'git show ', 'git revert ', 'git reflog',
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
  desc: '文件操作、管道文本处理与进程管理 12 关',
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
    ['文件', ['pwd', 'cd 目录', 'ls -l', 'cat 文件', 'mkdir -p 目录', 'touch 文件', 'cp 源 目标', 'mv 源 目标', 'rm -r 目录']],
    ['权限', ['chmod +x 文件', 'chmod 755 文件', 'chown 用户:组 文件', 'ln -s 目标 链接']],
    ['文本', ['grep 模式 文件', 'grep -v 模式', 'sed \'s/旧/新/g\'', 'sort -n', 'uniq -c', 'wc -l', 'head -n 5', 'tail -n 5', 'cut -d , -f 1', 'tr a-z A-Z']],
    ['管道', ['cmd1 | cmd2', 'cmd > 文件', 'cmd >> 文件', 'grep ERR log | wc -l']],
    ['进程', ['ps aux', 'top', 'kill PID', 'jobs', 'bg', 'fg', 'sleep 60 &', 'nohup cmd &']],
    ['系统', ['whoami', 'hostname', 'uname -a', 'date', 'env', 'export K=V', 'history']],
  ],
  cmds: [
    'ls', 'ls -l', 'pwd', 'cd ', 'cat ', 'mkdir ', 'touch ', 'cp ', 'mv ', 'rm ',
    'chmod +x ', 'ln -s ', 'echo "" > ', 'grep ', 'sed ', 'sort', 'uniq', 'wc -l',
    'head -n 5 ', 'tail -n 5 ', 'cut -d , -f 1 ', 'ps aux', 'top', 'kill ', 'jobs',
    'sleep 60 &', 'whoami', 'env', 'history', 'clear', 'help',
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
  desc: '文本处理 + 脚本自动化驱动 git 工作流 8 关',
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
    ['文本处理', ['grep 模式 文件', 'grep -c 模式', 'sed -i \'s/旧/新/g\' 文件', 'awk \'{print $1}\'', 'sort [-nru]', 'uniq -c', 'wc -l', 'head -n 5', 'tail -n 5']],
    ['管道/重定向', ['cmd1 | cmd2', 'cmd > 文件', 'cmd >> 文件', 'grep ERR log | wc -l']],
    ['脚本', ['echo "cmd" > 脚本.sh', 'bash 脚本.sh', '# 注释行']],
    ['Git 复习', ['git add .', 'git commit -m "msg"', 'git log --oneline', 'git status']],
  ],
  cmds: [
    'grep ', 'grep -c ', 'sed -i \'s///g\' ', 'awk \'{print $1}\'', 'sort', 'uniq -c', 'wc -l',
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
  desc: '容器、镜像、Compose 编排与 SSH 远程运维 10 关',
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
    ['镜像', ['docker images', 'docker pull 镜像:标签', 'docker build -t 名:标签 .', 'docker tag 源 目标', 'docker rmi 镜像:标签', 'docker inspect 对象']],
    ['容器', ['docker ps [-a]', 'docker run -d --name n [-p 8080:80] 镜像', 'docker stop 容器', 'docker start 容器', 'docker rm [-f] 容器', 'docker logs 容器', 'docker exec -it 容器 cmd']],
    ['网络/卷', ['docker network ls', 'docker network create 名', 'docker volume ls', 'docker volume create 名']],
    ['Compose', ['docker-compose up -d', 'docker-compose ps', 'docker-compose logs [服务]', 'docker-compose down']],
    ['SSH', ['ssh 用户@主机', 'ssh 用户@主机 命令', 'scp 本地 用户@主机:路径', 'scp 用户@主机:路径 本地', 'rsync -avz 源 用户@主机:目标', 'exit']],
  ],
  cmds: [
    'docker images', 'docker ps', 'docker ps -a', 'docker pull ', 'docker build -t ',
    'docker run -d --name ', 'docker stop ', 'docker start ', 'docker rm ', 'docker logs ',
    'docker tag ', 'docker rmi ', 'docker exec -it ', 'docker inspect ',
    'docker network ls', 'docker volume ls',
    'docker-compose up -d', 'docker-compose ps', 'docker-compose logs', 'docker-compose down',
    'ssh user@prod-server', 'scp  user@prod-server:', 'rsync -avz ', 'exit',
    'ls', 'cat ', 'echo "" > ', 'clear', 'help',
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
