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

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'whoami', 'hostname', 'uname', 'date', 'history', 'echo', 'wc', 'head', 'tail', 'env', 'id', 'fdisk'];

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
// KB 数值 → 人类可读（K/M/G）
function humanKB(kb) {
  if (kb >= 1048576) return (kb / 1048576).toFixed(1).replace(/\.0$/, '') + 'G';
  if (kb >= 1024) return (kb / 1024).toFixed(1).replace(/\.0$/, '') + 'M';
  return kb + 'K';
}
// MB 数值 → 人类可读（Mi/Gi）
function humanMB(mb) {
  if (mb === 0) return '0B';
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace(/\.0$/, '') + 'Gi';
  return mb + 'Mi';
}
// 解压 .gz：优先还原 gzip 时存档的真实内容（gunzip 与 gzip -d 共用）
function decompressGz(f, e) {
  if (!f || !f.endsWith('.gz') || !e.exists(f)) return fail(`gunzip: ${f || ''}: 不是 gzip 格式`, e, 'err-file');
  const target = f.slice(0, -3);
  const arc = e.archives[f];
  const entry = arc && Object.entries(arc.files)[0];
  e.writeFile(entry ? entry[0] : target, entry ? entry[1] : '(已解压内容)');
  e.remove(f);
  delete e.archives[f];
  okMsg(`${f} → ${entry ? entry[0] : target}`, e, 'file-create');
}
// 递归创建缺失的父目录（mkdir -p 语义，tar 解包 / useradd 建主目录共用）
function ensureDir(e, p) {
  let cur = '';
  for (const s of e.resolvePath(p).split('/').filter(Boolean)) {
    cur += '/' + s;
    if (!e.exists(cur)) e.mkdir(cur);
  }
}

const SYS = {
  /* ---- 用户管理 ---- */
  useradd: (a, e) => {
    let shell = '/bin/bash', home = null, group = null, uid = null;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-s') shell = a[++i];
      else if (t === '-d') home = a[++i];
      else if (t === '-u') uid = parseInt(a[++i], 10);
      else if (t === '-G') group = a[++i];
      else if (t === '-m') { /* 创建主目录（默认行为） */ }
      else if (!t.startsWith('-')) pos.push(t);
    }
    const name = pos[0];
    if (!name) return fail('用法: useradd [-m] [-s SHELL] [-G 组] [-d 主目录] [-u UID] <用户名>', e);
    if (e.findUser(name)) return fail(`useradd: 用户 "${name}" 已存在`, e);
    if (uid == null || isNaN(uid)) uid = e.nextUid++;
    else if (e.users.some(u => u.uid === uid)) return fail(`useradd: UID ${uid} 已被占用`, e);
    else e.nextUid = Math.max(e.nextUid, uid + 1);
    home = home || '/home/' + name;
    group = group || name;
    e.users.push({ name, uid, group, shell, home, passwd: 'x' });
    ensureDir(e, home);
    // 更新 /etc/passwd
    const pw = e.readFile('/etc/passwd').content;
    e.writeFile('/etc/passwd', pw + `${name}:x:${uid}:${uid}:${name}:${home}:${shell}\n`);
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
    const flags = a.filter(x => x.startsWith('-')).join('');
    const name = a.find(x => !x.startsWith('-')) || e.env.USER;
    const u = e.findUser(name);
    if (!u) return fail(`id: ${name}: no such user`, e);
    if (flags.includes('u')) return emit([flags.includes('n') ? u.name : String(u.uid)], e);
    if (flags.includes('g')) return emit([flags.includes('n') ? u.group : String(u.uid)], e);
    if (flags.includes('n')) return emit([u.name], e);
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
    if (action === 'daemon-reload' || action === 'daemon-reexec') {
      sfx('file-chmod'); e.lastOut = ''; after(true); return;
    }
    if (!svcName) return fail('用法: systemctl <start|stop|restart|status|enable|disable|is-active|is-enabled|show> <服务>', e);
    const key = svcName.replace('.service', '');
    const svc = e.findService(key);
    if (!svc) return fail(`Failed to ${action} ${svcName}: Unit not found.`, e, 'err-syntax');
    const now = a.includes('--now');
    switch (action) {
      case 'start': svc.active = true; sfx('docker-start'); print(`● ${key}.service 已启动`, 'ok'); e.lastOut = 'active'; after(true); break;
      case 'stop': svc.active = false; sfx('docker-stop'); print(`● ${key}.service 已停止`, 'ok'); e.lastOut = 'inactive'; after(true); break;
      case 'restart': svc.active = true; sfx('docker-start'); print(`● ${key}.service 已重启`, 'ok'); e.lastOut = 'active'; after(true); break;
      case 'enable': svc.enabled = true; if (now) svc.active = true; okMsg(`已设置 ${key} 开机自启${now ? '（并立即启动）' : ''}`, e); break;
      case 'disable': svc.enabled = false; if (now) svc.active = false; okMsg(`已取消 ${key} 开机自启${now ? '（并立即停止）' : ''}`, e); break;
      case 'is-active': emit([svc.active ? 'active' : 'inactive'], e); break;
      case 'is-enabled': emit([svc.enabled ? 'enabled' : 'disabled'], e); break;
      case 'show': emit([
        `Id=${key}.service`,
        `Names=${key}.service`,
        `Description=${svc.desc}`,
        'LoadState=loaded',
        `ActiveState=${svc.active ? 'active' : 'inactive'}`,
        `SubState=${svc.active ? 'running' : 'dead'}`,
        `UnitFileState=${svc.enabled ? 'enabled' : 'disabled'}`,
        `MainPID=${svc.active ? 1234 : 0}`,
      ], e); break;
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
    let svc = null, errOnly = false, lastN = 12; // 默认模拟 --no-pager 截断 12 行
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-u') svc = a[++i];
      else if (a[i] === '-n') lastN = parseInt(a[++i], 10) || 12;
      else if (/^-n\d+$/.test(a[i])) lastN = parseInt(a[i].slice(2), 10);
      else if (a[i] === '-p' && (a[i + 1] === 'err' || a[i + 1] === '3')) { errOnly = true; i++; }
      else if (a[i].startsWith('-p') && /err|3/.test(a[i])) errOnly = true;
      // --no-pager 等其余 flag 直接忽略
    }
    let lines = [];
    const sources = svc ? { [svc]: e.journal[svc] || [] } : e.journal;
    if (svc && !e.journal[svc]) return fail(`No entries for unit ${svc}`, e, 'err-syntax');
    for (const [unit, logs] of Object.entries(sources)) lines.push(...logs);
    if (errOnly) lines = lines.filter(l => /ERROR|error|invalid|failed|Aborted/i.test(l));
    lines = lines.slice(-lastN);
    if (!lines.length) return emit(['-- No entries --'], e);
    emit(lines, e, 'text-grep');
  },

  dmesg: (a, e) => {
    emit(['[    0.000000] Linux version 6.1.0-termquest', '[    1.234567] EXT4-fs (sda1): mounted filesystem', '[    2.345678] eth0: link up, 1000Mbps'], e);
  },

  /* ---- 磁盘 ---- */
  df: (a, e) => {
    // 支持 -h（人类可读）：引擎中容量本身即 '50G' 形式，加不加 -h 列内容一致，默认输出保持不变。
    const lines = ['Filesystem      Size  Used Avail Use% Mounted on'];
    for (const d of e.disks) {
      lines.push(`${d.fs.padEnd(15)} ${d.size.padStart(4)}  ${d.used.padStart(4)}  ${d.avail.padStart(4)}  ${String(d.usePct + '%').padStart(3)} ${d.mount}`);
    }
    emit(lines, e);
  },

  du: (a, e) => {
    let human = false, all = false, summary = false, depth = null;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-d') depth = parseInt(a[++i], 10);
      else if (/^-d\d+$/.test(t)) depth = parseInt(t.slice(2), 10);
      else if (t.startsWith('-')) {
        if (t.includes('h')) human = true;
        if (t.includes('a')) all = true;
        if (t.includes('s')) summary = true;
      } else pos.push(t);
    }
    const path = pos[0] || '.';
    const node = e.follow(path);
    if (!node) return fail(`du: 无法访问 '${path}': 没有那个文件或目录`, e, 'err-file');
    const sizeOf = (n) => n.type === 'file' ? Math.ceil((n.content || '').length / 1024) + 1
      : n.type === 'dir' ? Object.values(n.children).reduce((s, c) => s + sizeOf(c), 0) + 4 : 0;
    const fmt = (kb) => human ? humanKB(kb) : kb + 'K';
    if (summary) {
      return emit([`${fmt(sizeOf(node))}\t${path}`], e);
    }
    // 列出子项：默认只列直接子项（保持原输出）；-d N 限制深度；-a 递归列出所有文件
    const depthLimit = depth != null ? depth : (all ? Infinity : 1);
    const out = [];
    if (node.type === 'dir') {
      const walkD = (n, p, level) => {
        for (const [name, child] of Object.entries(n.children)) {
          const cp = p === '.' ? name : p + '/' + name;
          if (child.type === 'dir') {
            if (level < depthLimit) walkD(child, cp, level + 1);
            out.push(`${fmt(sizeOf(child))}\t${cp}`);
          } else if (all || level === 1) {
            out.push(`${fmt(sizeOf(child))}\t${cp}`);
          }
        }
      };
      walkD(node, path, 1);
    }
    out.push(`${fmt(sizeOf(node))}\t${path}`);
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
    // 健壮解析：支持 -czf/-xzf/-cf/-xf 合并写法与独立的 -f <归档名>，外加 -v/-z/-C <目录>
    let archiveName = null, chdir = null, verbose = false;
    const flagChars = [];
    const rest = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-f' || t === '--file') archiveName = a[++i];
      else if (t === '-C' || t === '--directory') chdir = a[++i];
      else if (t.startsWith('--')) continue; // 其余长 flag 忽略
      else if (t.startsWith('-') && t.length > 1) flagChars.push(...t.replace(/-/g, ''));
      else rest.push(t);
    }
    const flags = flagChars.join('');
    if (flags.includes('v')) verbose = true;
    if (archiveName === null && flags.includes('f') && rest.length) archiveName = rest.shift();
    if (flags.includes('c')) {
      // 创建：tar -czf name.tar.gz f1 f2
      if (!archiveName) return fail('用法: tar -czf <归档名.tar.gz> <文件...>', e, 'err-syntax');
      if (!rest.length) return fail('tar: 没有指定要归档的文件', e, 'err-syntax');
      const stored = {};
      for (const t of rest) {
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
      if (verbose) Object.keys(stored).forEach(p => print(p, 'out'));
      print(`已归档 ${Object.keys(stored).length} 个文件到 ${archiveName}`, 'ok');
      e.lastOut = archiveName; after(true); return;
    }
    if (flags.includes('t')) {
      if (!archiveName || !e.archives[archiveName]) return fail(`tar: ${archiveName || ''}: 无法打开: 没有那个文件或目录`, e, 'err-file');
      return emit(Object.keys(e.archives[archiveName].files), e);
    }
    if (flags.includes('x')) {
      if (!archiveName || !e.archives[archiveName]) return fail(`tar: ${archiveName || ''}: 无法打开: 没有那个文件或目录`, e, 'err-file');
      if (chdir && !e.isDir(chdir)) return fail(`tar: ${chdir}: 无法 chdir: 没有那个文件或目录`, e, 'err-file');
      const arc = e.archives[archiveName];
      for (const [p, content] of Object.entries(arc.files)) {
        const target = chdir ? chdir.replace(/\/$/, '') + '/' + p : p;
        ensureDir(e, e.dirname(target));
        e.writeFile(target, content);
        if (verbose) print(target, 'out');
      }
      sfx('file-copy');
      print(`已解包 ${Object.keys(arc.files).length} 个文件`, 'ok');
      e.lastOut = Object.keys(arc.files).map(p => chdir ? chdir.replace(/\/$/, '') + '/' + p : p).join('\n'); after(true); return;
    }
    return fail('用法: tar -czf 归档.tar.gz 文件... | tar -tf 归档 | tar -xzf 归档 [-C 目录] [-v]', e, 'err-syntax');
  },

  gzip: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const f = a.find(x => !x.startsWith('-'));
    if (flags.includes('d')) return decompressGz(f, e); // gzip -d 等价于 gunzip
    if (!f || !e.exists(f)) return fail(`gzip: ${f || ''}: 没有那个文件或目录`, e, 'err-file');
    const content = e.readFile(f).content;
    // 把真实内容存进归档表，解压时可还原
    e.archives[f + '.gz'] = { files: { [f]: content }, gz: true };
    e.writeFile(f + '.gz', `[gzip: ${f}]`);
    if (!flags.includes('k')) e.remove(f);
    okMsg(`${f} → ${f}.gz${flags.includes('k') ? '（保留原文件）' : ''}`, e, 'file-create');
  },

  gunzip: (a, e) => {
    const f = a.find(x => !x.startsWith('-'));
    decompressGz(f, e);
  },

  /* ---- 内存 / 负载 ---- */
  free: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const m = e.mem;
    if (flags.includes('h') || flags.includes('m')) {
      // -h 人类可读（Mi/Gi）；-m 以 MB 为单位（引擎内存值本身即 MB）
      const f = flags.includes('h')
        ? (v) => humanMB(v).padStart(8)
        : (v) => String(v).padStart(8);
      return emit([
        '              total        used        free      shared  buff/cache   available',
        `Mem:        ${f(m.total)}    ${f(m.used)}    ${f(m.free)}     ${f(128)}    ${f(m.cache)}    ${f(m.total - m.used)}`,
        `Swap:       ${f(2048)}    ${f(0)}    ${f(2048)}`,
      ], e);
    }
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
    // -i 只看网络（本命令默认即网络连接）；-p PID 按进程过滤
    let pidFilter = null;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-p') pidFilter = a[++i];
      else if (/^-p\d+$/.test(a[i])) pidFilter = a[i].slice(2);
    }
    const lines = ['COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'];
    for (const c of e.connections || []) {
      const port = c.local.split(':').pop();
      const pid = 1000 + parseInt(port) % 999;
      if (pidFilter !== null && String(pid) !== String(pidFilter)) continue;
      lines.push(`${c.proc.padEnd(9)}${pid} ${e.env.USER}    3u  IPv4  12345      0t0  TCP ${c.local} (${c.state})`);
    }
    if (lines.length === 1) lines.push(pidFilter !== null ? `(无 PID ${pidFilter} 打开的文件)` : '(无打开的网络文件)');
    emit(lines, e);
  },

  /* ---- 磁盘底层工具 ---- */
  dd: (a, e) => {
    let inf = null, outf = null, bs = 512, count = 1;
    for (const t of a) {
      if (t.startsWith('if=')) inf = t.slice(3);
      else if (t.startsWith('of=')) outf = t.slice(3);
      else if (t.startsWith('bs=')) {
        const m = t.slice(3).match(/^(\d+)([kKmM]?)$/);
        if (m) bs = parseInt(m[1], 10) * (m[2].toLowerCase() === 'k' ? 1024 : m[2].toLowerCase() === 'm' ? 1048576 : 1);
      } else if (t.startsWith('count=')) count = parseInt(t.slice(6), 10) || 1;
    }
    if (!outf) return fail('用法: dd if=<输入文件> of=<输出文件> [bs=N] [count=N]', e, 'err-syntax');
    let total = bs * count;
    if (total > 16777216) total = 16777216; // 防止过大文件拖慢终端
    let data;
    if (inf === '/dev/zero') data = '\u0000'.repeat(total);
    else if (inf === '/dev/urandom') data = 'a1b2c3d4e5f6'.repeat(Math.ceil(total / 12)).slice(0, total);
    else if (inf) {
      const r = e.readFile(inf);
      if (r.err) return fail(`dd: 无法打开 '${inf}': 没有那个文件或目录`, e, 'err-file');
      const src = r.content || '\u0000';
      data = src.length >= total ? src.slice(0, total) : src.repeat(Math.ceil(total / src.length)).slice(0, total);
    } else {
      data = '\u0000'.repeat(total);
    }
    const w = e.writeFile(outf, data);
    if (w.err) return fail(w.err, e, 'err-file');
    sfx('file-write');
    const secs = Math.max(0.0001, total / 52428800);
    const summary = [
      `${count}+0 records in`,
      `${count}+0 records out`,
      `${total} bytes copied, ${secs.toFixed(4)} s, ${(total / secs / 1048576).toFixed(1)} MB/s`,
    ];
    summary.forEach(l => print(l, 'out'));
    e.lastOut = summary.join('\n'); after(true);
  },

  mkfs: (a, e) => {
    // mkfs -t ext4 /dev/sdX 或 mkfs.ext4 /dev/sdX
    let type = 'ext4';
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-t') type = a[++i] || 'ext4';
      else if (!a[i].startsWith('-')) pos.push(a[i]);
    }
    const devPath = pos[0];
    if (!devPath) return fail('用法: mkfs -t <ext4|xfs|vfat> /dev/sdX', e, 'err-syntax');
    const devName = devPath.replace(/^\/dev\//, '');
    const dev = e.blockDevices.find(d => d.name === devName);
    if (!dev) return fail(`mkfs: 无法在 '${devPath}' 上创建文件系统: 没有那个文件或目录`, e, 'err-file');
    dev.fsType = type;
    const gb = parseFloat(dev.size) || 1;
    const blocks = Math.round(gb * 262144); // 4k 块数
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
    emit([
      `mke2fs 1.46.5 (30-Dec-2021)`,
      `Creating filesystem with ${blocks} 4k blocks and ${Math.round(blocks / 4)} inodes`,
      `Filesystem UUID: ${uuid}`,
      'Superblock backups stored on blocks: 32768, 98304, 163840, 229376',
      'Allocating group tables: done',
      'Writing inode tables: done',
      `Creating journal (${Math.min(65536, blocks)} blocks): done`,
      'Writing superblocks and filesystem accounting information: done',
    ], e, 'file-create');
  },

  'mkfs.ext4': (a, e) => SYS.mkfs(a, e),

  fdisk: (a, e) => {
    if (!a.includes('-l')) return fail('用法: fdisk -l 查看分区表', e, 'err-syntax');
    const lines = [];
    for (const d of e.blockDevices.filter(x => x.type === 'disk')) {
      const gb = parseFloat(d.size) || 0;
      const bytes = Math.round(gb * 1073741824);
      const sectors = bytes / 512;
      lines.push(`Disk /dev/${d.name}: ${gb} GiB, ${bytes} bytes, ${sectors} sectors`);
      lines.push('Units: sectors of 1 * 512 = 512 bytes');
      lines.push('Sector size (logical/physical): 512 bytes / 512 bytes');
      lines.push('Disklabel type: dos');
      lines.push('');
      const parts = e.blockDevices.filter(x => x.type === 'part' && x.name.startsWith(d.name));
      if (parts.length) {
        lines.push('Device      Boot Start       End   Sectors  Size Id Type');
        let start = 2048;
        for (const p of parts) {
          const pGb = parseFloat(p.size) || 0;
          const pSectors = Math.round(pGb * 1073741824 / 512);
          const end = start + pSectors - 1;
          lines.push(`/dev/${p.name.padEnd(8)}      ${String(start).padStart(6)}  ${String(end).padStart(8)}  ${String(pSectors).padStart(8)} ${String(pGb + 'G').padStart(4)} 83 Linux`);
          start = end + 1;
        }
      } else {
        lines.push('(无分区表)');
      }
      lines.push('');
    }
    emit(lines, e);
  },
};

function showSysHelp() {
  ['── 用户 ──',
    '  useradd [-m] [-s SHELL] [-G 组] [-d 主目录] [-u UID] <名> · passwd <名>',
    '  id [-u|-g|-n] [名] · groups [名] · sudo <命令> · su <名>',
    '── 服务 ──',
    '  systemctl start|stop|restart|status|enable|disable <服务> [--now]',
    '  systemctl is-active|is-enabled|show <服务> · systemctl daemon-reload · systemctl list-units',
    '  journalctl [-u 服务] [-p err] [-n 行数] [--no-pager] · dmesg',
    '── 磁盘 ──',
    '  df [-h] · du [-s|-h|-a] [-d 深度] [路径] · lsblk · fdisk -l',
    '  mount [设备 挂载点] · umount <挂载点> · mkfs -t ext4 /dev/sdX · mkfs.ext4 /dev/sdX',
    '  dd if=<输入|/dev/zero> of=<文件> [bs=N] [count=N]',
    '── 定时任务 ──',
    '  crontab -l · crontab <文件> · crontab -r',
    '── 压缩 ──',
    '  tar -czf 归档.tar.gz 文件... · tar -tf 归档 · tar -xzf 归档 [-C 目录] [-v]',
    '  gzip [-k] 文件 · gzip -d 文件.gz · gunzip 文件.gz',
    '── 性能 ──',
    '  free [-h|-m] · uptime · vmstat · lsof [-i] [-p PID]',
    '── 其余 ──',
    '  ls · cat · chmod · chown ... 照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
