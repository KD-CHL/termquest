// LinuxEngine —— 目录树文件系统 + 进程表 + 环境变量
// 纯状态机，不依赖 DOM。节点结构：
//   dir:  { type:'dir',  mode, owner, group, children: { name: node } }
//   file: { type:'file', mode, owner, group, content }
//   link: { type:'link', mode, owner, group, target }

export class LinuxEngine {
  constructor() { this.reset(); }

  reset() {
    this.root = mkDir('drwxr-xr-x', 'root', 'root');
    this.cwd = '/home/user';
    this.env = { USER: 'user', HOME: '/home/user', SHELL: '/bin/bash', PATH: '/usr/local/bin:/usr/bin:/bin' };
    this.procs = [];
    this.nextPid = 1;
    this.jobs = [];       // [{ jid, pid, cmd, state: 'Running'|'Stopped' }]
    this.nextJid = 1;
    this.used = new Set();
    this.lastOut = '';    // 上一条命令的标准输出（供关卡 check 使用）
    this.history = [];
    this._seedBase();
    this._seedProcs();
  }

  /* ---- 基础目录骨架 ---- */
  _seedBase() {
    const r = this.root.children;
    r['bin'] = mkDir('drwxr-xr-x', 'root', 'root');
    r['etc'] = mkDir('drwxr-xr-x', 'root', 'root');
    r['tmp'] = mkDir('drwxrwxrwx', 'root', 'root');
    r['var'] = mkDir('drwxr-xr-x', 'root', 'root');
    r['usr'] = mkDir('drwxr-xr-x', 'root', 'root');
    r['home'] = mkDir('drwxr-xr-x', 'root', 'root');
    r['home'].children['user'] = mkDir('drwxr-x---', 'user', 'user');
    r['etc'].children['passwd'] = mkFile('root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:user:/home/user:/bin/bash\n', '-rw-r--r--', 'root', 'root');
    r['etc'].children['hostname'] = mkFile('termquest\n', '-rw-r--r--', 'root', 'root');
  }

  _seedProcs() {
    this.procs = [];
    this.nextPid = 1;
    this.spawn('init', '/sbin/init', 'S');
    this.spawn('bash', '-bash', 'S');
    this.spawn('sshd', '/usr/sbin/sshd', 'S');
  }

  /* ---- 进程管理 ---- */
  spawn(name, cmd, state = 'R') {
    const pid = this.nextPid++;
    this.procs.push({
      pid, name, cmd, state,
      cpu: (Math.random() * 3).toFixed(1),
      mem: (Math.random() * 2 + 0.2).toFixed(1),
    });
    return pid;
  }

  kill(pid) {
    const i = this.procs.findIndex(p => p.pid === pid);
    if (i < 0) return false;
    this.procs.splice(i, 1);
    const j = this.jobs.findIndex(j => j.pid === pid);
    if (j >= 0) this.jobs.splice(j, 1);
    return true;
  }

  findProc(name) { return this.procs.filter(p => p.name.includes(name) || p.cmd.includes(name)); }

  /* ---- 路径解析 ---- */
  resolvePath(p) {
    if (!p) return this.cwd;
    if (p === '~') p = this.env.HOME;
    else if (p.startsWith('~/')) p = this.env.HOME + p.slice(1);
    const abs = p.startsWith('/') ? p : this.cwd + '/' + p;
    const parts = [];
    for (const seg of abs.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return '/' + parts.join('/');
  }

  // 获取节点（不跟随符号链接）
  getNode(path) {
    const resolved = this.resolvePath(path);
    if (resolved === '/') return this.root;
    const segs = resolved.split('/').filter(Boolean);
    let node = this.root;
    for (const s of segs) {
      if (!node || node.type !== 'dir') return null;
      node = node.children[s];
      if (!node) return null;
    }
    return node;
  }

  // 获取节点（跟随符号链接，最多 8 层）
  follow(path, depth = 0) {
    const node = this.getNode(path);
    if (!node) return null;
    if (node.type === 'link') {
      if (depth > 8) return null;
      const t = node.target.startsWith('/') ? node.target
        : this.resolvePath(this.dirname(this.resolvePath(path)) + '/' + node.target);
      return this.follow(t, depth + 1);
    }
    return node;
  }

  dirname(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
  basename(p) { const segs = p.split('/').filter(Boolean); return segs[segs.length - 1] || '/'; }

  // 获取父目录节点 + 文件名
  parentOf(path) {
    const resolved = this.resolvePath(path);
    const dir = this.dirname(resolved);
    const name = this.basename(resolved);
    const pNode = this.getNode(dir);
    return { pNode, name, dir };
  }

  /* ---- 文件操作 ---- */
  mkdir(path, mode = 'drwxr-xr-x', owner = 'user', group = 'user') {
    const { pNode, name } = this.parentOf(path);
    if (!pNode || pNode.type !== 'dir') return { err: `mkdir: 无法创建目录 '${path}': 没有那个文件或目录` };
    if (pNode.children[name]) return { err: `mkdir: 无法创建目录 '${path}': 文件已存在` };
    pNode.children[name] = mkDir(mode, owner, group);
    return { ok: true };
  }

  writeFile(path, content, mode = '-rw-r--r--', owner = 'user', group = 'user') {
    const { pNode, name } = this.parentOf(path);
    if (!pNode || pNode.type !== 'dir') return { err: `无法写入 '${path}': 没有那个文件或目录` };
    const existing = pNode.children[name];
    if (existing && existing.type === 'dir') return { err: `${path}: 是一个目录` };
    pNode.children[name] = existing && existing.type === 'file'
      ? { ...existing, content }
      : mkFile(content, mode, owner, group);
    return { ok: true };
  }

  readFile(path) {
    const node = this.follow(path);
    if (!node) return { err: `cat: ${path}: 没有那个文件或目录` };
    if (node.type === 'dir') return { err: `cat: ${path}: 是一个目录` };
    return { ok: true, content: node.content };
  }

  remove(path, recursive = false) {
    const { pNode, name } = this.parentOf(path);
    if (!pNode || !pNode.children[name]) return { err: `rm: 无法删除 '${path}': 没有那个文件或目录` };
    const node = pNode.children[name];
    if (node.type === 'dir' && !recursive) return { err: `rm: 无法删除 '${path}': 是一个目录` };
    delete pNode.children[name];
    return { ok: true };
  }

  exists(path) { return this.follow(path) !== null; }
  isDir(path) { const n = this.follow(path); return n && n.type === 'dir'; }

  /* ---- 目录遍历 ---- */
  listDir(path) {
    const node = this.follow(path);
    if (!node) return null;
    if (node.type !== 'dir') return [this.basename(this.resolvePath(path))];
    return Object.keys(node.children).sort();
  }

  // 递归收集所有文件路径（相对于 path）
  walk(path, prefix = '') {
    const node = this.follow(path);
    if (!node) return [];
    if (node.type === 'file') return [prefix || '.'];
    if (node.type !== 'dir') return [];
    const out = [];
    for (const [name, child] of Object.entries(node.children)) {
      const rel = prefix ? prefix + '/' + name : name;
      if (child.type === 'dir') out.push(...this.walk(this.resolvePath(path) + '/' + name, rel));
      else out.push(rel);
    }
    return out;
  }

  /* ---- 权限 ---- */
  chmod(path, modeStr) {
    const node = this.getNode(this.resolvePath(path));
    if (!node) return { err: `chmod: 无法访问 '${path}': 没有那个文件或目录` };
    node.mode = applyMode(node.mode, modeStr);
    return { ok: true };
  }

  // 递归改权限（chmod -R）：目录则连同所有后代一起改
  chmodR(path, modeStr) {
    const node = this.getNode(this.resolvePath(path));
    if (!node) return { err: `chmod: 无法访问 '${path}': 没有那个文件或目录` };
    const rec = n => {
      n.mode = applyMode(n.mode, modeStr);
      if (n.type === 'dir') for (const c of Object.values(n.children)) rec(c);
    };
    rec(node);
    return { ok: true };
  }

  chown(path, owner, group) {
    const node = this.getNode(this.resolvePath(path));
    if (!node) return { err: `chown: 无法访问 '${path}': 没有那个文件或目录` };
    if (owner) node.owner = owner;
    if (group) node.group = group;
    return { ok: true };
  }

  /* ---- 复制 / 移动 ---- */
  copy(src, dst) {
    const sNode = this.follow(src);
    if (!sNode) return { err: `cp: 无法 stat '${src}': 没有那个文件或目录` };
    if (sNode.type === 'dir') return { err: `cp: -r 未指定；略过目录 '${src}'` };
    let { pNode, name } = this.parentOf(dst);
    if (!pNode) return { err: `cp: 无法创建常规文件 '${dst}': 没有那个文件或目录` };
    // 目标是目录 → 拷入其中
    const dNode = this.follow(dst);
    if (dNode && dNode.type === 'dir') {
      const dirNode = this.getNode(this.resolvePath(dst));
      dirNode.children[this.basename(this.resolvePath(src))] = { ...sNode };
      return { ok: true };
    }
    pNode.children[name] = { ...sNode };
    return { ok: true };
  }

  // 递归复制（cp -r）：源可以是文件或目录，目标是目录则拷入其中
  copyTree(src, dst) {
    const sNode = this.follow(src);
    if (!sNode) return { err: `cp: 无法 stat '${src}': 没有那个文件或目录` };
    const clone = n => {
      if (n.type === 'dir') {
        const d = mkDir(n.mode, n.owner, n.group);
        for (const [k, v] of Object.entries(n.children)) d.children[k] = clone(v);
        return d;
      }
      if (n.type === 'link') return { type: 'link', mode: n.mode, owner: n.owner, group: n.group, target: n.target };
      return { ...n };
    };
    const dNode = this.follow(dst);
    if (dNode && dNode.type === 'dir') {
      const dirNode = this.getNode(this.resolvePath(dst));
      dirNode.children[this.basename(this.resolvePath(src))] = clone(sNode);
      return { ok: true };
    }
    const { pNode, name } = this.parentOf(dst);
    if (!pNode || pNode.type !== 'dir') return { err: `cp: 无法创建 '${dst}': 没有那个文件或目录` };
    pNode.children[name] = clone(sNode);
    return { ok: true };
  }

  move(src, dst) {
    const sResolved = this.resolvePath(src);
    const { pNode: sParent, name: sName } = this.parentOf(src);
    if (!sParent || !sParent.children[sName]) return { err: `mv: 无法 stat '${src}': 没有那个文件或目录` };
    const node = sParent.children[sName];
    const dNode = this.follow(dst);
    if (dNode && dNode.type === 'dir') {
      const dirNode = this.getNode(this.resolvePath(dst));
      dirNode.children[sName] = node;
    } else {
      const { pNode: dParent, name: dName } = this.parentOf(dst);
      if (!dParent) return { err: `mv: 无法移动 '${src}' 到 '${dst}': 没有那个文件或目录` };
      dParent.children[dName] = node;
    }
    delete sParent.children[sName];
    return { ok: true };
  }

  /* ---- 符号链接 ---- */
  symlink(target, linkPath) {
    const { pNode, name } = this.parentOf(linkPath);
    if (!pNode || pNode.type !== 'dir') return { err: `ln: 无法创建符号链接 '${linkPath}': 没有那个文件或目录` };
    pNode.children[name] = { type: 'link', mode: 'lrwxrwxrwx', owner: 'user', group: 'user', target };
    return { ok: true };
  }

  /* ---- 树形结构（渲染用） ---- */
  treeLines(path = this.cwd, maxDepth = 4) {
    const lines = [];
    const node = this.follow(path);
    if (!node || node.type !== 'dir') return [this.basename(path)];
    const walkDir = (n, prefix, depth) => {
      if (depth > maxDepth) return;
      const entries = Object.entries(n.children).sort(([a], [b]) => a.localeCompare(b));
      entries.forEach(([name, child], i) => {
        const last = i === entries.length - 1;
        const conn = last ? '└── ' : '├── ';
        const suffix = child.type === 'dir' ? '/' : child.type === 'link' ? ' -> ' + child.target : '';
        lines.push(prefix + conn + name + suffix);
        if (child.type === 'dir') walkDir(child, prefix + (last ? '    ' : '│   '), depth + 1);
      });
    };
    walkDir(node, '', 0);
    return lines;
  }
}

/* ============ 辅助函数 ============ */
function mkDir(mode, owner, group) { return { type: 'dir', mode, owner, group, children: {} }; }
function mkFile(content, mode, owner, group) { return { type: 'file', mode, owner, group, content }; }

// 简化 chmod：支持 755 / u+x / a-w 等常见形式
function applyMode(oldMode, spec) {
  const type = oldMode[0];
  let perms = oldMode.slice(1);
  if (/^\d{3,4}$/.test(spec)) {
    const digits = spec.slice(-3);
    perms = digits.split('').map(d => {
      const n = parseInt(d);
      return (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-');
    }).join('');
    return type + perms;
  }
  // u+x, g-w, a=r 等
  for (const part of spec.split(',')) {
    const m = part.match(/^([ugoa]*)([+\-=])([rwx]*)$/);
    if (!m) continue;
    const who = m[1] || 'a', op = m[2], bits = m[3];
    const idx = { u: 0, g: 1, o: 2 };
    const targets = who === 'a' || !who ? [0, 1, 2] : [...who].map(c => idx[c]).filter(i => i !== undefined);
    for (const t of targets) {
      let tri = perms.slice(t * 3, t * 3 + 3);
      for (const b of bits) {
        const pos = { r: 0, w: 1, x: 2 }[b];
        if (op === '+') tri = tri.slice(0, pos) + b + tri.slice(pos + 1);
        else if (op === '-') tri = tri.slice(0, pos) + '-' + tri.slice(pos + 1);
        else tri = '---'; // = 不带位则清除
      }
      perms = perms.slice(0, t * 3) + tri + perms.slice(t * 3 + 3);
    }
  }
  return type + perms;
}
