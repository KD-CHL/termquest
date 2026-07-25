// Docker / SSH / 运维命令集
// docker/docker-compose/ssh/scp/rsync 由本模块处理，其余命令委托 linuxExecute
// （SSH 会话中则委托给远程 LinuxEngine）。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute, runRemoteCmd } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

export function dockerExecute(input) {
  input = input.trim();
  if (!input) return;
  const e = E();

  // ── SSH 会话中：除 exit 外全部路由到远程主机 ──
  if (e.sshHost) {
    if (input === 'exit' || input === 'logout') {
      printCmd(input);
      print(`Connection to ${e.sshHost.split('@')[1]} closed.`, 'info');
      e.sshHost = null;
      track('exit'); e.used.add('exit');
      sfx('ui-close'); after(true);
      return;
    }
    track(input.split(/\s/)[0]); e.used.add(input.split(/\s/)[0]);
    linuxExecute(input, e.remote);
    e.lastOut = e.remote.lastOut;   // 镜像远程输出供 check 使用
    return;
  }

  const base = input.split(/\s/)[0];
  if (base === 'help') {
    printCmd(input);
    [
      '── Docker ──',
      '  docker images · docker ps [-a] · docker pull <镜像:标签>',
      '  docker build -t <名:标签> . · docker run [-d] [--name 名] [-p 主机:容器] <镜像>',
      '  docker stop/start/rm <容器> · docker logs <容器> · docker exec -it <容器> <命令>',
      '  docker tag <源> <目标> · docker rmi <镜像> · docker inspect <对象>',
      '  docker network ls · docker volume ls',
      '── Compose ──',
      '  docker-compose up -d · docker-compose ps · docker-compose logs · docker-compose down',
      '── SSH / 传输 ──',
      '  ssh <用户>@<主机> [命令]   （会话中 exit 断开）',
      '  scp <本地文件> <用户>@<主机>:<路径>   （反向亦可）',
      '  rsync -avz <源> <用户>@<主机>:<目标>',
      '── 其余 ──',
      '  ls · cat · echo · mkdir · grep ... 等 Linux 命令照常可用',
    ].forEach(l => print(l, 'info'));
    return;
  }
  if (base === 'docker' || base === 'docker-compose') {
    printCmd(input);
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track(base); e.used.add(base);
    if (base === 'docker-compose') runCompose(input, e);
    else runDocker(input, e);
    return;
  }
  if (['ssh', 'scp', 'rsync'].includes(base)) {
    printCmd(input);
    app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount();
    track(base); e.used.add(base);
    runRemote(input, base, e);
    return;
  }
  // 其余 → 本地 linux 命令
  linuxExecute(input);
}

/* ============ docker 子命令 ============ */
function runDocker(input, e) {
  const t = tokenize(input);
  const sub = t[1];
  const rest = t.slice(2);
  const fn = DOCKER[sub];
  if (!fn) { sfx('err-syntax'); print(`docker: '${sub || ''}' 不是 docker 命令`, 'err'); after(false); return; }
  fn(rest, e);
}

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

function parseImageSpec(spec) {
  const [repo, tag = 'latest'] = (spec || '').includes(':') ? spec.split(':') : [spec, 'latest'];
  return { repo, tag };
}

const DOCKER = {
  images: (a, e) => {
    const lines = ['REPOSITORY'.padEnd(28) + 'TAG'.padEnd(12) + 'IMAGE ID'.padEnd(14) + 'SIZE'];
    for (const i of e.images) lines.push(`${i.repo.padEnd(28)}${i.tag.padEnd(12)}${i.id.padEnd(14)}${i.size}MB`);
    if (!e.images.length) lines.push('(暂无镜像 —— 用 docker pull 或 docker build 创建)');
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  ps: (a, e) => {
    const all = a.includes('-a') || a.includes('--all');
    const list = all ? e.containers : e.containers.filter(c => c.status === 'running');
    const lines = ['CONTAINER ID'.padEnd(14) + 'IMAGE'.padEnd(22) + 'STATUS'.padEnd(12) + 'PORTS'.padEnd(16) + 'NAMES'];
    for (const c of list) {
      const st = c.status === 'running' ? 'Up 2 min' : 'Exited (0)';
      lines.push(`${c.id.padEnd(14)}${c.image.padEnd(22)}${st.padEnd(12)}${(c.ports.join(',') || '-').padEnd(16)}${c.name}`);
    }
    if (!list.length) lines.push(all ? '(没有任何容器)' : '(没有运行中的容器 —— docker ps -a 查看全部)');
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  pull: (a, e) => {
    const spec = a[0];
    if (!spec) return err('用法: docker pull <镜像:标签>', e);
    const { repo, tag } = parseImageSpec(spec);
    sfx('docker-pull');
    print(`Using default tag: ${tag}`, 'info');
    print(`Pulling ${repo}...`, 'info');
    ['layer 1/3: downloading', 'layer 2/3: downloading', 'layer 3/3: extracting'].forEach((l, i) =>
      setTimeout(() => print(l, 'dim'), i * 120));
    e.addImage(repo, tag, [`FROM scratch`, `ADD ${repo}:${tag} /`, `CMD ["/bin/sh"]`], null);
    print(`Status: Downloaded newer image for ${repo}:${tag}`, 'ok');
    after(true);
  },

  build: (a, e) => {
    const tagSpec = flagVal(a, '-t') || flagVal(a, '--tag');
    if (!tagSpec) return err('用法: docker build -t <名称:标签> .', e);
    const dir = a[a.length - 1] === '.' ? e.cwd : a[a.length - 1];
    const dfPath = (dir === e.cwd ? '' : dir + '/') + 'Dockerfile';
    const r = e.readFile(dfPath);
    if (r.err) { sfx('err-file'); print(`unable to prepare context: path "${dfPath}" not found`, 'err'); after(false); return; }
    const lines = r.content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const layers = [];
    for (const l of lines) {
      const instr = l.split(/\s/)[0].toUpperCase();
      if (!['FROM', 'RUN', 'COPY', 'ADD', 'CMD', 'ENV', 'WORKDIR', 'EXPOSE', 'LABEL', 'ENTRYPOINT'].includes(instr)) {
        sfx('err-syntax'); print(`unknown instruction: ${l}`, 'err'); after(false); return;
      }
      layers.push(l);
    }
    if (!layers.some(l => l.toUpperCase().startsWith('FROM'))) {
      sfx('err-syntax'); print('no build stage in current context (缺少 FROM 指令)', 'err'); after(false); return;
    }
    const { repo, tag } = parseImageSpec(tagSpec);
    const base = layers[0].split(/\s+/)[1];
    sfx('docker-build');
    layers.forEach((l, i) => print(`Step ${i + 1}/${layers.length} : ${l}`, 'dim'));
    e.addImage(repo, tag, layers, base);
    print(`Successfully built ${e.findImage(`${repo}:${tag}`).id}`, 'ok');
    print(`Successfully tagged ${repo}:${tag}`, 'ok');
    sfx('docker-image');
    after(true);
  },

  run: (a, e) => {
    const name = flagVal(a, '--name');
    const ports = [];
    a.forEach((x, i) => { if (x === '-p' || x === '--publish') ports.push(a[i + 1]); });
    const detach = a.includes('-d') || a.includes('--detach');
    const spec = a.filter((x, i) => !x.startsWith('-') && x !== name && !ports.includes(x) && a[i - 1] !== '--name' && a[i - 1] !== '-p' && a[i - 1] !== '--publish')[0];
    if (!spec) return err('用法: docker run [-d] [--name 名称] [-p 主机:容器] <镜像> [命令]', e);
    const img = e.findImage(spec);
    if (!img) { sfx('err-network'); print(`Unable to find image '${spec}' locally (先 docker pull ${spec})`, 'err'); after(false); return; }
    const c = e.createContainer(img, name, { ports });
    sfx('docker-start');
    print(detach ? c.id : `${c.name} 已启动（前台模式按 Ctrl+C 退出）`, 'ok');
    if (!detach) print(`[${c.name}] ${c.logs[c.logs.length - 1]}`, 'dim');
    e.lastOut = c.id;
    after(true);
  },

  stop: (a, e) => {
    const c = e.findContainer(a[0] || '');
    if (!c) return err(`docker: Error response from daemon: No such container: ${a[0] || ''}`, e, 'err-network');
    c.status = 'exited'; sfx('docker-stop'); print(a[0], 'ok'); after(true);
  },

  start: (a, e) => {
    const c = e.findContainer(a[0] || '');
    if (!c) return err(`docker: Error response from daemon: No such container: ${a[0] || ''}`, e, 'err-network');
    c.status = 'running'; sfx('docker-start'); print(a[0], 'ok'); after(true);
  },

  rm: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (c.status === 'running' && !a.includes('-f')) {
      sfx('err-syntax'); print(`Error: Cannot remove a running container: ${c.name} (先 docker stop 或加 -f)`, 'err'); after(false); return;
    }
    e.containers.splice(e.containers.indexOf(c), 1);
    sfx('docker-stop'); print(key, 'ok'); after(true);
  },

  rmi: (a, e) => {
    const spec = a[0];
    const img = e.findImage(spec || '');
    if (!img) return err(`Error: No such image: ${spec || ''}`, e, 'err-network');
    if (e.containers.some(c => c.image === `${img.repo}:${img.tag}`)) {
      sfx('err-syntax'); print(`Error: image is referenced by one or more containers (先删除容器)`, 'err'); after(false); return;
    }
    e.images.splice(e.images.indexOf(img), 1);
    sfx('file-delete'); print(`Untagged: ${spec}`, 'ok'); after(true);
  },

  logs: (a, e) => {
    const c = e.findContainer(a.filter(x => !x.startsWith('-'))[0] || '');
    if (!c) return err(`Error: No such container: ${a[0] || ''}`, e, 'err-network');
    c.logs.forEach(l => print(l, 'out'));
    e.lastOut = c.logs.join('\n'); after(true);
  },

  exec: (a, e) => {
    const it = a.includes('-it') || a.includes('-i');
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (c.status !== 'running') { sfx('err-syntax'); print(`Error: container ${c.name} is not running`, 'err'); after(false); return; }
    const cmd = a.slice(a.indexOf(key) + 1).join(' ');
    c.logs.push(`$ ${cmd}`);
    print(`(在 ${c.name} 中执行: ${cmd || '/bin/sh'})${it ? ' —— 非交互演示，命令已记录到容器日志' : ''}`, 'info');
    after(true);
  },

  tag: (a, e) => {
    const img = e.findImage(a[0] || '');
    if (!img) return err(`Error: No such image: ${a[0] || ''}`, e, 'err-network');
    const { repo, tag } = parseImageSpec(a[1] || '');
    if (!repo) return err('用法: docker tag <源镜像:标签> <目标镜像:标签>', e);
    e.addImage(repo, tag, img.layers, img.base);
    sfx('docker-image'); print(`已打标签 ${a[0]} → ${repo}:${tag}`, 'ok'); after(true);
  },

  inspect: (a, e) => {
    const key = a[0] || '';
    const c = e.findContainer(key);
    const img = !c && e.findImage(key);
    const obj = c ? { Id: c.id, Name: c.name, Image: c.image, State: { Status: c.status }, Ports: c.ports }
      : img ? { Id: img.id, RepoTags: [`${img.repo}:${img.tag}`], Layers: img.layers } : null;
    if (!obj) return err(`Error: No such object: ${key}`, e, 'err-network');
    const s = JSON.stringify(obj, null, 2);
    print(s, 'out'); e.lastOut = s; after(true);
  },

  network: (a, e) => {
    if (a[0] === 'ls') {
      const lines = ['NETWORK ID'.padEnd(14) + 'NAME'.padEnd(12) + 'DRIVER'];
      e.networks.forEach(n => lines.push(`${n.id.padEnd(14)}${n.name.padEnd(12)}${n.driver}`));
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (a[0] === 'create' && a[1]) {
      e.networks.push({ id: e.nextId(), name: a[1], driver: 'bridge' });
      sfx('net-connect'); print(a[1], 'ok'); after(true); return;
    }
    print('用法: docker network ls | docker network create <名称>', 'err'); after(false);
  },

  volume: (a, e) => {
    if (a[0] === 'ls') {
      const lines = ['DRIVER'.padEnd(10) + 'VOLUME NAME'];
      e.volumes.forEach(v => lines.push(`${'local'.padEnd(10)}${v.name}`));
      if (!e.volumes.length) lines.push('(空)');
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (a[0] === 'create' && a[1]) {
      e.volumes.push({ id: e.nextId(), name: a[1], mountpoint: `/var/lib/docker/volumes/${a[1]}` });
      sfx('file-create'); print(a[1], 'ok'); after(true); return;
    }
    print('用法: docker volume ls | docker volume create <名称>', 'err'); after(false);
  },
};

function err(msg, e, sfxName = 'err-syntax') {
  sfx(sfxName); print(msg, 'err'); after(false);
}

/* ============ docker-compose ============ */
// 解析极简 YAML 子集：services / image / build / ports / volumes
function parseCompose(content) {
  const services = {};
  let cur = null;
  let curListKey = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const line = raw.trim();
    if (line === 'services:') { cur = null; curListKey = null; continue; }
    if (indent === 2 && line.endsWith(':') && !line.startsWith('- ')) {
      cur = line.slice(0, -1); services[cur] = { image: null, build: null, ports: [], volumes: [] };
      curListKey = null; continue;
    }
    if (cur && line.startsWith('- ')) {
      if (curListKey) services[cur][curListKey].push(line.slice(2).replace(/["']/g, ''));
      continue;
    }
    if (cur && line.includes(':')) {
      const [k, ...v] = line.split(':');
      const val = v.join(':').trim().replace(/["']/g, '');
      if (k === 'image') { services[cur].image = val; curListKey = null; }
      else if (k === 'build') { services[cur].build = val || '.'; curListKey = null; }
      else if (k === 'ports' || k === 'volumes') { curListKey = k; }
      else curListKey = null;
    }
  }
  return services;
}

function runCompose(input, e) {
  const t = tokenize(input);
  const sub = t[1];
  const r = e.readFile('docker-compose.yml') || e.readFile('compose.yml');
  if (r.err) { sfx('err-file'); print('ERROR: Can\'t find a docker-compose.yml file in the current directory', 'err'); after(false); return; }
  const services = parseCompose(r.content);
  const names = Object.keys(services);
  if (!names.length) { sfx('err-syntax'); print('ERROR: compose 文件里没有 services', 'err'); after(false); return; }

  if (sub === 'up') {
    sfx('docker-build');
    for (const name of names) {
      const svc = services[name];
      let spec = svc.image;
      if (!spec && svc.build) {
        const df = e.readFile((svc.build === '.' ? '' : svc.build + '/') + 'Dockerfile');
        if (df.err) { print(`ERROR: Service ${name} failed to build: Dockerfile not found`, 'err'); continue; }
        const layers = df.content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        spec = `${e.cwd.split('/').pop() || 'app'}_${name}:latest`;
        e.addImage(spec.split(':')[0], 'latest', layers.length ? layers : ['FROM scratch'], null);
      }
      if (!spec) { print(`ERROR: Service ${name} has neither an image nor a build context`, 'err'); continue; }
      const img = e.findImage(spec) || e.addImage(spec.split(':')[0], spec.includes(':') ? spec.split(':')[1] : 'latest', ['FROM scratch'], null);
      if (e.containers.some(c => c.name === name && c.status === 'running')) continue;
      const old = e.containers.find(c => c.name === name);
      if (old) e.containers.splice(e.containers.indexOf(old), 1);
      e.createContainer(img, name, { ports: svc.ports });
      print(`Creating ${name} ... done`, 'ok');
    }
    sfx('docker-start');
    after(true); return;
  }
  if (sub === 'down') {
    for (const name of names) {
      const c = e.containers.find(x => x.name === name);
      if (c) { e.containers.splice(e.containers.indexOf(c), 1); print(`Removing ${name} ... done`, 'ok'); }
    }
    sfx('docker-stop'); after(true); return;
  }
  if (sub === 'ps') {
    const lines = ['NAME'.padEnd(14) + 'IMAGE'.padEnd(24) + 'STATUS'.padEnd(12) + 'PORTS'];
    for (const name of names) {
      const c = e.containers.find(x => x.name === name);
      lines.push(c
        ? `${c.name.padEnd(14)}${c.image.padEnd(24)}${(c.status === 'running' ? 'Up' : 'Exited').padEnd(12)}${c.ports.join(',') || '-'}`
        : `${name.padEnd(14)}${'-'.padEnd(24)}${'not running'.padEnd(12)}-`);
    }
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
  }
  if (sub === 'logs') {
    const key = t[2];
    const targets = key ? [key] : names;
    for (const name of targets) {
      const c = e.containers.find(x => x.name === name);
      if (c) c.logs.forEach(l => print(`${name} | ${l}`, 'out'));
    }
    after(true); return;
  }
  print('用法: docker-compose up [-d] | down | ps | logs [服务]', 'err'); after(false);
}

/* ============ SSH / SCP / RSYNC ============ */
const REMOTE_HOST = 'prod-server';

function runRemote(input, base, e) {
  const t = tokenize(input);
  if (base === 'ssh') {
    const target = t[1];
    if (!target || !target.includes('@')) { print('用法: ssh <用户>@<主机> [命令]', 'err'); sfx('err-syntax'); after(false); return; }
    const [user, host] = target.split('@');
    sfx('ssh-handshake');
    print(`Connecting to ${host}...`, 'dim');
    const cmd = t.slice(2).join(' ');
    if (cmd) {
      // 单命令模式
      const res = runRemoteCmd(cmd, e.remote);
      res.out.forEach(l => print(l, 'out'));
      e.lastOut = res.out.join('\n');
      print(`Connection to ${host} closed.`, 'dim');
    } else {
      e.sshHost = `${user}@${host}`;
      print(`Welcome to ${host} (GNU/Linux)`, 'info');
      print(`Last login: Sat Jul 25 09:12:33 2026 from 10.0.0.2`, 'dim');
      print(`提示：已进入远程主机，命令将在 ${host} 上执行，输入 exit 断开`, 'info');
    }
    after(true); return;
  }

  if (base === 'scp') {
    const args = t.slice(1).filter(x => !x.startsWith('-'));
    if (args.length < 2) { print('用法: scp <本地文件> <用户>@<主机>:<远程路径>  （或反向）', 'err'); sfx('err-syntax'); after(false); return; }
    const [src, dst] = args;
    sfx('ssh-transfer');
    if (dst.includes('@') && dst.includes(':')) {
      // 本地 → 远程
      const r = e.readFile(src);
      if (r.err) { sfx('err-file'); print(`scp: ${src}: No such file or directory`, 'err'); after(false); return; }
      const [tgt, path] = dst.split(':');
      const remotePath = path || '/home/user/';
      const finalPath = e.remote.isDir(remotePath) ? remotePath.replace(/\/$/, '') + '/' + e.basename(e.resolvePath(src)) : remotePath;
      e.remote.writeFile(finalPath, r.content);
      print(`${src}  100%  ${r.content.length}B  1.2MB/s  00:00`, 'out');
      print(`已传输到 ${tgt.split('@')[1]}:${finalPath}`, 'ok');
      e.lastOut = finalPath;
    } else if (src.includes('@') && src.includes(':')) {
      // 远程 → 本地
      const [tgt, path] = src.split(':');
      const r = e.remote.readFile(path);
      if (r.err) { sfx('err-file'); print(`scp: ${path}: No such file or directory`, 'err'); after(false); return; }
      const localPath = e.isDir(dst) ? dst.replace(/\/$/, '') + '/' + e.remote.basename(e.remote.resolvePath(path)) : dst;
      e.writeFile(localPath, r.content);
      print(`${path}  100%  ${r.content.length}B  1.2MB/s  00:00`, 'out');
      print(`已下载到 ${localPath}`, 'ok');
      e.lastOut = localPath;
    } else {
      print('scp: 需要指定 <用户>@<主机>:<路径> 形式的远程端', 'err'); sfx('err-syntax'); after(false); return;
    }
    after(true); return;
  }

  if (base === 'rsync') {
    const args = t.slice(1).filter(x => !x.startsWith('-'));
    const [src, dst] = args;
    if (!src || !dst) { print('用法: rsync -avz <源> <用户>@<主机>:<目标>', 'err'); sfx('err-syntax'); after(false); return; }
    sfx('ssh-transfer');
    if (dst.includes('@') && dst.includes(':')) {
      const r = e.readFile(src);
      if (r.err) { sfx('err-file'); print(`rsync: link_stat "${src}" failed: No such file or directory`, 'err'); after(false); return; }
      const path = dst.split(':')[1] || '/home/user/';
      const finalPath = e.remote.isDir(path) ? path.replace(/\/$/, '') + '/' + e.basename(e.resolvePath(src)) : path;
      e.remote.writeFile(finalPath, r.content);
      print('sending incremental file list');
      print(e.basename(e.resolvePath(src)));
      print(`sent ${r.content.length} bytes  received 35 bytes  ${(r.content.length / 1024 + 0.1).toFixed(2)} KB/sec`, 'out');
      e.lastOut = finalPath;
    } else {
      print('rsync: 目标必须是 <用户>@<主机>:<路径> 形式', 'err'); sfx('err-syntax'); after(false); return;
    }
    after(true); return;
  }
}
