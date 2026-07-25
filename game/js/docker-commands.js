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
      '  docker images [-q] [-a] [--filter 名=值] · docker ps [-a] [-q] [--filter 名=值] [--format 模板] [--size] [-l]',
      '  docker pull <镜像:标签> · docker history <镜像> · docker stats',
      '  docker build -t <名:标签> [-f Dockerfile] [--no-cache] [--build-arg K=V] [-q] .',
      '  docker run [-d] [-it] [--rm] [--name 名] [-p 主机:容器] [-e 键=值] [-v 源:目标] [-w 目录]',
      '             [--network 网络] [--restart 策略] [--entrypoint CMD] [--memory 512m] [--cpus 1.5]',
      '             [-l 键=值] [--env-file 文件] <镜像>',
      '  docker stop/start/restart/kill <容器> · docker logs [-f] [--tail N] <容器>',
      '  docker exec [-it] [-d] [-e K=V] [-w 目录] <容器> <命令>',
      '  docker tag <源> <目标> · docker rmi <镜像> · docker inspect <对象>',
      '  docker cp <容器>:<路径> <本地>  （反向亦可）',
      '  docker commit/diff/top/port/rename/pause/unpause/wait <容器>',
      '  docker export/save/load · docker container ls · docker image ls',
      '  docker system prune [-a] [--volumes] [-f] · docker system df · docker system info',
      '  docker network ls/create/rm/connect/disconnect/inspect',
      '  docker volume ls/create/rm/inspect/prune',
      '── Compose ──',
      '  docker-compose up -d · docker-compose down · docker-compose ps · docker-compose logs',
      '  docker-compose build/exec/restart/pull/config/stop/start',
      '── SSH / 传输 ──',
      '  ssh <用户>@<主机> [命令]   （会话中 exit 断开）',
      '  scp [-r] <本地文件> <用户>@<主机>:<路径>   （反向亦可，-r 递归传目录）',
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
  if (!fn) { sfx('err-syntax'); print(`docker: '${sub || ''}' is not a docker command. See 'docker --help'.`, 'err'); after(false); return; }
  fn(rest, e);
}

function flagVal(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// 支持 --flag=value 和 --flag value 两种写法
function flagVal2(args, flag) {
  const eq = args.find(x => x.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

// 收集所有某 flag 的值（支持 --flag=v 和 --flag v）
function flagVals(args, flag) {
  const vals = [];
  args.forEach((x, i) => { if (x === flag && args[i + 1]) vals.push(args[i + 1]); });
  args.forEach(x => { if (x.startsWith(flag + '=')) vals.push(x.slice(flag.length + 1)); });
  return vals;
}

function parseImageSpec(spec) {
  const [repo, tag = 'latest'] = (spec || '').includes(':') ? spec.split(':') : [spec, 'latest'];
  return { repo, tag };
}

const DOCKER = {
  images: (a, e) => {
    const quiet = a.includes('-q') || a.includes('--quiet');
    const all = a.includes('-a') || a.includes('--all');
    const filters = flagVals(a, '--filter').concat(flagVals(a, '-f'));

    let list = e.images.slice();
    for (const f of filters) {
      if (!f) continue;
      const eq = f.indexOf('=');
      if (eq < 0) continue;
      const key = f.slice(0, eq).trim(), val = f.slice(eq + 1).trim();
      if (key === 'dangling' && val === 'true') {
        const referenced = new Set(e.containers.map(c => c.image));
        list = list.filter(i => !referenced.has(`${i.repo}:${i.tag}`));
      } else if (key === 'reference') {
        list = list.filter(i => `${i.repo}:${i.tag}`.includes(val.replace(/\*/g, '')));
      }
    }

    if (quiet) {
      const lines = list.map(i => i.id);
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    const lines = ['REPOSITORY'.padEnd(28) + 'TAG'.padEnd(12) + 'IMAGE ID'.padEnd(14) + 'SIZE'];
    for (const i of list) lines.push(`${i.repo.padEnd(28)}${i.tag.padEnd(12)}${i.id.padEnd(14)}${i.size}MB`);
    if (!list.length) lines.push(all ? '(暂无镜像)' : '(暂无镜像 —— 用 docker pull 或 docker build 创建)');
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  ps: (a, e) => {
    const all = a.includes('-a') || a.includes('--all');
    const quiet = a.includes('-q') || a.includes('--quiet');
    const showSize = a.includes('--size') || a.includes('-s');
    const latest = a.includes('-l') || a.includes('--latest');
    // --filter key=value（可多次；支持 --filter=x 与 --filter x 两种写法）
    const filters = flagVals(a, '--filter').concat(flagVals(a, '-f'));
    // --format 模板
    let fmt = flagVal2(a, '--format');
    const statusOf = c => {
      if (c.paused) return 'Up 2 min (Paused)';
      return c.status === 'running' ? 'Up 2 min' : 'Exited (0)';
    };

    let list = all ? e.containers : e.containers.filter(c => c.status === 'running');
    if (latest && list.length) list = [list[list.length - 1]];
    for (const f of filters) {
      if (!f) continue;
      const eq = f.indexOf('=');
      if (eq < 0) continue;
      const key = f.slice(0, eq).trim(), val = f.slice(eq + 1).trim();
      if (key === 'name') list = list.filter(c => c.name.includes(val));
      else if (key === 'status') list = list.filter(c => c.status === val);
      else if (key === 'id') list = list.filter(c => c.id.startsWith(val));
      else if (key === 'ancestor' || key === 'image') list = list.filter(c => c.image.includes(val));
    }

    if (quiet) {
      const lines = list.map(c => c.id);
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (fmt) {
      const lines = list.map(c => fmt
        .replace(/\{\{\s*\.ID\s*\}\}/g, c.id)
        .replace(/\{\{\s*\.Names?\s*\}\}/g, c.name)
        .replace(/\{\{\s*\.Status\s*\}\}/g, statusOf(c))
        .replace(/\{\{\s*\.Image\s*\}\}/g, c.image)
        .replace(/\{\{\s*\.Ports\s*\}\}/g, c.ports.join(',') || '-')
        .replace(/\{\{\s*\.Command\s*\}\}/g, `"${c.cmd}"`)
        .replace(/\{\{\s*\.CreatedAt\s*\}\}/g, `${(c.createdAt || 1) * 2} minutes ago`));
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    let header = 'CONTAINER ID'.padEnd(14) + 'IMAGE'.padEnd(22) + 'STATUS'.padEnd(18) + 'PORTS'.padEnd(16) + 'NAMES';
    if (showSize) header += '  SIZE';
    const lines = [header];
    for (const c of list) {
      const st = statusOf(c);
      let line = `${c.id.padEnd(14)}${c.image.padEnd(22)}${st.padEnd(18)}${(c.ports.join(',') || '-').padEnd(16)}${c.name}`;
      if (showSize) line += `  ${(c.image.length * 7 + 42)}MB (virtual ${(c.image.length * 7 + 42)}MB)`;
      lines.push(line);
    }
    if (!list.length) lines.push(all ? '(没有任何容器)' : '(没有运行中的容器 —— docker ps -a 查看全部)');
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  pull: (a, e) => {
    const spec = a.filter(x => !x.startsWith('-'))[0];
    if (!spec) return err('Usage: docker pull [OPTIONS] NAME[:TAG]', e);
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
    const tagSpec = flagVal2(a, '-t') || flagVal2(a, '--tag');
    if (!tagSpec) return err('Usage: docker build -t <名称:标签> [-f Dockerfile] [--no-cache] [--build-arg K=V] [-q] .', e);
    const noCache = a.includes('--no-cache');
    const quiet = a.includes('-q') || a.includes('--quiet');
    const dockerfile = flagVal2(a, '-f') || flagVal2(a, '--file');
    const buildArgs = flagVals(a, '--build-arg');
    // 上下文目录 = 最后一个位置参数（排除带值 flag 的值）
    const valueFlags = ['-t', '--tag', '-f', '--file', '--build-arg'];
    const valueIdx = new Set();
    a.forEach((x, i) => { if (valueFlags.includes(x)) valueIdx.add(i + 1); });
    const positional = a.filter((x, i) => !x.startsWith('-') && !valueIdx.has(i) && !x.includes('='));
    const ctx = positional[positional.length - 1] || '.';
    const dir = ctx === '.' ? e.cwd : ctx;
    const dfPath = dockerfile || (dir === e.cwd ? '' : dir + '/') + 'Dockerfile';
    const r = e.readFile(dfPath);
    if (r.err) { sfx('err-file'); print(`unable to prepare context: path "${dfPath}" not found`, 'err'); after(false); return; }
    const lines = r.content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const layers = [];
    for (const l of lines) {
      const instr = l.split(/\s/)[0].toUpperCase();
      if (!['FROM', 'RUN', 'COPY', 'ADD', 'CMD', 'ENV', 'WORKDIR', 'EXPOSE', 'LABEL', 'ENTRYPOINT', 'ARG', 'USER', 'VOLUME'].includes(instr)) {
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
    if (!quiet) {
      if (noCache) print(`Sending build context to Docker daemon (--no-cache：不使用缓存)`, 'dim');
      if (buildArgs.length) print(`Build args: ${buildArgs.join(', ')}`, 'dim');
      layers.forEach((l, i) => print(`Step ${i + 1}/${layers.length} : ${l}`, 'dim'));
    }
    e.addImage(repo, tag, layers, base);
    const imgId = e.findImage(`${repo}:${tag}`).id;
    if (quiet) {
      print(imgId, 'out'); e.lastOut = imgId;
    } else {
      print(`Successfully built ${imgId}`, 'ok');
      print(`Successfully tagged ${repo}:${tag}`, 'ok');
      e.lastOut = `Successfully tagged ${repo}:${tag}`;
    }
    sfx('docker-image');
    after(true);
  },

  run: (a, e) => {
    const name = flagVal2(a, '--name');
    const ports = flagVals(a, '-p').concat(flagVals(a, '--publish'));
    const envs = flagVals(a, '-e').concat(flagVals(a, '--env'));
    const mounts = flagVals(a, '-v').concat(flagVals(a, '--volume'));
    const labels = flagVals(a, '-l').concat(flagVals(a, '--label'));
    const workdir = flagVal2(a, '-w') || flagVal2(a, '--workdir');
    const network = flagVal2(a, '--network');
    const restart = flagVal2(a, '--restart');
    const entrypoint = flagVal2(a, '--entrypoint');
    const memory = flagVal2(a, '--memory') || flagVal2(a, '-m');
    const cpus = flagVal2(a, '--cpus');
    const envFile = flagVal2(a, '--env-file');
    const detach = a.includes('-d') || a.includes('--detach');
    const autoRemove = a.includes('--rm');
    const interactive = a.includes('-i') || a.includes('--interactive') || a.includes('-it') || a.includes('-ti');
    const tty = a.includes('-t') || a.includes('--tty') || a.includes('-it') || a.includes('-ti');

    // 镜像名 = 第一个「非 flag 且不是带值 flag 的值」的参数
    const valueFlags = ['--name', '-p', '--publish', '-e', '--env', '-v', '--volume', '-w', '--workdir',
      '--network', '--restart', '--entrypoint', '--memory', '-m', '--cpus', '-l', '--label', '--env-file'];
    const valueIdx = new Set();
    a.forEach((x, i) => { if (valueFlags.includes(x)) valueIdx.add(i + 1); });
    const positional = a.filter((x, i) => !x.startsWith('-') && !valueIdx.has(i));
    const spec = positional[0];
    if (!spec) return err('Usage: docker run [OPTIONS] IMAGE [COMMAND] [ARG...]', e);
    const img = e.findImage(spec);
    if (!img) { sfx('err-network'); print(`Unable to find image '${spec}' locally (先 docker pull ${spec})`, 'err'); after(false); return; }

    // 解析环境变量
    const env = {};
    // --env-file 支持
    if (envFile) {
      const r = e.readFile(envFile);
      if (r.ok) {
        r.content.split('\n').forEach(line => {
          line = line.trim();
          if (!line || line.startsWith('#')) return;
          const eq = line.indexOf('=');
          if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
        });
      } else {
        print(`docker: Error: open ${envFile}: no such file or directory`, 'err');
      }
    }
    for (const kv of envs) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      env[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : kv.slice(eq + 1);
    }
    // 解析 labels
    const labelObj = {};
    for (const kv of labels) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      labelObj[eq < 0 ? kv : kv.slice(0, eq)] = eq < 0 ? '' : kv.slice(eq + 1);
    }
    const mountObjs = mounts.filter(Boolean).map(m => {
      const ci = m.indexOf(':');
      return ci < 0 ? { source: m, target: m } : { source: m.slice(0, ci), target: m.slice(ci + 1) };
    });
    const cmd = positional.slice(1).join(' ') || undefined;
    const c = e.createContainer(img, name, {
      ports, env, mounts: mountObjs, workdir, network, autoRemove,
      restart, labels: labelObj, entrypoint, memory, cpus,
      stdinOpen: interactive, tty, cmd,
    });
    sfx('docker-start');
    print(detach ? c.id : `${c.name} 已启动（前台模式按 Ctrl+C 退出）`, 'ok');
    if (!detach) print(`[${c.name}] ${c.logs[c.logs.length - 1]}`, 'dim');
    e.lastOut = c.id;
    after(true);
  },

  stop: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error response from daemon: No such container: ${key || ''}`, e, 'err-network');
    c.status = 'exited'; c.paused = false; sfx('docker-stop'); print(key, 'ok'); after(true);
  },

  start: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error response from daemon: No such container: ${key || ''}`, e, 'err-network');
    c.status = 'running'; c.paused = false; sfx('docker-start'); print(key, 'ok'); after(true);
  },

  restart: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error response from daemon: No such container: ${key || ''}`, e, 'err-network');
    c.status = 'running'; c.paused = false;
    c.logs.push(`--- container restarted ---`);
    sfx('docker-start'); print(key, 'ok'); after(true);
  },

  kill: (a, e) => {
    const signal = flagVal2(a, '-s') || flagVal2(a, '--signal') || 'KILL';
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error response from daemon: No such container: ${key || ''}`, e, 'err-network');
    c.status = 'exited'; c.paused = false;
    c.logs.push(`--- killed (signal ${signal}) ---`);
    sfx('docker-stop'); print(key, 'ok'); after(true);
  },

  rm: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (c.status === 'running' && !a.includes('-f') && !a.includes('--force')) {
      sfx('err-syntax'); print(`Error: Cannot remove a running container: ${c.name} (先 docker stop 或加 -f)`, 'err'); after(false); return;
    }
    e.containers.splice(e.containers.indexOf(c), 1);
    sfx('docker-stop'); print(key, 'ok'); after(true);
  },

  rmi: (a, e) => {
    const spec = a.filter(x => !x.startsWith('-'))[0];
    const img = e.findImage(spec || '');
    if (!img) return err(`Error: No such image: ${spec || ''}`, e, 'err-network');
    if (e.containers.some(c => c.image === `${img.repo}:${img.tag}`)) {
      sfx('err-syntax'); print(`Error: image is referenced by one or more containers (先删除容器)`, 'err'); after(false); return;
    }
    e.images.splice(e.images.indexOf(img), 1);
    sfx('file-delete'); print(`Untagged: ${spec}`, 'ok'); after(true);
  },

  logs: (a, e) => {
    const follow = a.includes('-f') || a.includes('--follow');
    const timestamps = a.includes('-t') || a.includes('--timestamps');
    const tail = flagVal2(a, '--tail');
    const since = flagVal2(a, '--since');
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    let lines = c.logs.slice();
    // --tail N
    if (tail && tail !== 'all') {
      const n = parseInt(tail, 10);
      if (!isNaN(n) && n > 0) lines = lines.slice(-n);
    }
    // --since 模拟：只显示包含 since 关键字之后的行（简化）
    if (since) {
      const idx = lines.findIndex(l => l.includes(since));
      if (idx >= 0) lines = lines.slice(idx);
    }
    const prefix = timestamps ? '2026-07-25T09:12:33.000000000Z ' : '';
    lines.forEach(l => print(prefix + l, 'out'));
    if (follow) print(`[follow 模式：实时跟踪 ${c.name} 日志，按 Ctrl+C 退出]`, 'dim');
    e.lastOut = lines.join('\n'); after(true);
  },

  exec: (a, e) => {
    const it = a.includes('-it') || a.includes('-i') || a.includes('-ti');
    const detach = a.includes('-d') || a.includes('--detach');
    const envs = flagVals(a, '-e').concat(flagVals(a, '--env'));
    const workdir = flagVal2(a, '-w') || flagVal2(a, '--workdir');
    // 找容器名：跳过所有 flag 及其值
    const skipFlags = new Set(['-e', '--env', '-w', '--workdir', '-u', '--user']);
    const skipIdx = new Set();
    a.forEach((x, i) => { if (skipFlags.has(x)) skipIdx.add(i + 1); });
    const positional = a.filter((x, i) => !x.startsWith('-') && !skipIdx.has(i));
    const key = positional[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (c.status !== 'running') { sfx('err-syntax'); print(`Error: container ${c.name} is not running`, 'err'); after(false); return; }
    const cmd = positional.slice(1).join(' ');
    if (detach) {
      c.logs.push(`$ ${cmd} (detached)`);
      print(`${e.nextId()}`, 'out');
      e.lastOut = 'exec started in background'; after(true); return;
    }
    const envStr = envs.length ? ` [env: ${envs.join(',')}]` : '';
    const wdStr = workdir ? ` [workdir: ${workdir}]` : '';
    c.logs.push(`$ ${cmd}${envStr}${wdStr}`);
    print(`(在 ${c.name} 中执行: ${cmd || '/bin/sh'})${it ? ' —— 非交互演示，命令已记录到容器日志' : ''}${envStr}${wdStr}`, 'info');
    e.lastOut = `exec: ${cmd}`; after(true);
  },

  tag: (a, e) => {
    const img = e.findImage(a[0] || '');
    if (!img) return err(`Error: No such image: ${a[0] || ''}`, e, 'err-network');
    const { repo, tag } = parseImageSpec(a[1] || '');
    if (!repo) return err('Usage: docker tag <源镜像:标签> <目标镜像:标签>', e);
    e.addImage(repo, tag, img.layers, img.base);
    sfx('docker-image'); print(`已打标签 ${a[0]} → ${repo}:${tag}`, 'ok'); after(true);
  },

  inspect: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0] || '';
    const c = e.findContainer(key);
    const img = !c && e.findImage(key);
    const net = !c && !img && e.networks.find(n => n.name === key || n.id === key);
    const vol = !c && !img && !net && e.volumes.find(v => v.name === key || v.id === key);
    let obj = null;
    if (c) {
      obj = {
        Id: c.id, Name: c.name, Image: c.image,
        State: { Status: c.status, Paused: !!c.paused, Running: c.status === 'running' },
        Ports: c.ports, Env: c.env || {}, Mounts: c.mounts || [],
        Workdir: c.workdir || '/', NetworkMode: c.network || 'bridge',
        AutoRemove: !!c.autoRemove, RestartPolicy: c.restart || 'no',
        Labels: c.labels || {}, Entrypoint: c.entrypoint,
        Memory: c.memory, Cpus: c.cpus,
      };
    } else if (img) {
      obj = { Id: img.id, RepoTags: [`${img.repo}:${img.tag}`], Layers: img.layers, Size: img.size };
    } else if (net) {
      obj = { Id: net.id, Name: net.name, Driver: net.driver, Scope: 'local' };
    } else if (vol) {
      obj = { Name: vol.name, Driver: 'local', Mountpoint: vol.mountpoint };
    }
    if (!obj) return err(`Error: No such object: ${key}`, e, 'err-network');
    const s = JSON.stringify(obj, null, 2);
    print(s, 'out'); e.lastOut = s; after(true);
  },

  // ── commit ──
  commit: (a, e) => {
    const positional = a.filter(x => !x.startsWith('-'));
    const key = positional[0];
    const target = positional[1];
    if (!key || !target) return err('Usage: docker commit CONTAINER REPOSITORY[:TAG]', e);
    const c = e.findContainer(key);
    if (!c) return err(`Error: No such container: ${key}`, e, 'err-network');
    const { repo, tag } = parseImageSpec(target);
    const img = e.addImage(repo, tag, [`FROM ${c.image}`, `COMMIT ${c.name}`, `CMD ${c.cmd}`], c.image);
    sfx('docker-image'); print(img.id, 'ok'); e.lastOut = img.id; after(true);
  },

  // ── diff ──
  diff: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    const files = Object.keys(c.files || {});
    const lines = [];
    if (files.length) {
      files.forEach(f => lines.push(`A ${f}`));
    } else {
      lines.push('C /tmp');
      lines.push('A /tmp/app.log');
    }
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  // ── top ──
  top: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (c.status !== 'running') { sfx('err-syntax'); print(`Error: container ${c.name} is not running`, 'err'); after(false); return; }
    const lines = ['UID'.padEnd(8) + 'PID'.padEnd(8) + 'PPID'.padEnd(8) + 'CMD'];
    lines.push(`${'root'.padEnd(8)}${'1'.padEnd(8)}${'0'.padEnd(8)}${c.cmd}`);
    lines.push(`${'root'.padEnd(8)}${'42'.padEnd(8)}${'1'.padEnd(8)}/bin/sh -c "healthcheck"`);
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  // ── port ──
  port: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (!c.ports.length) {
      e.lastOut = ''; after(true); return;
    }
    const lines = c.ports.map(p => {
      const parts = p.split(':');
      const host = parts[0], container = parts[1] || parts[0];
      return `${container}/tcp -> 0.0.0.0:${host}`;
    });
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  // ── rename ──
  rename: (a, e) => {
    const positional = a.filter(x => !x.startsWith('-'));
    const [oldName, newName] = positional;
    if (!oldName || !newName) return err('Usage: docker rename CONTAINER NEW_NAME', e);
    const c = e.findContainer(oldName);
    if (!c) return err(`Error: No such container: ${oldName}`, e, 'err-network');
    if (e.containers.some(x => x.name === newName)) {
      sfx('err-syntax'); print(`Error: Conflict. The container name "/${newName}" is already in use`, 'err'); after(false); return;
    }
    c.name = newName;
    sfx('ui-close'); print(`${oldName} → ${newName}`, 'ok'); e.lastOut = newName; after(true);
  },

  // ── pause / unpause ──
  pause: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (c.status !== 'running') { sfx('err-syntax'); print(`Error: container ${c.name} is not running`, 'err'); after(false); return; }
    if (c.paused) { sfx('err-syntax'); print(`Error: container ${c.name} is already paused`, 'err'); after(false); return; }
    c.paused = true;
    sfx('docker-stop'); print(key, 'ok'); after(true);
  },

  unpause: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    if (!c.paused) { sfx('err-syntax'); print(`Error: container ${c.name} is not paused`, 'err'); after(false); return; }
    c.paused = false;
    sfx('docker-start'); print(key, 'ok'); after(true);
  },

  // ── wait ──
  wait: (a, e) => {
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    print('0', 'out'); e.lastOut = '0'; after(true);
  },

  // ── export / save / load ──
  export: (a, e) => {
    const output = flagVal2(a, '-o') || flagVal2(a, '--output');
    const key = a.filter(x => !x.startsWith('-'))[0];
    const c = e.findContainer(key || '');
    if (!c) return err(`Error: No such container: ${key || ''}`, e, 'err-network');
    const fname = output || `${c.name}.tar`;
    e.writeFile(fname, `(模拟 tar 归档：容器 ${c.name} 的文件系统快照)\n`);
    sfx('file-copy'); print(`Exported ${c.name} → ${fname}`, 'ok'); e.lastOut = fname; after(true);
  },

  save: (a, e) => {
    const output = flagVal2(a, '-o') || flagVal2(a, '--output');
    const spec = a.filter(x => !x.startsWith('-'))[0];
    const img = e.findImage(spec || '');
    if (!img) return err(`Error: No such image: ${spec || ''}`, e, 'err-network');
    const fname = output || `${img.repo.replace(/[/\\:]/g, '_')}.tar`;
    e.writeFile(fname, `(模拟 tar 归档：镜像 ${img.repo}:${img.tag})\n`);
    sfx('file-copy'); print(`Saved image ${img.repo}:${img.tag} → ${fname}`, 'ok'); e.lastOut = fname; after(true);
  },

  load: (a, e) => {
    const input = flagVal2(a, '-i') || flagVal2(a, '--input');
    const fname = input || a.filter(x => !x.startsWith('-'))[0];
    if (!fname) return err('Usage: docker load -i <tar 文件>', e);
    const r = e.readFile(fname);
    if (r.err) return err(`Error: open ${fname}: no such file or directory`, e, 'err-file');
    const base = fname.replace(/\.tar(\.gz)?$/, '').replace(/_/g, '/');
    e.addImage(base || 'loaded-image', 'latest', ['FROM scratch', 'LOAD imported'], null);
    sfx('docker-image'); print(`Loaded image: ${base || 'loaded-image'}:latest`, 'ok'); e.lastOut = `Loaded image: ${base}:latest`; after(true);
  },

  // ── container 子命令（别名） ──
  container: (a, e) => {
    const sub = a[0];
    if (sub === 'ls' || sub === 'list' || sub === 'ps') { DOCKER.ps(a.slice(1), e); return; }
    if (sub === 'inspect') { DOCKER.inspect(a.slice(1), e); return; }
    if (sub === 'rm') { DOCKER.rm(a.slice(1), e); return; }
    if (sub === 'stop') { DOCKER.stop(a.slice(1), e); return; }
    if (sub === 'start') { DOCKER.start(a.slice(1), e); return; }
    if (sub === 'restart') { DOCKER.restart(a.slice(1), e); return; }
    if (sub === 'logs') { DOCKER.logs(a.slice(1), e); return; }
    if (sub === 'exec') { DOCKER.exec(a.slice(1), e); return; }
    if (sub === 'rename') { DOCKER.rename(a.slice(1), e); return; }
    if (sub === 'prune') {
      const force = a.includes('-f') || a.includes('--force');
      const stopped = e.containers.filter(c => c.status === 'exited');
      if (!force) {
        print(`WARNING! This will remove all stopped containers.`, 'warn');
        print('加 -f 确认执行：docker container prune -f', 'info');
        e.lastOut = 'prune preview'; after(false); return;
      }
      for (const c of stopped) e.containers.splice(e.containers.indexOf(c), 1);
      sfx('docker-stop'); print(`Deleted ${stopped.length} stopped container(s).`, 'ok');
      e.lastOut = `Deleted ${stopped.length}`; after(true); return;
    }
    print(`Usage: docker container ls|inspect|rm|stop|start|restart|logs|exec|rename|prune`, 'err'); after(false);
  },

  // ── image 子命令（别名） ──
  image: (a, e) => {
    const sub = a[0];
    if (sub === 'ls' || sub === 'list' || sub === 'images') { DOCKER.images(a.slice(1), e); return; }
    if (sub === 'inspect') { DOCKER.inspect(a.slice(1), e); return; }
    if (sub === 'rm') { DOCKER.rmi(a.slice(1), e); return; }
    if (sub === 'build') { DOCKER.build(a.slice(1), e); return; }
    if (sub === 'pull') { DOCKER.pull(a.slice(1), e); return; }
    if (sub === 'tag') { DOCKER.tag(a.slice(1), e); return; }
    if (sub === 'history') { DOCKER.history(a.slice(1), e); return; }
    if (sub === 'prune') {
      const force = a.includes('-f') || a.includes('--force');
      const referenced = new Set(e.containers.map(c => c.image));
      const dangling = e.images.filter(i => !referenced.has(`${i.repo}:${i.tag}`));
      if (!force) {
        print(`WARNING! This will remove all dangling images.`, 'warn');
        print('加 -f 确认执行：docker image prune -f', 'info');
        e.lastOut = 'prune preview'; after(false); return;
      }
      let reclaimed = 0;
      for (const i of dangling) { reclaimed += i.size; e.images.splice(e.images.indexOf(i), 1); }
      sfx('file-delete'); print(`Deleted ${dangling.length} dangling image(s). Total reclaimed: ${reclaimed}MB`, 'ok');
      e.lastOut = `reclaimed ${reclaimed}MB`; after(true); return;
    }
    print(`Usage: docker image ls|inspect|rm|build|pull|tag|history|prune`, 'err'); after(false);
  },

  network: (a, e) => {
    const sub = a[0];
    if (sub === 'ls' || sub === 'list') {
      const quiet = a.includes('-q') || a.includes('--quiet');
      if (quiet) {
        const lines = e.networks.map(n => n.id);
        lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
      }
      const lines = ['NETWORK ID'.padEnd(14) + 'NAME'.padEnd(12) + 'DRIVER'.padEnd(10) + 'SCOPE'];
      e.networks.forEach(n => lines.push(`${n.id.padEnd(14)}${n.name.padEnd(12)}${n.driver.padEnd(10)}local`));
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (sub === 'create') {
      const name = a.filter(x => !x.startsWith('-'))[1];
      if (!name) return err('Usage: docker network create [OPTIONS] NETWORK', e);
      const driver = flagVal2(a, '-d') || flagVal2(a, '--driver') || 'bridge';
      if (e.networks.some(n => n.name === name)) {
        sfx('err-syntax'); print(`Error: network with name ${name} already exists`, 'err'); after(false); return;
      }
      const net = { id: e.nextId(), name, driver };
      e.networks.push(net);
      sfx('net-connect'); print(net.id, 'ok'); e.lastOut = net.id; after(true); return;
    }
    if (sub === 'rm' || sub === 'remove') {
      const name = a[1];
      if (!name) return err('Usage: docker network rm NETWORK [NETWORK...]', e);
      const net = e.networks.find(n => n.name === name);
      if (!net) return err(`Error: No such network: ${name}`, e, 'err-network');
      if (['bridge', 'host', 'none'].includes(net.name)) {
        sfx('err-syntax'); print(`Error: ${name} is a pre-defined network and cannot be removed`, 'err'); after(false); return;
      }
      if (e.containers.some(c => c.status === 'running' && (c.network || 'bridge') === name)) {
        sfx('err-syntax'); print(`Error: network ${name} has active endpoints (正被运行中的容器使用)`, 'err'); after(false); return;
      }
      e.networks.splice(e.networks.indexOf(net), 1);
      sfx('net-connect'); print(name, 'ok'); after(true); return;
    }
    if (sub === 'connect') {
      const positional = a.filter(x => !x.startsWith('-'));
      const [netName, ctrName] = [positional[1], positional[2]];
      if (!netName || !ctrName) return err('Usage: docker network connect NETWORK CONTAINER', e);
      const net = e.networks.find(n => n.name === netName);
      if (!net) return err(`Error: No such network: ${netName}`, e, 'err-network');
      const c = e.findContainer(ctrName);
      if (!c) return err(`Error: No such container: ${ctrName}`, e, 'err-network');
      c.network = netName;
      sfx('net-connect'); print(`Connected ${ctrName} to ${netName}`, 'ok'); after(true); return;
    }
    if (sub === 'disconnect') {
      const positional = a.filter(x => !x.startsWith('-'));
      const [netName, ctrName] = [positional[1], positional[2]];
      if (!netName || !ctrName) return err('Usage: docker network disconnect NETWORK CONTAINER', e);
      const net = e.networks.find(n => n.name === netName);
      if (!net) return err(`Error: No such network: ${netName}`, e, 'err-network');
      const c = e.findContainer(ctrName);
      if (!c) return err(`Error: No such container: ${ctrName}`, e, 'err-network');
      c.network = 'bridge';
      sfx('net-connect'); print(`Disconnected ${ctrName} from ${netName}`, 'ok'); after(true); return;
    }
    if (sub === 'inspect') {
      const name = a.filter(x => !x.startsWith('-'))[1];
      if (!name) return err('Usage: docker network inspect NETWORK', e);
      const net = e.networks.find(n => n.name === name || n.id === name);
      if (!net) return err(`Error: No such network: ${name}`, e, 'err-network');
      const attached = e.containers.filter(c => (c.network || 'bridge') === net.name);
      const obj = {
        Id: net.id, Name: net.name, Driver: net.driver, Scope: 'local',
        Containers: Object.fromEntries(attached.map(c => [c.id, { Name: c.name, IPv4Address: '172.17.0.2/16' }])),
      };
      const s = JSON.stringify(obj, null, 2);
      print(s, 'out'); e.lastOut = s; after(true); return;
    }
    print('Usage: docker network ls|create|rm|connect|disconnect|inspect', 'err'); after(false);
  },

  volume: (a, e) => {
    const sub = a[0];
    if (sub === 'ls' || sub === 'list') {
      const quiet = a.includes('-q') || a.includes('--quiet');
      if (quiet) {
        const lines = e.volumes.map(v => v.name);
        lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
      }
      const lines = ['DRIVER'.padEnd(10) + 'VOLUME NAME'];
      e.volumes.forEach(v => lines.push(`${'local'.padEnd(10)}${v.name}`));
      if (!e.volumes.length) lines.push('(空)');
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (sub === 'create') {
      const name = a.filter(x => !x.startsWith('-'))[1];
      if (!name) return err('Usage: docker volume create [OPTIONS] [VOLUME]', e);
      if (e.volumes.some(v => v.name === name)) {
        print(name, 'ok'); e.lastOut = name; after(true); return;
      }
      e.volumes.push({ id: e.nextId(), name, mountpoint: `/var/lib/docker/volumes/${name}/_data` });
      sfx('file-create'); print(name, 'ok'); e.lastOut = name; after(true); return;
    }
    if (sub === 'rm' || sub === 'remove') {
      const name = a[1];
      if (!name) return err('Usage: docker volume rm VOLUME [VOLUME...]', e);
      const vol = e.volumes.find(v => v.name === name);
      if (!vol) return err(`Error: No such volume: ${name}`, e, 'err-network');
      if (e.containers.some(c => c.status === 'running' && (c.mounts || []).some(m => m.source === name))) {
        sfx('err-syntax'); print(`Error: volume ${name} is in use by a running container (正被运行中的容器挂载)`, 'err'); after(false); return;
      }
      e.volumes.splice(e.volumes.indexOf(vol), 1);
      sfx('file-delete'); print(name, 'ok'); after(true); return;
    }
    if (sub === 'inspect') {
      const name = a.filter(x => !x.startsWith('-'))[1];
      if (!name) return err('Usage: docker volume inspect VOLUME', e);
      const vol = e.volumes.find(v => v.name === name || v.id === name);
      if (!vol) return err(`Error: No such volume: ${name}`, e, 'err-network');
      const obj = { Name: vol.name, Driver: 'local', Mountpoint: vol.mountpoint, Scope: 'local' };
      const s = JSON.stringify([obj], null, 2);
      print(s, 'out'); e.lastOut = s; after(true); return;
    }
    if (sub === 'prune') {
      const force = a.includes('-f') || a.includes('--force');
      const unused = e.volumes.filter(v =>
        !e.containers.some(c => (c.mounts || []).some(m => m.source === v.name)));
      if (!force) {
        print('WARNING! This will remove all local volumes not used by at least one container.', 'warn');
        print('加 -f 确认执行：docker volume prune -f', 'info');
        e.lastOut = 'prune preview'; after(false); return;
      }
      let reclaimed = 0;
      for (const v of unused) { reclaimed += 64; e.volumes.splice(e.volumes.indexOf(v), 1); }
      sfx('file-delete'); print(`Deleted ${unused.length} volume(s). Total reclaimed space: ${reclaimed}MB`, 'ok');
      e.lastOut = `reclaimed ${reclaimed}MB`; after(true); return;
    }
    print('Usage: docker volume ls|create|rm|inspect|prune', 'err'); after(false);
  },

  system: (a, e) => {
    const sub = a[0];
    if (sub === 'prune') {
      const force = a.includes('-f') || a.includes('--force');
      const all = a.includes('-a') || a.includes('--all');
      const withVolumes = a.includes('--volumes');
      const stopped = e.containers.filter(c => c.status === 'exited');
      const referenced = new Set(e.containers.filter(c => c.status !== 'exited').map(c => c.image));
      const dangling = e.images.filter(i => !referenced.has(`${i.repo}:${i.tag}`));
      const unusedVols = withVolumes
        ? e.volumes.filter(v => !e.containers.some(c => (c.mounts || []).some(m => m.source === v.name)))
        : [];
      if (!force) {
        print('WARNING! This will remove:', 'warn');
        print(`  - ${stopped.length} 个已停止的容器`, 'dim');
        print(`  - ${dangling.length} 个${all ? '未使用的' : '悬空'}镜像`, 'dim');
        if (withVolumes) print(`  - ${unusedVols.length} 个未使用的卷`, 'dim');
        print('加 -f 确认执行：docker system prune -f', 'info');
        e.lastOut = 'prune preview'; after(false); return;
      }
      let reclaimed = 0;
      for (const c of stopped) e.containers.splice(e.containers.indexOf(c), 1);
      for (const i of dangling) { reclaimed += i.size; e.images.splice(e.images.indexOf(i), 1); }
      for (const v of unusedVols) { reclaimed += 64; e.volumes.splice(e.volumes.indexOf(v), 1); }
      sfx('docker-stop');
      print(`Deleted ${stopped.length} stopped container(s), ${dangling.length} image(s)${withVolumes ? `, ${unusedVols.length} volume(s)` : ''}.`, 'ok');
      print(`Total reclaimed space: ${reclaimed}MB`, 'ok');
      e.lastOut = `reclaimed ${reclaimed}MB`; after(true); return;
    }
    if (sub === 'df') {
      const lines = ['TYPE'.padEnd(14) + 'TOTAL'.padEnd(10) + 'ACTIVE'.padEnd(10) + 'SIZE'.padEnd(12) + 'RECLAIMABLE'];
      const imgSize = e.images.reduce((s, i) => s + i.size, 0);
      const activeContainers = e.containers.filter(c => c.status === 'running').length;
      const volSize = e.volumes.length * 64;
      lines.push(`${'Images'.padEnd(14)}${String(e.images.length).padEnd(10)}${'-'.padEnd(10)}${(imgSize + 'MB').padEnd(12)}${imgSize}MB`);
      lines.push(`${'Containers'.padEnd(14)}${String(e.containers.length).padEnd(10)}${String(activeContainers).padEnd(10)}${(e.containers.length * 3 + 'MB').padEnd(12)}${e.containers.length * 3}MB`);
      lines.push(`${'Local Volumes'.padEnd(14)}${String(e.volumes.length).padEnd(10)}${'-'.padEnd(10)}${(volSize + 'MB').padEnd(12)}${volSize}MB`);
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (sub === 'info') {
      const lines = [
        'Client:',
        ' Version:           24.0.7',
        ' API version:       1.43',
        ' OS/Arch:           linux/amd64',
        '',
        'Server:',
        ` Containers: ${e.containers.length}`,
        `  Running: ${e.containers.filter(c => c.status === 'running').length}`,
        `  Paused: ${e.containers.filter(c => c.paused).length}`,
        `  Stopped: ${e.containers.filter(c => c.status === 'exited').length}`,
        ` Images: ${e.images.length}`,
        ' Storage Driver: overlay2',
        ' Logging Driver: json-file',
        ` Networks: ${e.networks.length}`,
        ` Volumes: ${e.volumes.length}`,
        ' Operating System: TermQuest Linux',
        ' Architecture: x86_64',
        ' CPUs: 4',
        ' Total Memory: 7.77GiB',
      ];
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    print('Usage: docker system prune [-a] [--volumes] [-f] | docker system df | docker system info', 'err'); after(false);
  },

  stats: (a, e) => {
    const running = e.containers.filter(c => c.status === 'running');
    const lines = ['CONTAINER ID'.padEnd(14) + 'NAME'.padEnd(16) + 'CPU %'.padEnd(10) + 'MEM USAGE / LIMIT'.padEnd(22) + 'MEM %'.padEnd(10) + 'PIDS'];
    for (const c of running) {
      let h = 0; for (const ch of c.id + c.name) h = (h * 31 + ch.charCodeAt(0)) % 997;
      const cpu = ((h % 400) / 10 + 0.3).toFixed(2);
      const memMb = (h % 380) + 24;
      const memPct = ((h % 29) / 10 + 0.4).toFixed(2);
      const pids = (h % 18) + 2;
      lines.push(`${c.id.padEnd(14)}${c.name.padEnd(16)}${cpu.padEnd(10)}${(memMb + 'MiB / 2GiB').padEnd(22)}${memPct.padEnd(10)}${pids}`);
    }
    if (!running.length) lines.push('(没有运行中的容器)');
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  history: (a, e) => {
    const spec = a.filter(x => !x.startsWith('-'))[0];
    if (!spec) return err('Usage: docker history [OPTIONS] IMAGE', e);
    const img = e.findImage(spec);
    if (!img) return err(`Error: No such image: ${spec}`, e, 'err-network');
    const quiet = a.includes('-q') || a.includes('--quiet');
    if (quiet) {
      const lines = img.layers.map((_, i) => i === 0 ? img.id : '<missing>');
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    const lines = ['IMAGE'.padEnd(14) + 'CREATED BY'.padEnd(42) + 'SIZE'];
    const rev = img.layers.slice().reverse();
    rev.forEach((l, i) => {
      const id = i === 0 ? img.id : '<missing>';
      lines.push(`${id.padEnd(14)}${l.padEnd(42)}${(l.length * 3 + 7)}B`);
    });
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  cp: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    const [src, dst] = pos;
    if (!src || !dst) return err('Usage: docker cp CONTAINER:SRC_PATH DEST_PATH  (or reverse)', e);
    const parseSpec = s => {
      const i = s.indexOf(':');
      return i < 0 ? { ctr: null, path: s } : { ctr: s.slice(0, i), path: s.slice(i + 1) };
    };
    const S = parseSpec(src), D = parseSpec(dst);
    if (S.ctr && !D.ctr) {
      const c = e.findContainer(S.ctr);
      if (!c) return err(`Error: No such container: ${S.ctr}`, e, 'err-network');
      c.files = c.files || {};
      const content = c.files[S.path] !== undefined ? c.files[S.path] : `(模拟内容：来自 ${c.name} 的 ${S.path})\n`;
      const localPath = e.isDir(dst) ? dst.replace(/\/$/, '') + '/' + e.basename(S.path) : dst;
      e.writeFile(localPath, content);
      sfx('file-copy'); print(`Successfully copied ${localPath}`, 'ok'); e.lastOut = localPath; after(true); return;
    }
    if (D.ctr && !S.ctr) {
      const c = e.findContainer(D.ctr);
      if (!c) return err(`Error: No such container: ${D.ctr}`, e, 'err-network');
      const r = e.readFile(src);
      if (r.err) return err(`Error: lstat ${src}: no such file or directory`, e, 'err-file');
      c.files = c.files || {};
      const target = D.path.endsWith('/') ? D.path + e.basename(e.resolvePath(src)) : D.path;
      c.files[target] = r.content;
      sfx('file-copy'); print(`Successfully copied ${src} → ${c.name}:${target}`, 'ok'); e.lastOut = target; after(true); return;
    }
    return err('Usage: docker cp CONTAINER:SRC_PATH DEST_PATH  (only one side can be a container)', e);
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
    const removeVolumes = t.includes('-v') || t.includes('--volumes');
    for (const name of names) {
      const c = e.containers.find(x => x.name === name);
      if (c) { e.containers.splice(e.containers.indexOf(c), 1); print(`Removing ${name} ... done`, 'ok'); }
    }
    if (removeVolumes) print('Removing volumes ... done', 'ok');
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
    const key = t[2] && !t[2].startsWith('-') ? t[2] : null;
    const targets = key ? [key] : names;
    const outLines = [];
    for (const name of targets) {
      const c = e.containers.find(x => x.name === name);
      if (c) c.logs.forEach(l => { print(`${name} | ${l}`, 'out'); outLines.push(`${name} | ${l}`); });
    }
    e.lastOut = outLines.join('\n'); after(true); return;
  }
  if (sub === 'build') {
    sfx('docker-build');
    for (const name of names) {
      const svc = services[name];
      if (!svc.build) { print(`Service ${name} has no build context, skipping`, 'dim'); continue; }
      const df = e.readFile((svc.build === '.' ? '' : svc.build + '/') + 'Dockerfile');
      if (df.err) { print(`ERROR: Service ${name} failed to build: Dockerfile not found`, 'err'); continue; }
      const layers = df.content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
      const spec = svc.image || `${e.cwd.split('/').pop() || 'app'}_${name}:latest`;
      e.addImage(spec.split(':')[0], spec.includes(':') ? spec.split(':')[1] : 'latest', layers.length ? layers : ['FROM scratch'], null);
      print(`Building ${name} ... done`, 'ok');
    }
    sfx('docker-image'); after(true); return;
  }
  if (sub === 'exec') {
    const svcName = t[2];
    const cmd = t.slice(3).join(' ');
    if (!svcName) { print('Usage: docker-compose exec SERVICE COMMAND', 'err'); after(false); return; }
    const c = e.containers.find(x => x.name === svcName);
    if (!c) { print(`ERROR: No such service: ${svcName}`, 'err'); after(false); return; }
    if (c.status !== 'running') { print(`ERROR: Service ${svcName} is not running`, 'err'); after(false); return; }
    c.logs.push(`$ ${cmd}`);
    print(`(在 ${svcName} 中执行: ${cmd || '/bin/sh'})`, 'info');
    e.lastOut = `exec: ${cmd}`; after(true); return;
  }
  if (sub === 'restart') {
    const target = t[2] && !t[2].startsWith('-') ? t[2] : null;
    const targets = target ? [target] : names;
    for (const name of targets) {
      const c = e.containers.find(x => x.name === name);
      if (c) { c.status = 'running'; c.paused = false; c.logs.push('--- restarted ---'); print(`Restarting ${name} ... done`, 'ok'); }
    }
    sfx('docker-start'); after(true); return;
  }
  if (sub === 'stop') {
    const target = t[2] && !t[2].startsWith('-') ? t[2] : null;
    const targets = target ? [target] : names;
    for (const name of targets) {
      const c = e.containers.find(x => x.name === name);
      if (c) { c.status = 'exited'; print(`Stopping ${name} ... done`, 'ok'); }
    }
    sfx('docker-stop'); after(true); return;
  }
  if (sub === 'start') {
    const target = t[2] && !t[2].startsWith('-') ? t[2] : null;
    const targets = target ? [target] : names;
    for (const name of targets) {
      const c = e.containers.find(x => x.name === name);
      if (c) { c.status = 'running'; print(`Starting ${name} ... done`, 'ok'); }
    }
    sfx('docker-start'); after(true); return;
  }
  if (sub === 'pull') {
    sfx('docker-pull');
    for (const name of names) {
      const svc = services[name];
      if (!svc.image) { print(`Service ${name} uses build, skipping pull`, 'dim'); continue; }
      const { repo, tag } = parseImageSpec(svc.image);
      e.addImage(repo, tag, [`FROM scratch`, `ADD ${repo}:${tag} /`, `CMD ["/bin/sh"]`], null);
      print(`Pulling ${name} (${svc.image}) ... done`, 'ok');
    }
    after(true); return;
  }
  if (sub === 'config') {
    const out = { services: {} };
    for (const name of names) {
      const svc = services[name];
      out.services[name] = {
        image: svc.image || undefined,
        build: svc.build || undefined,
        ports: svc.ports.length ? svc.ports : undefined,
        volumes: svc.volumes.length ? svc.volumes : undefined,
      };
    }
    const s = JSON.stringify(out, null, 2);
    print(s, 'out'); e.lastOut = s; after(true); return;
  }
  print('Usage: docker-compose up [-d] | down [-v] | ps | logs [服务] | build | exec | restart | stop | start | pull | config', 'err'); after(false);
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
    const recursive = t.includes('-r');
    const args = t.slice(1).filter(x => !x.startsWith('-'));
    if (args.length < 2) { print('用法: scp [-r] <本地文件> <用户>@<主机>:<远程路径>  （或反向）', 'err'); sfx('err-syntax'); after(false); return; }
    const [src, dst] = args;
    sfx('ssh-transfer');
    if (dst.includes('@') && dst.includes(':')) {
      const [tgt, path] = dst.split(':');
      const remotePath = path || '/home/user/';
      if (recursive && e.isDir(src)) {
        const baseName = e.basename(e.resolvePath(src));
        const files = e.walk(src);
        const remoteBase = remotePath.replace(/\/$/, '');
        const mkdirp = p => {
          const segs = e.remote.resolvePath(p).split('/').filter(Boolean);
          let cur = '';
          for (const s of segs) { cur += '/' + s; if (!e.remote.isDir(cur)) e.remote.mkdir(cur); }
        };
        let count = 0, total = 0;
        for (const rel of files) {
          const r = e.readFile(src + '/' + rel);
          if (r.ok) {
            const target = remoteBase + '/' + baseName + '/' + rel;
            mkdirp(e.remote.dirname(target));
            e.remote.writeFile(target, r.content);
            count++; total += r.content.length;
          }
        }
        print(`${src}/  100%  ${total}B  ${count} 个文件  1.2MB/s  00:00`, 'out');
        print(`已传输到 ${tgt.split('@')[1]}:${remoteBase}/${baseName}/（${count} 个文件）`, 'ok');
        e.lastOut = remoteBase + '/' + baseName;
      } else {
        const r = e.readFile(src);
        if (r.err) { sfx('err-file'); print(`scp: ${src}: No such file or directory`, 'err'); after(false); return; }
        const finalPath = e.remote.isDir(remotePath) ? remotePath.replace(/\/$/, '') + '/' + e.basename(e.resolvePath(src)) : remotePath;
        e.remote.writeFile(finalPath, r.content);
        print(`${src}  100%  ${r.content.length}B  1.2MB/s  00:00`, 'out');
        print(`已传输到 ${tgt.split('@')[1]}:${finalPath}`, 'ok');
        e.lastOut = finalPath;
      }
    } else if (src.includes('@') && src.includes(':')) {
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
