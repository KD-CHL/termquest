// DockerEngine —— 继承 LinuxEngine（本地文件系统），叠加容器/镜像/网络/卷
// 远程主机 = 第二个 LinuxEngine 实例（SSH 练习用）
import { LinuxEngine } from './linux-engine.js';

export class DockerEngine extends LinuxEngine {
  reset() {
    super.reset();
    this.images = [];       // { id, repo, tag, layers: [str], size, base }
    this.containers = [];   // { id, name, image, status: 'running'|'exited', cmd, ports: [str], logs: [str],
                            //   env: {K:V}, mounts: [{source,target}], workdir, network, autoRemove, files: {path:content} }
    this.networks = [
      { id: this._hex(1), name: 'bridge', driver: 'bridge' },
      { id: this._hex(2), name: 'host', driver: 'host' },
      { id: this._hex(3), name: 'none', driver: 'null' },
    ];
    this.volumes = [];      // { id, name, mountpoint }
    this._idSeq = 0x10;
    this._tick = 0;       // 确定性时间戳计数器（容器 createdAt 用）
    this.sshHost = null;    // 当前 SSH 会话 'user@host'，null 表示未连接
    this.remote = new LinuxEngine();
    this._seedRemote();
  }

  /* ---- 伪随机 hex ID（确定性，便于测试） ---- */
  _hex(n) {
    return (((n * 2654435761) >>> 0) % 0xFFFFFF).toString(16).padStart(6, '0');
  }
  nextId() { return this._hex(++this._idSeq); }

  /* ---- 远程主机初始化 ---- */
  _seedRemote() {
    const r = this.remote;
    r.writeFile('/etc/hostname', 'prod-server\n');
    r.env.HOSTNAME = 'prod-server';
    r.mkdir('/var/log');
    r.writeFile('/var/log/app.log', 'INFO boot ok\nERROR db connection lost\nINFO retry\nERROR timeout\n');
    r.writeFile('/home/user/welcome.txt', 'Welcome to prod-server\n');
    r.mkdir('/home/user/deploy');
  }

  /* ---- 镜像 / 容器辅助 ---- */
  findImage(spec) {
    const [repo, tag = 'latest'] = spec.includes(':') ? spec.split(':') : [spec, 'latest'];
    return this.images.find(i => i.repo === repo && i.tag === tag);
  }

  addImage(repo, tag, layers, base) {
    const existing = this.findImage(`${repo}:${tag}`);
    if (existing) { existing.layers = layers; existing.base = base; return existing; }
    const img = { id: this.nextId(), repo, tag, layers, base, size: layers.length * 42 + 13 };
    this.images.push(img);
    return img;
  }

  findContainer(key) {
    return this.containers.find(c => c.id === key || c.id.startsWith(key) || c.name === key);
  }

  createContainer(image, name, opts = {}) {
    const c = {
      id: this.nextId(),
      name: name || `quirky_${['fox', 'owl', 'cat', 'bee', 'ant', 'yak'][this.containers.length % 6]}`,
      image: `${image.repo}:${image.tag}`,
      status: 'running',
      cmd: opts.cmd || (image.layers.length ? (image.layers[image.layers.length - 1].replace(/^CMD /, '') || '/bin/sh') : '/bin/sh'),
      ports: opts.ports || [],
      env: opts.env || {},            // docker run -e KEY=VAL
      mounts: opts.mounts || [],      // docker run -v 源:目标 → [{source, target}]
      workdir: opts.workdir || '/',   // docker run -w
      network: opts.network || 'bridge', // 所属网络（network rm 占用判定用）
      autoRemove: !!opts.autoRemove,  // docker run --rm
      files: {},                      // docker cp 用的容器内文件 {path: content}
      logs: [`Starting ${image.repo}...`, `${image.repo} ready on port 80`, 'INFO listening'],
      restart: opts.restart || 'no',  // docker run --restart
      labels: opts.labels || {},      // docker run -l key=value
      entrypoint: opts.entrypoint || null, // docker run --entrypoint
      memory: opts.memory || null,    // docker run --memory (e.g. '512m')
      cpus: opts.cpus || null,        // docker run --cpus (e.g. '1.5')
      paused: false,                  // docker pause/unpause
      createdAt: ++this._tick,        // 确定性创建时间戳
      stdinOpen: !!opts.stdinOpen,    // -i
      tty: !!opts.tty,               // -t
    };
    this.containers.push(c);
    return c;
  }

  /* ---- 预置镜像（关卡 setup 用） ---- */
  seedImage(spec, layers) {
    const [repo, tag = 'latest'] = spec.includes(':') ? spec.split(':') : [spec, 'latest'];
    return this.addImage(repo, tag, layers || [`FROM scratch`, `LABEL ${repo}`], null);
  }

  seedContainer(spec, name, opts = {}) {
    const img = this.findImage(spec) || this.seedImage(spec);
    const c = this.createContainer(img, name, opts);
    if (opts.status) c.status = opts.status;
    if (opts.logs) c.logs = opts.logs;
    return c;
  }
}
