// Docker / SSH / 运维模块关卡 —— 容器 / 镜像 / Compose / 远程运维
// setup/check 操作 DockerEngine（e），远程主机为 e.remote。
export const OPS_LEVELS = [
  /* ============ 01 容器基础 ============ */
  {
    stage: '01 容器基础', id: 'D01', title: '第一个容器', par: 3,
    desc: '用 <code>docker pull nginx:alpine</code> 拉取镜像，<code>docker run -d --name web nginx:alpine</code> 后台启动容器，再 <code>docker ps</code> 确认它在运行。',
    hints: ['docker pull nginx:alpine', 'docker run -d --name web nginx:alpine', 'docker ps'],
    setup(e) { e.reset(); },
    check(e) { return e.containers.some(c => c.name === 'web' && c.status === 'running'); },
    done: 'pull 下载镜像，run 启动容器，ps 查看状态——Docker 日常三板斧。'
  },
  {
    stage: '01 容器基础', id: 'D02', title: '停止与删除', par: 2,
    desc: '有个废弃容器 <code>old-app</code> 还在跑。先 <code>docker stop old-app</code> 停止它，再 <code>docker rm old-app</code> 删除。',
    hints: ['docker ps', 'docker stop old-app', 'docker rm old-app'],
    setup(e) {
      e.reset();
      e.seedImage('old-app:1.0', ['FROM node:18', 'COPY . /app', 'CMD node /app/server.js']);
      e.seedContainer('old-app:1.0', 'old-app');
    },
    check(e) { return e.used.has('docker') && !e.containers.some(c => c.name === 'old-app'); },
    done: '运行中的容器不能直接 rm，要先 stop——先礼后兵，和 kill 一个道理。'
  },
  {
    stage: '01 容器基础', id: 'D03', title: '查看日志排障', par: 2,
    desc: '容器 <code>api</code> 好像出问题了。用 <code>docker logs api</code> 查看它的输出日志，找出 ERROR 信息。',
    hints: ['docker ps', 'docker logs api'],
    setup(e) {
      e.reset();
      e.seedImage('api-server:2.1', ['FROM node:18', 'CMD node api.js']);
      e.seedContainer('api-server:2.1', 'api', { logs: ['INFO server started on :3000', 'INFO connected to db', 'ERROR TypeError: Cannot read property "id" of undefined', 'ERROR request handler crashed'] });
    },
    check(e) { return e.lastOut.includes('ERROR') && e.containers.some(c => c.name === 'api'); },
    done: 'docker logs 是容器排障的第一现场，加 -f 还能实时跟踪（类似 tail -f）。'
  },
  {
    stage: '01 容器基础', id: 'D04', title: '端口映射', par: 2,
    desc: '把 nginx 容器（镜像已就绪）跑起来，并用 <code>-p 8080:80</code> 把容器 80 端口映射到本机 8080，命名为 <code>site</code>。',
    hints: ['docker run -d --name site -p 8080:80 nginx:alpine', 'docker ps'],
    setup(e) {
      e.reset();
      e.seedImage('nginx:alpine', ['FROM scratch', 'ADD nginx binary /', 'CMD ["nginx", "-g", "daemon off;"]']);
    },
    check(e) { return e.containers.some(c => c.name === 'site' && c.status === 'running' && c.ports.includes('8080:80')); },
    done: '-p 主机端口:容器端口——外部访问容器的唯一通道。忘了映射端口，服务就"隐身"了。'
  },

  /* ============ 02 镜像与构建 ============ */
  {
    stage: '02 镜像与构建', id: 'D05', title: '第一个 Dockerfile', par: 3,
    desc: '用两行 <code>echo</code> 创建 <code>Dockerfile</code>（内容：<code>FROM node:18</code> 和 <code>CMD node app.js</code>），然后 <code>docker build -t myapp:1.0 .</code> 构建镜像。',
    hints: ['echo "FROM node:18" > Dockerfile', 'echo "CMD node app.js" >> Dockerfile', 'docker build -t myapp:1.0 .'],
    setup(e) { e.reset(); },
    check(e) {
      const img = e.findImage('myapp:1.0');
      return !!img && img.layers.some(l => l.toUpperCase().startsWith('FROM'));
    },
    done: 'Dockerfile 是镜像的"配方"：FROM 指定基础镜像，RUN/COPY/CMD 逐层叠加。build 把配方变成镜像。'
  },
  {
    stage: '02 镜像与构建', id: 'D06', title: '构建并运行', par: 3,
    desc: 'Dockerfile 已备好。构建镜像 <code>mysite:1.0</code>，然后运行一个名为 <code>site</code> 的容器，最后 <code>docker ps</code> 确认。',
    hints: ['cat Dockerfile', 'docker build -t mysite:1.0 .', 'docker run -d --name site mysite:1.0', 'docker ps'],
    setup(e) {
      e.reset();
      e.writeFile('Dockerfile', 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n');
    },
    check(e) { return !!e.findImage('mysite:1.0') && e.containers.some(c => c.name === 'site' && c.status === 'running'); },
    done: 'build → run 是应用上云的标准流程，CI/CD 流水线里全是这两步的影子。'
  },
  {
    stage: '02 镜像与构建', id: 'D07', title: '标签与清理', par: 3,
    desc: '镜像 <code>myapp:1.0</code> 已发布。给它打上 <code>myapp:latest</code> 标签（<code>docker tag</code>），然后用 <code>docker rmi myapp:1.0</code> 清理旧标签，<code>docker images</code> 确认。',
    hints: ['docker tag myapp:1.0 myapp:latest', 'docker rmi myapp:1.0', 'docker images'],
    setup(e) {
      e.reset();
      e.seedImage('myapp:1.0', ['FROM node:18', 'COPY . /app', 'CMD node /app/index.js']);
    },
    check(e) { return !!e.findImage('myapp:latest') && !e.findImage('myapp:1.0'); },
    done: 'tag 只是镜像的"别名"，底层共享同一份层数据。rmi 删的是标签，不是数据（除非没有标签引用它）。'
  },

  /* ============ 03 运维实战 ============ */
  {
    stage: '03 运维实战', id: 'D08', title: 'Compose 多服务编排', par: 2,
    desc: '<code>docker-compose.yml</code> 已定义 web 和 db 两个服务。用 <code>docker-compose up -d</code> 一键启动，再 <code>docker-compose ps</code> 查看状态。',
    hints: ['cat docker-compose.yml', 'docker-compose up -d', 'docker-compose ps'],
    setup(e) {
      e.reset();
      e.writeFile('docker-compose.yml',
        'services:\n' +
        '  web:\n' +
        '    image: nginx:alpine\n' +
        '    ports:\n' +
        '      - "8080:80"\n' +
        '  db:\n' +
        '    image: postgres:15\n' +
        '    volumes:\n' +
        '      - db-data:/var/lib/postgresql/data\n');
    },
    check(e) {
      return e.containers.some(c => c.name === 'web' && c.status === 'running') &&
             e.containers.some(c => c.name === 'db' && c.status === 'running');
    },
    done: '一个 yml 文件描述整套架构，up -d 一键拉起——这就是声明式编排的魅力。'
  },
  {
    stage: '03 运维实战', id: 'D09', title: 'SSH 远程排障', par: 3,
    desc: '生产机 <code>prod-server</code> 报警了。用 <code>ssh user@prod-server</code> 登录，<code>cat /var/log/app.log</code> 查看日志里的 ERROR，排查完输入 <code>exit</code> 断开连接。',
    hints: ['ssh user@prod-server', 'cat /var/log/app.log', 'exit'],
    setup(e) { e.reset(); },
    check(e) {
      return e.used.has('ssh') && e.used.has('cat') && e.used.has('exit') &&
        e.sshHost === null && e.lastOut.includes('ERROR');
    },
    done: 'ssh 登录后所有命令都在远程执行，exit 断开——排障完毕记得退出，别让会话裸奔。'
  },
  {
    stage: '03 运维实战', id: 'D10', title: 'scp 传输备份', par: 3,
    desc: '本地有份 <code>backup.sql</code>。用 <code>scp backup.sql user@prod-server:/tmp/</code> 上传到生产机，再用单命令 SSH <code>ssh user@prod-server ls /tmp</code> 确认文件到了。',
    hints: ['cat backup.sql', 'scp backup.sql user@prod-server:/tmp/', 'ssh user@prod-server ls /tmp'],
    setup(e) {
      e.reset();
      e.writeFile('backup.sql', 'CREATE TABLE users (id INT, name TEXT);\nINSERT INTO users VALUES (1, \'alice\');\n');
    },
    check(e) { return e.used.has('scp') && e.used.has('ssh') && e.remote.exists('/tmp/backup.sql'); },
    done: 'scp 走 SSH 通道加密传输，rsync -avz 还能增量同步——运维传文件的左膀右臂。毕业快乐！🎓'
  },

  /* ============ 04 进阶运维 ============ */
  {
    stage: '04 进阶运维', id: 'D11', title: '环境变量与挂载', par: 2,
    desc: '启动一个名为 <code>cache</code> 的 Redis 容器：用 <code>-e REDIS_PORT=6380</code> 注入环境变量，用 <code>-v redis-data:/data</code> 挂载数据卷，再 <code>docker inspect cache</code> 确认配置已生效。',
    hints: ['docker run -d --name cache -e REDIS_PORT=6380 -v redis-data:/data redis:7', 'docker inspect cache'],
    setup(e) {
      e.reset();
      e.seedImage('redis:7', ['FROM scratch', 'ADD redis binary /', 'CMD ["redis-server"]']);
    },
    check(e) {
      const c = e.containers.find(x => x.name === 'cache');
      return !!c && c.status === 'running' && c.env.REDIS_PORT === '6380' &&
        c.mounts.some(m => m.source === 'redis-data' && m.target === '/data');
    },
    done: '-e 注入环境变量，-v 挂载存储卷——配置与数据分离，是容器化部署的基本功。'
  },
  {
    stage: '04 进阶运维', id: 'D12', title: '筛选容器', par: 2,
    desc: '主机上跑着好几个容器。先 <code>docker ps -a</code> 查看全部，再用 <code>docker ps --filter name=web -q</code> 精准筛出名字含 <code>web</code> 的运行中容器的 <b>id</b>。',
    hints: ['docker ps -a', 'docker ps --filter name=web -q'],
    setup(e) {
      e.reset();
      e.seedImage('nginx:alpine');
      e.seedImage('postgres:15');
      e.seedContainer('nginx:alpine', 'web1');
      e.seedContainer('nginx:alpine', 'web2');
      e.seedContainer('postgres:15', 'db1', { status: 'exited' });
    },
    check(e) {
      const ids = e.containers.filter(c => c.name.includes('web') && c.status === 'running').map(c => c.id);
      const lines = e.lastOut.split('\n').filter(Boolean);
      return e.used.has('docker') && ids.length === 2 && lines.length === 2 && ids.every(id => lines.includes(id));
    },
    done: '--filter 按 name/status 过滤，-q 只输出 id——两者组合是脚本里批量操作容器的常用手法。'
  },
  {
    stage: '04 进阶运维', id: 'D13', title: '大扫除释放空间', par: 3,
    desc: '残留的 <code>dead-app</code> 和 <code>dead-worker</code> 早已停止。用 <code>docker system prune -f</code> 一次性清理它们和悬空镜像，注意运行中的 <code>live-app</code> 不能受影响。',
    hints: ['docker ps -a', 'docker system prune -f', 'docker ps -a'],
    setup(e) {
      e.reset();
      e.seedImage('app:1.0', ['FROM node:18', 'COPY . /app', 'CMD node app.js']);
      e.seedImage('app:old', ['FROM node:16', 'COPY . /app', 'CMD node app.js']);
      e.seedContainer('app:1.0', 'live-app');
      e.seedContainer('app:old', 'dead-app', { status: 'exited' });
      e.seedContainer('app:old', 'dead-worker', { status: 'exited' });
    },
    check(e) {
      return e.used.has('docker') &&
        !e.containers.some(c => c.name === 'dead-app') &&
        !e.containers.some(c => c.name === 'dead-worker') &&
        e.containers.some(c => c.name === 'live-app' && c.status === 'running');
    },
    done: 'system prune -f 一键清掉停止的容器与悬空镜像——磁盘告急时的救火队长。'
  },
  {
    stage: '04 进阶运维', id: 'D14', title: '指定 Dockerfile 与层历史', par: 3,
    desc: '生产环境的配方叫 <code>Dockerfile.prod</code>。用 <code>docker build -t myapp:prod -f Dockerfile.prod .</code> 构建镜像，再 <code>docker history myapp:prod</code> 查看它的层历史。',
    hints: ['cat Dockerfile.prod', 'docker build -t myapp:prod -f Dockerfile.prod .', 'docker history myapp:prod'],
    setup(e) {
      e.reset();
      e.writeFile('Dockerfile.prod', 'FROM node:18\nENV NODE_ENV=production\nCOPY . /app\nCMD node /app/server.js\n');
    },
    check(e) {
      const img = e.findImage('myapp:prod');
      return !!img && img.layers.some(l => l.toUpperCase().startsWith('ENV')) &&
        e.lastOut.includes('NODE_ENV=production');
    },
    done: '-f 指定非默认 Dockerfile，history 逐层回看构建过程——镜像瘦身与审计都靠它。'
  },
];
