// 系统管理命令集 —— 用户 / 服务 / 日志 / 磁盘 / 挂载 / 定时任务 / 压缩 / 内存
// 系统类命令由本模块处理，其余委托 linuxExecute（操作同一个 SysEngine）。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'whoami', 'hostname', 'uname', 'date', 'history', 'echo', 'wc', 'head', 'tail', 'env', 'id'];

export function sysExecute(input) {
  input = input.trim();
  if (!input) return;
  const e = E();
  const base = input.split(/\s/)[0];

  if (base === 'help') { printCmd(input); showSysHelp(); return; }
  if (SYS[base]) {
    printCmd(input);
    if (!FREE.includes(base)) { app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount(); }
    track(base); e.used.add(base);
    SYS[base](tokenize(input).slice(1), e);
    return;
  }
  linuxExecute(input);
}

function emit(lines, e, sfxName) { if (sfxName) sfx(sfxName); lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); }
function okMsg(msg, e, sfxName) { sfx(sfxName || 'file-chmod'); print(msg, 'ok'); e.lastOut = msg; after(true); }
function fail(msg, e, sfxName) { sfx(sfxName || 'err-permission'); print(msg, 'err'); e.lastOut = ''; after(false); }

const SYS = {
  /* ---- 用户管理 ---- */
  useradd: (a, e) => {
    const name = a.filter(x => !x.startsWith('-'))[0];
    if (!name) return fail('用法: useradd <用户名>', e);
    if (e.findUser(name)) return fail(`useradd: 用户 "${name}" 已存在`, e);
    const uid = e.nextUid++;
    e.users.push({ name, uid, group: name, shell: '/bin/bash', home: '/home/' + name, passwd: 'x' });
    e.mkdir('/home/' + name);
    // 更新 /etc/passwd
    const pw = e.readFile('/etc/passwd').content;
    e.writeFile('/etc/passwd', pw + `${name}:x:${uid}:${uid}:${name}:/home/${name}:/bin/bash\n`);
    okMsg(`已创建用户 ${name} (uid=${uid})`, e, 'proc-spawn');
  },

  passwd: (a, e) => {
    const name = a[0] || e.env.USER;
    const u = e.findUser(name);
    if (!u) return fail(`passwd: 用户 ${name} 不存在`, e);
    u.passwd = 'set';
    okMsg(`passwd: 已更新 ${name} 的密码`, e, 'file-write');
  },

  id: (a, e) => {
    const name = a[0] || e.env.USER;
    const u = e.findUser(name);
    if (!u) return fail(`id: ${name}: no such user`, e);
    emit([`uid=${u.uid}(${u.name}) gid=${u.uid}(${u.group}) groups=${u.uid}(${u.group})`], e);
  },

  groups: (a, e) => {
    const name = a[0] || e.env.USER;
    const u = e.findUser(name);
    if (!u) return fail(`groups: ${name}: no such user`, e);
    emit([`${name} : ${u.group}`], e);
  },

  sudo: (a, e) => {
    if (!a.length) return fail('用法: sudo <命令>', e);
    print(`[sudo] ${e.env.USER} 的密码：****`, 'dim');
    const rest = a.join(' ');
    const prevUser = e.env.USER;
    e.env.USER = 'root';
    e.sudoUsed = true;
    sfx('file-chmod');
    // 以 root 身份真正执行被包裹的命令
    const sub = a[0];
    if (SYS[sub]) { e.used.add(sub); track(sub); SYS[sub](a.slice(1), e); }
    else linuxExecute(rest);
    e.env.USER = prevUser;
  },

  su: (a, e) => {
    const name = a.filter(x => !x.startsWith('-'))[0] || 'root';
    if (!e.findUser(name)) return fail(`su: 用户 ${name} 不存在`, e);
    e.env.USER = name;
    okMsg(`已切换到用户 ${name}`, e, 'ui-tab');
  },

  /* ---- 服务管理 ---- */
  systemctl: (a, e) => {
    const action = a[0];
    const svcName = a.find(x => !x.startsWith('-') && x !== action);
    if (action === 'list-units' || action === 'list') {
      const lines = ['UNIT'.padEnd(14) + 'LOAD'.padEnd(8) + 'ACTIVE'.padEnd(10) + 'SUB'.padEnd(10) + 'DESCRIPTION'];
      for (const [n, s] of Object.entries(e.services)) {
        lines.push(`${(n + '.service').padEnd(14)}loaded  ${(s.active ? 'active' : 'inactive').padEnd(10)}${(s.active ? 'running' : 'dead').padEnd(10)}${s.desc}`);
      }
      return emit(lines, e);
    }
    if (!svcName) return fail('用法: systemctl <start|stop|restart|status|enable|disable> <服务>', e);
    const key = svcName.replace('.service', '');
    const svc = e.findService(key);
    if (!svc) return fail(`Failed to ${action} ${svcName}: Unit not found.`, e, 'err-syntax');
    switch (action) {
      case 'start': svc.active = true; sfx('docker-start'); print(`● ${key}.service 已启动`, 'ok'); e.lastOut = 'active'; after(true); break;
      case 'stop': svc.active = false; sfx('docker-stop'); print(`● ${key}.service 已停止`, 'ok'); e.lastOut = 'inactive'; after(true); break;
      case 'restart': svc.active = true; sfx('docker-start'); print(`● ${key}.service 已重启`, 'ok'); e.lastOut = 'active'; after(true); break;
      case 'enable': svc.enabled = true; okMsg(`已设置 ${key} 开机自启`, e); break;
      case 'disable': svc.enabled = false; okMsg(`已取消 ${key} 开机自启`, e); break;
      case 'status': {
        const lines = [
          `● ${key}.service - ${svc.desc}`,
          `     Loaded: loaded (/lib/systemd/system/${key}.service; ${svc.enabled ? 'enabled' : 'disabled'})`,
          `     Active: ${svc.active ? 'active (running)' : 'inactive (dead)'}`,
          `   Main PID: ${svc.active ? 1234 : '(none)'}`,
        ];
        emit(lines, e); break;
      }
      default: return fail(`systemctl: 未知操作 ${action}`, e, 'err-syntax');
    }
  },

  service: (a, e) => {
    const [name, action] = a;
    const svc = e.findService(name);
    if (!svc) return fail(`${name}: unrecognized service`, e, 'err-syntax');
    if (action === 'start') svc.active = true;
    else if (action === 'stop') svc.active = false;
    okMsg(`${name} ${action}ed`, e);
  },

  /* ---- 日志 ---- */
  journalctl: (a, e) => {
    let svc = null, errOnly = false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-u') svc = a[++i];
      else if (a[i] === '-p' && (a[i + 1] === 'err' || a[i + 1] === '3')) { errOnly = true; i++; }
      else if (a[i].startsWith('-p') && /err|3/.test(a[i])) errOnly = true;
    }
    let lines = [];
    const sources = svc ? { [svc]: e.journal[svc] || [] } : e.journal;
    if (svc && !e.journal[svc]) return fail(`No entries for unit ${svc}`, e, 'err-syntax');
    for (const [unit, logs] of Object.entries(sources)) lines.push(...logs);
    if (errOnly) lines = lines.filter(l => /ERROR|error|invalid|failed|Aborted/i.test(l));
    lines = lines.slice(-12); // 模拟 --no-pager 截断
    if (!lines.length) return emit(['-- No entries --'], e);
    emit(lines, e, 'text-grep');
  },

  dmesg: (a, e) => {
    emit(['[    0.000000] Linux version 6.1.0-termquest', '[    1.234567] EXT4-fs (sda1): mounted filesystem', '[    2.345678] eth0: link up, 1000Mbps'], e);
  },

  /* ---- 磁盘 ---- */
  df: (a, e) => {
    const lines = ['Filesystem      Size  Used Avail Use% Mounted on'];
    for (const d of e.disks) {
      lines.push(`${d.fs.padEnd(15)} ${d.size.padStart(4)}  ${d.used.padStart(4)}  ${d.avail.padStart(4)}  ${String(d.usePct + '%').padStart(3)} ${d.mount}`);
    }
    emit(lines, e);
  },

  du: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const path = a.find(x => !x.startsWith('-')) || '.';
    const node = e.follow(path);
    if (!node) return fail(`du: 无法访问 '${path}': 没有那个文件或目录`, e, 'err-file');
    const sizeOf = (n) => n.type === 'file' ? Math.ceil((n.content || '').length / 1024) + 1
      : n.type === 'dir' ? Object.values(n.children).reduce((s, c) => s + sizeOf(c), 0) + 4 : 0;
    if (flags.includes('s')) {
      return emit([`${sizeOf(node)}K\t${path}`], e);
    }
    // 列出子项
    const out = [];
    if (node.type === 'dir') {
      for (const [name, child] of Object.entries(node.children)) {
        out.push(`${sizeOf(child)}K\t${path === '.' ? name : path + '/' + name}`);
      }
    }
    out.push(`${sizeOf(node)}K\t${path}`);
    emit(out, e);
  },

  lsblk: (a, e) => {
    const lines = ['NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINT'];
    for (const d of e.blockDevices) {
      lines.push(`${d.name.padEnd(7)}${d.type === 'disk' ? '8:0' : '8:1'}    0  ${d.size.padStart(4)}  0 ${d.type.padEnd(4)} ${d.mount}`);
    }
    emit(lines, e);
  },

  mount: (a, e) => {
    if (!a.length) return emit(e.mounts, e);
    // mount /dev/xxx /mnt
    const [dev, mp] = a.filter(x => !x.startsWith('-'));
    if (!dev || !mp) return fail('用法: mount <设备> <挂载点>', e, 'err-syntax');
    if (!e.isDir(mp)) return fail(`mount: 挂载点 ${mp} 不存在`, e, 'err-file');
    e.mounts.push(`${dev} on ${mp} type ext4 (rw)`);
    okMsg(`${dev} 已挂载到 ${mp}`, e, 'file-move');
  },

  umount: (a, e) => {
    const target = a[0];
    const idx = e.mounts.findIndex(m => m.includes(' on ' + target + ' ') || m.startsWith(target + ' on'));
    if (idx < 0) return fail(`umount: ${target}: not mounted`, e, 'err-syntax');
    e.mounts.splice(idx, 1);
    okMsg(`${target} 已卸载`, e, 'file-move');
  },

  /* ---- 定时任务 ---- */
  crontab: (a, e) => {
    if (a.includes('-l')) {
      if (!e.cron.length) return emit([`no crontab for ${e.env.USER}`], e);
      return emit(e.cron, e);
    }
    if (a.includes('-r')) { e.cron = []; return okMsg('已清空定时任务', e); }
    // crontab 文件 —— 从文件安装
    const file = a.find(x => !x.startsWith('-'));
    if (file) {
      const r = e.readFile(file);
      if (r.err) return fail(r.err, e, 'err-file');
      e.cron = r.content.split('\n').filter(l => l && !l.startsWith('#'));
      return okMsg(`已从 ${file} 安装 ${e.cron.length} 条定时任务`, e, 'file-write');
    }
    return fail('用法: crontab -l | crontab <文件> | crontab -r', e, 'err-syntax');
  },

  /* ---- 压缩 ---- */
  tar: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('').replace(/-/g, '');
    const files = a.filter(x => !x.startsWith('-'));
    if (flags.includes('c')) {
      // 创建：tar -czf name.tar.gz f1 f2
      const fi = a.indexOf('-czf') >= 0 ? a.indexOf('-czf') + 1 : a.indexOf('-cf') + 1;
      const archiveName = a[fi];
      if (!archiveName) return fail('用法: tar -czf <归档名.tar.gz> <文件...>', e, 'err-syntax');
      const targets = a.slice(fi + 1);
      if (!targets.length) return fail('tar: 没有指定要归档的文件', e, 'err-syntax');
      const stored = {};
      for (const t of targets) {
        if (e.isDir(t)) {
          e.walk(t).forEach(rel => { const p = t + '/' + rel; stored[p] = e.readFile(p).content; });
        } else {
          const r = e.readFile(t);
          if (r.err) return fail(`tar: ${t}: 无法读取: 没有那个文件或目录`, e, 'err-file');
          stored[t] = r.content;
        }
      }
      e.archives[archiveName] = { files: stored, gz: flags.includes('z') };
      e.writeFile(archiveName, `[binary ${flags.includes('z') ? 'gzip ' : ''}archive: ${Object.keys(stored).length} files]`);
      sfx('file-create');
      print(`已归档 ${Object.keys(stored).length} 个文件到 ${archiveName}`, 'ok');
      e.lastOut = archiveName; after(true); return;
    }
    if (flags.includes('t')) {
      const archiveName = files[0];
      const arc = e.archives[archiveName];
      if (!arc) return fail(`tar: ${archiveName}: 无法打开: 没有那个文件或目录`, e, 'err-file');
      return emit(Object.keys(arc.files), e);
    }
    if (flags.includes('x')) {
      const archiveName = files[0];
      const arc = e.archives[archiveName];
      if (!arc) return fail(`tar: ${archiveName}: 无法打开: 没有那个文件或目录`, e, 'err-file');
      for (const [p, content] of Object.entries(arc.files)) e.writeFile(p, content);
      sfx('file-copy');
      print(`已解包 ${Object.keys(arc.files).length} 个文件`, 'ok');
      e.lastOut = Object.keys(arc.files).join('\n'); after(true); return;
    }
    return fail('用法: tar -czf 归档.tar.gz 文件... | tar -tf 归档 | tar -xzf 归档', e, 'err-syntax');
  },

  gzip: (a, e) => {
    const f = a.find(x => !x.startsWith('-'));
    if (!f || !e.exists(f)) return fail(`gzip: ${f || ''}: 没有那个文件或目录`, e, 'err-file');
    const content = e.readFile(f).content;
    e.writeFile(f + '.gz', `[gzip: ${f}]`);
    e.remove(f);
    okMsg(`${f} → ${f}.gz`, e, 'file-create');
  },

  gunzip: (a, e) => {
    const f = a.find(x => !x.startsWith('-'));
    if (!f || !f.endsWith('.gz') || !e.exists(f)) return fail(`gunzip: ${f || ''}: 不是 gzip 格式`, e, 'err-file');
    e.writeFile(f.slice(0, -3), '(已解压内容)');
    e.remove(f);
    okMsg(`${f} → ${f.slice(0, -3)}`, e, 'file-create');
  },

  /* ---- 内存 / 负载 ---- */
  free: (a, e) => {
    const m = e.mem;
    const lines = [
      '              total        used        free      shared  buff/cache   available',
      `Mem:        ${String(m.total).padStart(8)}    ${String(m.used).padStart(8)}    ${String(m.free).padStart(8)}     128    ${String(m.cache).padStart(8)}    ${String(m.total - m.used).padStart(8)}`,
      `Swap:       ${String(2048).padStart(8)}           0        2048`,
    ];
    emit(lines, e);
  },

  uptime: (a, e) => {
    emit([' 10:00:00 up 3 days,  4:12,  1 user,  load average: 0.15, 0.10, 0.05'], e);
  },

  vmstat: (a, e) => {
    emit(['procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----',
      ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st',
      ' 1  0      0   2400    512   2200    0    0     5     2  120  240  3  1 96  0  0'], e);
  },

  lsof: (a, e) => {
    const lines = ['COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'];
    for (const c of e.connections || []) {
      const port = c.local.split(':').pop();
      lines.push(`${c.proc.padEnd(9)}${(1000 + parseInt(port) % 999)} ${e.env.USER}    3u  IPv4  12345      0t0  TCP ${c.local} (${c.state})`);
    }
    if (lines.length === 1) lines.push('(无打开的网络文件)');
    emit(lines, e);
  },
};

function showSysHelp() {
  ['── 用户 ──',
    '  useradd <名> · passwd <名> · id [名] · groups [名] · sudo <命令> · su <名>',
    '── 服务 ──',
    '  systemctl start|stop|restart|status|enable|disable <服务> · systemctl list-units',
    '  journalctl [-u 服务] [-p err] · dmesg',
    '── 磁盘 ──',
    '  df [-h] · du [-sh] [路径] · lsblk · mount [设备 挂载点] · umount <挂载点>',
    '── 定时任务 ──',
    '  crontab -l · crontab <文件> · crontab -r',
    '── 压缩 ──',
    '  tar -czf 归档.tar.gz 文件... · tar -tf 归档 · tar -xzf 归档 · gzip 文件',
    '── 性能 ──',
    '  free · uptime · vmstat · lsof',
    '── 其余 ──',
    '  ls · cat · chmod · chown ... 照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
