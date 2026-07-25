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

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'whoami', 'hostname', 'uname', 'date', 'history', 'echo', 'wc', 'head', 'tail', 'env', 'id', 'fdisk', 'w', 'who'];

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
// 依据引擎用户表重建 /etc/passwd（usermod / userdel 改动后同步）
function rebuildPasswd(e) {
  const lines = e.users.map(u => `${u.name}:x:${u.uid}:${u.uid}:${u.name}:${u.home}:${u.shell}`);
  e.writeFile('/etc/passwd', lines.join('\n') + '\n');
}
// 通用单文件压缩（gzip / bzip2 / xz 共用）：把真实内容存进归档表，解压时可还原
function compressOne(f, ext, label, e, keep) {
  if (!f || !e.exists(f) || e.isDir(f)) return fail(`${label}: ${f || ''}: 没有那个文件或目录`, e, 'err-file');
  const content = e.readFile(f).content;
  e.archives[f + ext] = { files: { [f]: content }, gz: true };
  e.writeFile(f + ext, `[${label}: ${f}]`);
  if (!keep) e.remove(f);
  okMsg(`${f} → ${f + ext}${keep ? '（保留原文件）' : ''}`, e, 'file-create');
}
// 通用单文件解压（gunzip / bunzip2 / unxz / zcat 共用）
function decompressOne(f, ext, label, e, keep) {
  if (!f || !f.endsWith(ext) || !e.exists(f)) return fail(`${label}: ${f || ''}: 不是 ${label} 格式`, e, 'err-file');
  const target = f.slice(0, -ext.length);
  const arc = e.archives[f];
  const entry = arc && Object.entries(arc.files)[0];
  const name = entry ? entry[0] : target;
  const data = entry ? entry[1] : '(已解压内容)';
  e.writeFile(name, data);
  if (!keep) { e.remove(f); delete e.archives[f]; }
  okMsg(`${f} → ${name}${keep ? '（保留原文件）' : ''}`, e, 'file-create');
}

const SYS = {
  /* ---- 用户管理 ---- */
  useradd: (a, e) => {
    let shell = '/bin/bash', home = null, group = null, uid = null, extra = [];
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-s') shell = a[++i];
      else if (t === '-d') home = a[++i];
      else if (t === '-u') uid = parseInt(a[++i], 10);
      else if (t === '-g') group = a[++i];
      else if (t === '-G') extra = String(a[++i] || '').split(',').filter(Boolean);
      else if (t === '-m') { /* 创建主目录（默认行为） */ }
      else if (!t.startsWith('-')) pos.push(t);
    }
    const name = pos[0];
    if (!name) return fail('用法: useradd [-m] [-s SHELL] [-g 主组] [-G 附加组] [-d 主目录] [-u UID] <用户名>', e);
    if (e.findUser(name)) return fail(`useradd: 用户 "${name}" 已存在`, e);
    if (uid == null || isNaN(uid)) uid = e.nextUid++;
    else if (e.users.some(u => u.uid === uid)) return fail(`useradd: UID ${uid} 已被占用`, e);
    else e.nextUid = Math.max(e.nextUid, uid + 1);
    home = home || '/home/' + name;
    group = group || name;
    // 登记主组与附加组（不存在则创建）
    if (!e.groups[group]) e.groups[group] = { gid: uid };
    for (const g of extra) if (!e.groups[g]) e.groups[g] = { gid: e.nextGid++ };
    e.users.push({ name, uid, group, shell, home, passwd: 'x', extraGroups: extra });
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
    if (flags.includes('G')) {
      const gids = [u.uid, ...(u.extraGroups || []).map(g => (e.groups[g] && e.groups[g].gid) || u.uid)];
      return emit([flags.includes('n') ? [u.group, ...(u.extraGroups || [])].join(' ') : gids.join(' ')], e);
    }
    if (flags.includes('n')) return emit([u.name], e);
    let groups = `${u.uid}(${u.group})`;
    for (const g of u.extraGroups || []) groups += `,${(e.groups[g] && e.groups[g].gid) || u.uid}(${g})`;
    emit([`uid=${u.uid}(${u.name}) gid=${u.uid}(${u.group}) groups=${groups}`], e);
  },

  groups: (a, e) => {
    const name = a[0] || e.env.USER;
    const u = e.findUser(name);
    if (!u) return fail(`groups: ${name}: no such user`, e);
    emit([`${name} : ${[u.group, ...(u.extraGroups || [])].join(' ')}`], e);
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

  usermod: (a, e) => {
    let shell = null, home = null, uid = null, login = null, append = false;
    let extra = null;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-s') shell = a[++i];
      else if (t === '-d') home = a[++i];
      else if (t === '-u') uid = parseInt(a[++i], 10);
      else if (t === '-l') login = a[++i];
      else if (t === '-a') append = true;
      else if (t === '-G') extra = String(a[++i] || '').split(',').filter(Boolean);
      else if (t === '-L' || t === '-U' || t === '-m') { /* 锁定/解锁/移动家目录：模拟接受 */ }
      else if (!t.startsWith('-')) pos.push(t);
    }
    const name = pos[0];
    if (!name) return fail('用法: usermod [-l 新名] [-s SHELL] [-d 主目录] [-u UID] [-aG 附加组] <用户名>', e);
    const u = e.findUser(name);
    if (!u) return fail(`usermod: 用户 "${name}" 不存在`, e);
    if (uid != null && !isNaN(uid) && uid !== u.uid) {
      if (e.users.some(x => x.uid === uid && x !== u)) return fail(`usermod: UID ${uid} 已被占用`, e);
      u.uid = uid;
    }
    if (shell) u.shell = shell;
    if (home) { u.home = home; ensureDir(e, home); }
    if (extra) u.extraGroups = append ? [...new Set([...(u.extraGroups || []), ...extra])] : extra;
    for (const g of u.extraGroups || []) if (!e.groups[g]) e.groups[g] = { gid: e.nextGid++ };
    if (login && login !== u.name) {
      if (e.findUser(login)) return fail(`usermod: 用户 "${login}" 已存在`, e);
      if (e.groups[u.name] && !e.groups[login]) { e.groups[login] = e.groups[u.name]; delete e.groups[u.name]; }
      u.name = login;
      if (e.env.USER === name) e.env.USER = login;
    }
    rebuildPasswd(e);
    okMsg(`已修改用户 ${u.name}${shell ? ` (shell=${shell})` : ''}${home ? ` (home=${home})` : ''}`, e, 'file-chmod');
  },

  userdel: (a, e) => {
    const removeHome = a.includes('-r') || a.includes('-R');
    const name = a.find(x => !x.startsWith('-'));
    if (!name) return fail('用法: userdel [-r] <用户名>', e);
    const u = e.findUser(name);
    if (!u) return fail(`userdel: 用户 "${name}" 不存在`, e);
    if (name === 'root') return fail('userdel: 不允许删除 root 用户', e);
    e.users = e.users.filter(x => x !== u);
    if (removeHome && u.home && e.exists(u.home)) e.remove(u.home, true);
    rebuildPasswd(e);
    okMsg(`已删除用户 ${name}${removeHome ? '（及其主目录）' : ''}`, e, 'proc-kill');
  },

  groupadd: (a, e) => {
    let gid = null;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-g') gid = parseInt(a[++i], 10);
      else if (a[i] === '-f') { /* 已存在则静默成功 */ }
      else if (!a[i].startsWith('-')) pos.push(a[i]);
    }
    const name = pos[0];
    if (!name) return fail('用法: groupadd [-g GID] <组名>', e);
    if (e.groups[name]) return fail(`groupadd: 组 "${name}" 已存在`, e);
    if (gid == null || isNaN(gid)) gid = e.nextGid++;
    else if (Object.values(e.groups).some(g => g.gid === gid)) return fail(`groupadd: GID ${gid} 已被占用`, e);
    e.groups[name] = { gid };
    e.nextGid = Math.max(e.nextGid, gid + 1);
    okMsg(`已创建组 ${name} (gid=${gid})`, e, 'proc-spawn');
  },

  groupdel: (a, e) => {
    const name = a.find(x => !x.startsWith('-'));
    if (!name) return fail('用法: groupdel <组名>', e);
    if (!e.groups[name]) return fail(`groupdel: 组 "${name}" 不存在`, e);
    if (e.users.some(u => u.group === name)) return fail(`groupdel: 不能删除用户 "${name}" 的主组`, e);
    delete e.groups[name];
    for (const u of e.users) if (u.extraGroups) u.extraGroups = u.extraGroups.filter(g => g !== name);
    okMsg(`已删除组 ${name}`, e, 'proc-kill');
  },

  chage: (a, e) => {
    const name = a.find(x => !x.startsWith('-'));
    if (!name) return fail('用法: chage -l <用户> | chage [-M 最长] [-m 最短] [-E 过期日] <用户>', e);
    const u = e.findUser(name);
    if (!u) return fail(`chage: 用户 "${name}" 不存在`, e);
    u.chage = u.chage || { last: 'Jul 25, 2026', min: 0, max: 99999, warn: 7, inactive: -1, expire: 'never' };
    if (a.includes('-l')) {
      const c = u.chage;
      return emit([
        `Last password change\t\t\t\t\t: ${c.last}`,
        `Password expires\t\t\t\t\t: never`,
        `Password inactive\t\t\t\t\t: never`,
        `Account expires\t\t\t\t\t\t: ${c.expire}`,
        `Minimum number of days between password change\t\t: ${c.min}`,
        `Maximum number of days between password change\t\t: ${c.max}`,
        `Number of days of warning before password expires\t: ${c.warn}`,
      ], e);
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-M') u.chage.max = parseInt(a[++i], 10) || u.chage.max;
      else if (a[i] === '-m') u.chage.min = parseInt(a[++i], 10) || 0;
      else if (a[i] === '-W') u.chage.warn = parseInt(a[++i], 10) || u.chage.warn;
      else if (a[i] === '-I') u.chage.inactive = parseInt(a[++i], 10);
      else if (a[i] === '-E') u.chage.expire = a[++i] || 'never';
      else if (a[i] === '-d') u.chage.last = a[++i] || u.chage.last;
    }
    okMsg(`已更新 ${name} 的密码有效期设置`, e, 'file-chmod');
  },

  whoami: (a, e) => emit([e.env.USER], e),

  w: (a, e) => {
    const lines = [
      ' 10:00:00 up 3 days,  4:12,  ' + e.loginRecords.length + ' users,  load average: 0.15, 0.10, 0.05',
      'USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT',
    ];
    for (const r of e.loginRecords) {
      lines.push(`${r.user.padEnd(9)}${r.tty.padEnd(9)}${r.from.padEnd(17)}${r.login.slice(-5).padEnd(9)}${r.idle.padEnd(7)} 0.10s  0.05s ${r.what}`);
    }
    emit(lines, e);
  },

  who: (a, e) => {
    emit(e.loginRecords.map(r => `${r.user.padEnd(10)} ${r.tty.padEnd(12)} ${r.login} (${r.from})`), e);
  },

  last: (a, e) => {
    let n = 10;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-n') n = parseInt(a[++i], 10) || 10;
      else if (/^-\d+$/.test(a[i])) n = parseInt(a[i].slice(1), 10);
    }
    const lines = e.loginRecords.slice(0, n).map(r =>
      `${r.user.padEnd(9)} ${r.tty.padEnd(10)} ${r.from.padEnd(16)} ${r.login.padEnd(12)}   still logged in`);
    lines.push('', `wtmp begins Fri Jul 25 07:00:00 2026`);
    emit(lines, e);
  },

  lastlog: (a, e) => {
    const lines = ['Username         Port     From             Latest'];
    for (const u of e.users) {
      const rec = e.lastlog[u.name] || '**Never logged in**';
      lines.push(`${u.name.padEnd(17)}${'pts/0'.padEnd(9)}${'10.0.0.2'.padEnd(17)}${rec}`);
    }
    emit(lines, e);
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
    if (action === 'list-unit-files') {
      const lines = ['UNIT FILE'.padEnd(16) + 'STATE'.padEnd(10) + 'PRESET'];
      let en = 0, dis = 0;
      for (const [n, s] of Object.entries(e.services)) {
        const st = s.masked ? 'masked' : (s.enabled ? 'enabled' : 'disabled');
        if (s.enabled) en++; else dis++;
        lines.push(`${(n + '.service').padEnd(16)}${st.padEnd(10)}enabled`);
      }
      lines.push('', `${Object.keys(e.services).length} unit files listed.`);
      return emit(lines, e);
    }
    if (action === 'daemon-reload' || action === 'daemon-reexec') {
      sfx('file-chmod'); e.lastOut = ''; after(true); return;
    }
    if (!svcName) return fail('用法: systemctl <start|stop|restart|status|enable|disable|mask|unmask|is-active|is-enabled|show|cat|list-unit-files> <服务>', e);
    const key = svcName.replace('.service', '');
    const svc = e.findService(key);
    if (!svc) return fail(`Failed to ${action} ${svcName}: Unit not found.`, e, 'err-syntax');
    const now = a.includes('--now');
    switch (action) {
      case 'start':
        if (svc.masked) return fail(`Failed to start ${svcName}: Unit is masked.`, e, 'err-syntax');
        svc.active = true; sfx('docker-start'); print(`● ${key}.service 已启动`, 'ok'); e.lastOut = 'active'; after(true); break;
      case 'stop': svc.active = false; sfx('docker-stop'); print(`● ${key}.service 已停止`, 'ok'); e.lastOut = 'inactive'; after(true); break;
      case 'restart':
        if (svc.masked) return fail(`Failed to restart ${svcName}: Unit is masked.`, e, 'err-syntax');
        svc.active = true; sfx('docker-start'); print(`● ${key}.service 已重启`, 'ok'); e.lastOut = 'active'; after(true); break;
      case 'enable': svc.enabled = true; if (now) svc.active = true; okMsg(`已设置 ${key} 开机自启${now ? '（并立即启动）' : ''}`, e); break;
      case 'disable': svc.enabled = false; if (now) svc.active = false; okMsg(`已取消 ${key} 开机自启${now ? '（并立即停止）' : ''}`, e); break;
      case 'mask': svc.masked = true; svc.enabled = false; svc.active = false; okMsg(`Created symlink /etc/systemd/system/${key}.service → /dev/null.（${key} 已屏蔽）`, e); break;
      case 'unmask': svc.masked = false; okMsg(`Removed /etc/systemd/system/${key}.service.（${key} 已解除屏蔽）`, e); break;
      case 'is-active': emit([svc.active ? 'active' : 'inactive'], e); break;
      case 'is-enabled': emit([svc.masked ? 'masked' : (svc.enabled ? 'enabled' : 'disabled')], e); break;
      case 'cat': emit([
        `# /lib/systemd/system/${key}.service`,
        '[Unit]',
        `Description=${svc.desc}`,
        'After=network.target',
        '',
        '[Service]',
        `ExecStart=/usr/sbin/${key}`,
        'Type=simple',
        'Restart=on-failure',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
      ], e); break;
      case 'show': emit([
        `Id=${key}.service`,
        `Names=${key}.service`,
        `Description=${svc.desc}`,
        `LoadState=${svc.masked ? 'masked' : 'loaded'}`,
        `ActiveState=${svc.active ? 'active' : 'inactive'}`,
        `SubState=${svc.active ? 'running' : 'dead'}`,
        `UnitFileState=${svc.masked ? 'masked' : (svc.enabled ? 'enabled' : 'disabled')}`,
        `MainPID=${svc.active ? 1234 : 0}`,
      ], e); break;
      case 'status': {
        const lines = [
          `● ${key}.service - ${svc.desc}`,
          `     Loaded: ${svc.masked ? 'masked (Reason: Unit is masked.)' : `loaded (/lib/systemd/system/${key}.service; ${svc.enabled ? 'enabled' : 'disabled'})`}`,
          `     Active: ${svc.active ? 'active (running)' : 'inactive (dead)'}`,
          `   Main PID: ${svc.active ? 1234 : '(none)'}`,
        ];
        emit(lines, e); break;
      }
      default: return fail(`systemctl: 未知操作 ${action}`, e, 'err-syntax');
    }
  },

  service: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    const [name, action] = pos;
    if (!name) return fail('用法: service <服务> <start|stop|restart|status>', e, 'err-syntax');
    const svc = e.findService(name);
    if (!svc) return fail(`${name}: unrecognized service`, e, 'err-syntax');
    if (action === 'start') { svc.active = true; return okMsg(` * Starting ${name} ${name}.service  [ OK ]`, e, 'docker-start'); }
    if (action === 'stop') { svc.active = false; return okMsg(` * Stopping ${name} ${name}.service  [ OK ]`, e, 'docker-stop'); }
    if (action === 'restart') { svc.active = true; return okMsg(` * Restarting ${name} ${name}.service  [ OK ]`, e, 'docker-start'); }
    if (action === 'status') {
      return emit([
        `● ${name}.service - ${svc.desc}`,
        `     Active: ${svc.active ? 'active (running)' : 'inactive (dead)'}`,
        svc.active ? `  ${name} is running (pid 1234)` : `  ${name} is stopped`,
      ], e);
    }
    return fail(`service: 未知操作 ${action || ''}（支持 start|stop|restart|status）`, e, 'err-syntax');
  },

  /* ---- 日志 ---- */
  journalctl: (a, e) => {
    let svc = null, errOnly = false, lastN = 12, follow = false, since = null, explain = false; // 默认模拟 --no-pager 截断 12 行
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-u') svc = a[++i];
      else if (t === '-n') lastN = parseInt(a[++i], 10) || 12;
      else if (/^-n\d+$/.test(t)) lastN = parseInt(t.slice(2), 10);
      else if (t === '-p' && (a[i + 1] === 'err' || a[i + 1] === '3')) { errOnly = true; i++; }
      else if (t.startsWith('-p') && /err|3/.test(t)) errOnly = true;
      else if (t === '-f' || t === '--follow') follow = true;
      else if (t === '--since') since = a[++i];
      else if (t.startsWith('--since=')) since = t.slice(8);
      else if (t === '-xe' || t === '-ex') { explain = true; }
      else if (t === '-x' || t === '--catalog' || t === '-e' || t === '--pager-end') { /* 忽略 */ }
      // --no-pager 等其余 flag 直接忽略
    }
    let lines = [];
    const sources = svc ? { [svc]: e.journal[svc] || [] } : e.journal;
    if (svc && !e.journal[svc]) return fail(`No entries for unit ${svc}`, e, 'err-syntax');
    for (const [unit, logs] of Object.entries(sources)) lines.push(...logs);
    if (errOnly) lines = lines.filter(l => /ERROR|error|invalid|failed|Aborted/i.test(l));
    lines = lines.slice(-lastN);
    if (follow) {
      const out = ['-- Journal begins at Fri 2026-07-25 07:00:00 CST. --', ...lines, '-- 正在模拟实时跟踪日志，按 Ctrl-C 退出 --'];
      return emit(out, e, 'text-grep');
    }
    if (!lines.length) return emit(['-- No entries --'], e);
    if (explain) {
      const annotated = [];
      for (const l of lines) {
        annotated.push(l);
        if (/ERROR|error|invalid|failed|Aborted/i.test(l)) {
          annotated.push('-- Subject: 该单元发生错误');
          annotated.push('-- 错误日志已由 systemd 记录，详见服务文档。');
        }
      }
      lines = annotated;
    }
    emit(lines, e, 'text-grep');
    if (since) print(`（已按 --since "${since}" 过滤）`, 'dim');
  },

  dmesg: (a, e) => {
    emit(['[    0.000000] Linux version 6.1.0-termquest', '[    1.234567] EXT4-fs (sda1): mounted filesystem', '[    2.345678] eth0: link up, 1000Mbps'], e);
  },

  /* ---- 磁盘 ---- */
  df: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const fsType = (d) => {
      const dev = e.blockDevices.find(b => d.fs.includes(b.name));
      return (dev && dev.fsType) || 'ext4';
    };
    if (flags.includes('i')) {
      // inode 使用情况（模拟）
      const lines = ['Filesystem       Inodes  IUsed   IFree IUse% Mounted on'];
      for (const d of e.disks) {
        const total = (parseFloat(d.size) || 1) * 65536;
        const used = Math.round(total * d.usePct / 100);
        lines.push(`${d.fs.padEnd(15)} ${String(Math.round(total)).padStart(7)} ${String(used).padStart(6)} ${String(Math.round(total) - used).padStart(7)}  ${String(d.usePct + '%').padStart(4)} ${d.mount}`);
      }
      return emit(lines, e);
    }
    if (flags.includes('T')) {
      const lines = ['Filesystem     Type     Size  Used Avail Use% Mounted on'];
      for (const d of e.disks) {
        lines.push(`${d.fs.padEnd(15)}${fsType(d).padEnd(9)}${d.size.padStart(4)}  ${d.used.padStart(4)}  ${d.avail.padStart(4)}  ${String(d.usePct + '%').padStart(3)} ${d.mount}`);
      }
      return emit(lines, e);
    }
    // 默认（含 -h：引擎中容量本身即 '50G' 形式，加不加 -h 列内容一致）
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
    if (a.includes('-e')) {
      // 模拟交互式编辑：展示当前内容并提示
      const body = e.cron.length ? e.cron : ['# 分 时 日 月 周 命令', '# 0 2 * * * /usr/local/bin/backup.sh'];
      return emit([`# 正在以 ${e.env.USER} 身份编辑 crontab（模拟编辑器，内容如下）`, ...body, '# 保存退出后生效；本模拟器中可直接用 crontab <文件> 安装'], e);
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
    return fail('用法: crontab -l | crontab -e | crontab <文件> | crontab -r', e, 'err-syntax');
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
      e.archives[archiveName] = { files: stored, gz: flags.includes('z') || flags.includes('j') };
      e.writeFile(archiveName, `[binary ${flags.includes('z') ? 'gzip ' : flags.includes('j') ? 'bzip2 ' : ''}archive: ${Object.keys(stored).length} files]`);
      sfx('file-create');
      if (verbose) Object.keys(stored).forEach(p => print(p, 'out'));
      print(`已归档 ${Object.keys(stored).length} 个文件到 ${archiveName}`, 'ok');
      e.lastOut = archiveName; after(true); return;
    }
    if (flags.includes('t')) {
      if (!archiveName || !e.archives[archiveName]) return fail(`tar: ${archiveName || ''}: 无法打开: 没有那个文件或目录`, e, 'err-file');
      const files = e.archives[archiveName].files;
      if (verbose) {
        const lines = Object.entries(files).map(([p, c]) =>
          `-rw-r--r-- ${e.env.USER}/${e.env.USER} ${String((c || '').length).padStart(6)} 2026-07-25 10:00 ${p}`);
        emit(lines, e);
        e.lastOut = Object.keys(files).join('\n');
        return;
      }
      return emit(Object.keys(files), e);
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
    return fail('用法: tar -czf 归档.tar.gz 文件... | tar -tf 归档 | tar -tvf 归档 | tar -xzf/-xjf 归档 [-C 目录] [-v]', e, 'err-syntax');
  },

  gzip: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const f = a.find(x => !x.startsWith('-'));
    if (flags.includes('d')) return decompressGz(f, e); // gzip -d 等价于 gunzip
    compressOne(f, '.gz', 'gzip', e, flags.includes('k'));
  },

  gunzip: (a, e) => {
    const f = a.find(x => !x.startsWith('-'));
    decompressGz(f, e);
  },

  zip: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const pos = a.filter(x => !x.startsWith('-'));
    const archive = pos[0];
    const files = pos.slice(1);
    if (!archive) return fail('用法: zip [-r] 归档.zip 文件...', e, 'err-syntax');
    if (!files.length) return fail('zip: 没有指定要压缩的文件', e, 'err-syntax');
    const name = archive.endsWith('.zip') ? archive : archive + '.zip';
    const stored = {};
    for (const t of files) {
      if (e.isDir(t)) e.walk(t).forEach(rel => { const p = t + '/' + rel; stored[p] = e.readFile(p).content; });
      else {
        const r = e.readFile(t);
        if (r.err) return fail(`zip: ${t}: 没有那个文件或目录`, e, 'err-file');
        stored[t] = r.content;
      }
    }
    e.archives[name] = { files: stored, gz: true };
    e.writeFile(name, `[zip archive: ${Object.keys(stored).length} files]`);
    sfx('file-create');
    const lines = ['  adding: ' + Object.keys(stored).join('\n  adding: '), `已压缩 ${Object.keys(stored).length} 个文件到 ${name}`];
    print(lines.join('\n'), 'ok'); e.lastOut = name; after(true);
  },

  unzip: (a, e) => {
    const listOnly = a.includes('-l');
    const f = a.find(x => !x.startsWith('-'));
    if (!f || !e.exists(f)) return fail(`unzip: ${f || ''}: 没有那个文件或目录`, e, 'err-file');
    const arc = e.archives[f];
    if (!arc) return fail(`unzip: ${f}: 不是有效的 zip 归档`, e, 'err-file');
    if (listOnly) {
      const lines = ['Archive:  ' + f, '  Length      Date    Time    Name', '---------  ---------- -----   ----'];
      for (const [p, c] of Object.entries(arc.files)) lines.push(`${String((c || '').length).padStart(9)}  2026-07-25 10:00   ${p}`);
      lines.push(`---------                     -------`, `                              ${Object.keys(arc.files).length} files`);
      return emit(lines, e);
    }
    for (const [p, content] of Object.entries(arc.files)) {
      ensureDir(e, e.dirname(e.resolvePath(p)));
      e.writeFile(p, content);
    }
    sfx('file-copy');
    print('  inflating: ' + Object.keys(arc.files).join('\n  inflating: '), 'out');
    okMsg(`已解压 ${Object.keys(arc.files).length} 个文件`, e, 'file-copy');
  },

  bzip2: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const f = a.find(x => !x.startsWith('-'));
    if (flags.includes('d')) return decompressOne(f, '.bz2', 'bunzip2', e, flags.includes('k'));
    compressOne(f, '.bz2', 'bzip2', e, flags.includes('k'));
  },

  bunzip2: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    decompressOne(a.find(x => !x.startsWith('-')), '.bz2', 'bunzip2', e, flags.includes('k'));
  },

  xz: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const f = a.find(x => !x.startsWith('-'));
    if (flags.includes('d')) return decompressOne(f, '.xz', 'unxz', e, flags.includes('k'));
    compressOne(f, '.xz', 'xz', e, flags.includes('k'));
  },

  unxz: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    decompressOne(a.find(x => !x.startsWith('-')), '.xz', 'unxz', e, flags.includes('k'));
  },

  zcat: (a, e) => {
    const f = a.find(x => !x.startsWith('-'));
    if (!f || !e.exists(f)) return fail(`zcat: ${f || ''}: 没有那个文件或目录`, e, 'err-file');
    const arc = e.archives[f];
    const entry = arc && Object.entries(arc.files)[0];
    if (entry) return emit([entry[1]], e);
    // 非归档：直接输出文件内容
    const r = e.readFile(f);
    if (r.err) return fail(r.err, e, 'err-file');
    emit((r.content || '').split('\n'), e);
  },

  /* ---- 文件 / 权限 ---- */
  chattr: (a, e) => {
    const ops = a.filter(x => /^[+-=][a-zA-Z]+$/.test(x));
    const files = a.filter(x => !x.startsWith('-') && !/^[+-=]/.test(x));
    if (!ops.length || !files.length) return fail('用法: chattr [+i|-i|+a|-a] 文件...', e, 'err-syntax');
    for (const f of files) {
      const node = e.getNode(e.resolvePath(f));
      if (!node) return fail(`chattr: ${f}: 没有那个文件或目录`, e, 'err-file');
      let attrs = node.attrs || '';
      for (const op of ops) {
        const sign = op[0], bits = op.slice(1);
        for (const b of bits) {
          if (sign === '+') { if (!attrs.includes(b)) attrs += b; }
          else if (sign === '-') attrs = attrs.replace(new RegExp(b, 'g'), '');
          else attrs = bits;
        }
      }
      node.attrs = attrs;
    }
    okMsg(`已设置属性 ${ops.join(' ')} → ${files.join(', ')}`, e, 'file-chmod');
  },

  lsattr: (a, e) => {
    const files = a.filter(x => !x.startsWith('-'));
    if (!files.length) return fail('用法: lsattr 文件...', e, 'err-syntax');
    emit(files.map(f => {
      const node = e.getNode(e.resolvePath(f));
      const attrs = (node && node.attrs) || '';
      return `${(attrs || '----------------').padEnd(16)} ${f}`;
    }), e);
  },

  find: (a, e) => {
    let start = '.', namePat = null, typeF = null, maxDepth = Infinity;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      const t = a[i];
      if (t === '-name' || t === '-iname') namePat = a[++i];
      else if (t === '-type') typeF = a[++i];
      else if (t === '-maxdepth') maxDepth = parseInt(a[++i], 10) || Infinity;
      else if (t === '-print' || t === '-ls') { /* 默认即打印 */ }
      else if (!t.startsWith('-')) pos.push(t);
    }
    if (pos.length) start = pos[0];
    if (!e.exists(start)) return fail(`find: '${start}': 没有那个文件或目录`, e, 'err-file');
    const toReg = (pat) => new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const re = namePat ? toReg(namePat) : null;
    const out = [];
    const base = e.resolvePath(start);
    const walkF = (path, depth) => {
      if (depth > maxDepth) return;
      const node = e.follow(path);
      if (!node) return;
      const disp = path === base ? start : (start === '.' ? path.replace(/^\.\//, '') : path);
      const isDir = node.type === 'dir';
      const matchType = !typeF || (typeF === 'd' && isDir) || (typeF === 'f' && node.type === 'file');
      const bn = e.basename(path);
      const matchName = !re || re.test(bn);
      if (matchType && matchName) out.push(disp);
      if (isDir) for (const c of Object.keys(node.children).sort()) walkF(path.replace(/\/$/, '') + '/' + c, depth + 1);
    };
    walkF(base, 0);
    if (!out.length) return emit([`（在 ${start} 下未找到匹配项）`], e);
    emit(out, e);
  },

  rsync: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    if (pos.length < 2) return fail('用法: rsync [-avz] 源 目标', e, 'err-syntax');
    const src = pos[pos.length - 2], dst = pos[pos.length - 1];
    if (!e.exists(src)) return fail(`rsync: link_stat "${src}" failed: No such file or directory`, e, 'err-file');
    const verbose = a.some(x => x.includes('v'));
    const copied = [];
    const doCopy = (s, d) => {
      if (e.isDir(s)) {
        if (!e.exists(d)) ensureDir(e, d);
        e.walk(s).forEach(rel => {
          const sp = s + '/' + rel, dp = d + '/' + rel;
          ensureDir(e, e.dirname(e.resolvePath(dp)));
          e.writeFile(dp, e.readFile(sp).content);
          copied.push(rel);
        });
      } else {
        ensureDir(e, e.dirname(e.resolvePath(d)));
        const target = e.isDir(d) ? d.replace(/\/$/, '') + '/' + e.basename(e.resolvePath(s)) : d;
        e.writeFile(target, e.readFile(s).content);
        copied.push(e.basename(e.resolvePath(s)));
      }
    };
    doCopy(src, dst);
    sfx('file-copy');
    if (verbose && copied.length) print(copied.map(c => c).join('\n'), 'out');
    print(`已同步 ${copied.length || 1} 个文件 ${src} → ${dst}`, 'ok');
    e.lastOut = copied.join('\n') || dst; after(true);
  },

  /* ---- 内存 / 负载 ---- */
  free: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const m = e.mem;
    const sw = e.swap && e.swap.on ? e.swap : { total: 0, used: 0 };
    const swTotal = sw.total || 0, swUsed = sw.used || 0, swFree = swTotal - swUsed;
    if (flags.includes('h') || flags.includes('m')) {
      // -h 人类可读（Mi/Gi）；-m 以 MB 为单位（引擎内存值本身即 MB）
      const f = flags.includes('h')
        ? (v) => humanMB(v).padStart(8)
        : (v) => String(v).padStart(8);
      return emit([
        '              total        used        free      shared  buff/cache   available',
        `Mem:        ${f(m.total)}    ${f(m.used)}    ${f(m.free)}     ${f(128)}    ${f(m.cache)}    ${f(m.total - m.used)}`,
        `Swap:       ${f(swTotal)}    ${f(swUsed)}    ${f(swFree)}`,
      ], e);
    }
    const lines = [
      '              total        used        free      shared  buff/cache   available',
      `Mem:        ${String(m.total).padStart(8)}    ${String(m.used).padStart(8)}    ${String(m.free).padStart(8)}     128    ${String(m.cache).padStart(8)}    ${String(m.total - m.used).padStart(8)}`,
      `Swap:       ${String(swTotal).padStart(8)}    ${String(swUsed).padStart(8)}    ${String(swFree).padStart(8)}`,
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

  /* ---- 进程 / 性能 ---- */
  ps: (a, e) => {
    const flags = a.filter(x => x.startsWith('-') || /^[auxef]+$/.test(x)).join('').replace(/-/g, '');
    const wide = a.includes('-f') || flags.includes('f') || flags.includes('u');
    if (wide) {
      const lines = ['USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND'];
      for (const p of e.procs) {
        const user = (p.name === 'init' || p.name === 'sshd') ? 'root' : e.env.USER;
        lines.push(`${user.padEnd(8)} ${String(p.pid).padStart(5)} ${p.cpu.padStart(4)} ${p.mem.padStart(4)}  22604  5892 pts/0    ${p.state}+   10:00   0:00 ${p.cmd}`);
      }
      return emit(lines, e);
    }
    const lines = ['  PID TTY          TIME CMD'];
    for (const p of e.procs) {
      const time = `00:00:${String(p.pid % 60).padStart(2, '0')}`;
      lines.push(`${String(p.pid).padStart(5)} pts/0  ${time} ${p.cmd}`);
    }
    emit(lines, e);
  },

  top: (a, e) => {
    const running = e.procs.filter(p => p.state === 'R').length || 1;
    const lines = [
      'top - 10:00:00 up 3 days,  4:12,  1 user,  load average: 0.15, 0.10, 0.05',
      `Tasks: ${e.procs.length} total,   ${running} running, ${e.procs.length - running} sleeping,   0 stopped,   0 zombie`,
      `%Cpu(s):  3.0 us,  1.0 sy,  0.0 ni, 96.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`,
      `MiB Mem :   ${e.mem.total}.0 total,   ${e.mem.free}.0 free,   ${e.mem.used}.0 used,   ${e.mem.cache}.0 buff/cache`,
      '',
      '  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ];
    for (const p of e.procs) {
      lines.push(`${String(p.pid).padStart(5)} ${e.env.USER.padEnd(9)} 20   0   22604   5892   3456 ${p.state}   ${p.cpu}   ${p.mem}   0:00.0${p.pid % 10} ${p.name}`);
    }
    emit(lines, e);
  },

  htop: (a, e) => {
    const memPct = Math.round(e.mem.used / e.mem.total * 10);
    const swpPct = e.swap && e.swap.on ? Math.round((e.swap.used || 0) / e.swap.total * 10) : 0;
    const bar = (n, label) => `${label}[${'='.repeat(n)}${' '.repeat(10 - n)}]`;
    const lines = [
      '  1' + bar(1, ' '), '  2' + bar(0, ' '),
      '  Mem' + bar(memPct, ' '), '  Swp' + bar(swpPct, ' '),
      '',
      '  PID USER     PRI  NI  VIRT   RES   SHR S CPU% MEM%   TIME+  Command',
    ];
    for (const p of e.procs) {
      lines.push(`${String(p.pid).padStart(5)} ${e.env.USER.padEnd(8)}  20   0 22604  5892  3456 ${p.state}  ${p.cpu}  ${p.mem} 0:00.0${p.pid % 10} ${p.cmd}`);
    }
    lines.push('', '按 q 退出（本模拟器为静态快照）');
    emit(lines, e);
  },

  nice: (a, e) => {
    let n = 10;
    const pos = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-n') n = parseInt(a[++i], 10) || 0;
      else if (/^-\d+$/.test(a[i])) n = parseInt(a[i].slice(1), 10);
      else if (!a[i].startsWith('-')) pos.push(a[i]);
    }
    const cmd = pos[0];
    if (!cmd) return fail('用法: nice [-n 优先级] <命令>', e);
    const pid = e.spawn(cmd, cmd, 'S');
    okMsg(`已以 nice=${n} 启动 ${cmd} (pid=${pid})`, e, 'proc-spawn');
  },

  renice: (a, e) => {
    let n = null;
    const nums = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '-n') n = parseInt(a[++i], 10);
      else if (/^-?\d+$/.test(a[i])) nums.push(parseInt(a[i], 10));
    }
    let pid = null;
    if (nums.length >= 2) { if (n === null) n = nums[0]; pid = nums[nums.length - 1]; }
    else if (nums.length === 1) pid = nums[0];
    if (n === null) n = 10;
    if (pid == null) return fail('用法: renice [-n] 优先级 PID', e);
    const p = e.procs.find(x => x.pid === pid);
    if (!p) return fail(`renice: ${pid}: 没有那个进程`, e);
    p.nice = n;
    okMsg(`${pid} (process ID) 旧优先级 0，新优先级 ${n}`, e, 'file-chmod');
  },

  watch: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    if (!pos.length) return fail('用法: watch [-n 秒] <命令>', e);
    const cmd = pos.join(' ');
    print(`Every 2.0s: ${cmd}    Fri Jul 25 10:00:00 2026`, 'dim');
    print('', 'out');
    // 执行一次被监视的命令并展示其输出
    if (SYS[pos[0]]) SYS[pos[0]](pos.slice(1), e);
    else linuxExecute(cmd);
    print('（watch 模拟：仅刷新一次，按 Ctrl-C 退出）', 'dim');
  },

  iostat: (a, e) => {
    emit([
      'Linux 6.1.0-termquest (termquest) \t07/25/26 \t_x86_64_\t(4 CPU)',
      '',
      'avg-cpu:  %user   %nice %system %iowait  %steal   %idle',
      '           3.00    0.00    1.00    0.00    0.00   96.00',
      '',
      'Device             tps    kB_read/s    kB_wrtn/s    kB_read    kB_wrtn',
      'sda              12.30       240.10       512.40     240100     512400',
      'sdb               3.10        60.00       128.00      60000     128000',
    ], e);
  },

  mpstat: (a, e) => {
    emit([
      'Linux 6.1.0-termquest (termquest) \t07/25/26 \t_x86_64_\t(4 CPU)',
      '',
      'CPU    %usr   %nice    %sys %iowait   %steal   %idle',
      'all    3.00    0.00    1.00    0.00     0.00   96.00',
      '  0    3.10    0.00    1.10    0.00     0.00   95.80',
      '  1    2.90    0.00    0.90    0.00     0.00   96.20',
    ], e);
  },

  sar: (a, e) => {
    emit([
      'Linux 6.1.0-termquest (termquest) \t07/25/26 \t_x86_64_\t(4 CPU)',
      '',
      '10:00:01     CPU     %user     %nice   %system   %iowait    %steal     %idle',
      '10:00:02     all      3.00      0.00      1.00      0.00      0.00     96.00',
      'Average:     all      3.00      0.00      1.00      0.00      0.00     96.00',
    ], e);
  },

  nproc: (a, e) => emit([a.includes('--all') ? '4' : '4'], e),

  lscpu: (a, e) => {
    emit([
      'Architecture:            x86_64',
      '  CPU op-mode(s):        32-bit, 64-bit',
      'CPU(s):                  4',
      '  On-line CPU(s) list:   0-3',
      'Vendor ID:               GenuineIntel',
      '  Model name:            Intel(R) Xeon(R) CPU @ 2.20GHz',
      '  CPU MHz:               2200.000',
      '  Core(s) per socket:    2',
      '  Socket(s):             1',
      '  Thread(s) per core:    2',
      'L1d cache:               64 KiB',
      'L1i cache:               64 KiB',
      'L2 cache:                1 MiB',
      'L3 cache:                16 MiB',
    ], e);
  },

  lsmod: (a, e) => {
    const lines = ['Module                  Size  Used by'];
    for (const [name, m] of Object.entries(e.kernelModules)) {
      lines.push(`${name.padEnd(24)}${String(m.size).padStart(6)}  ${m.usedBy}`);
    }
    emit(lines, e);
  },

  modprobe: (a, e) => {
    const remove = a.includes('-r') || a.includes('--remove');
    const name = a.find(x => !x.startsWith('-'));
    if (!name) return fail('用法: modprobe [-r] <模块名>', e);
    if (remove) {
      if (!e.kernelModules[name]) return fail(`modprobe: FATAL: Module ${name} not found.`, e, 'err-syntax');
      delete e.kernelModules[name];
      return okMsg(`已卸载模块 ${name}`, e, 'proc-kill');
    }
    if (e.kernelModules[name]) return okMsg(`模块 ${name} 已加载`, e);
    e.kernelModules[name] = { size: 16384, usedBy: '0' };
    okMsg(`已加载模块 ${name}`, e, 'proc-spawn');
  },

  /* ---- 磁盘底层工具 ---- */
  dd: (a, e) => {
    let inf = null, outf = null, bs = 512, count = 1, status = null;
    for (const t of a) {
      if (t.startsWith('if=')) inf = t.slice(3);
      else if (t.startsWith('of=')) outf = t.slice(3);
      else if (t.startsWith('bs=')) {
        const m = t.slice(3).match(/^(\d+)([kKmM]?)$/);
        if (m) bs = parseInt(m[1], 10) * (m[2].toLowerCase() === 'k' ? 1024 : m[2].toLowerCase() === 'm' ? 1048576 : 1);
      } else if (t.startsWith('count=')) count = parseInt(t.slice(6), 10) || 1;
      else if (t.startsWith('status=')) status = t.slice(7);
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
    const summary = [];
    if (status === 'progress') summary.push(`${total} bytes (${(total / 1048576).toFixed(1)} MB) copied, 1 s, ${(total / 1048576).toFixed(1)} MB/s`);
    summary.push(
      `${count}+0 records in`,
      `${count}+0 records out`,
      `${total} bytes copied, ${secs.toFixed(4)} s, ${(total / secs / 1048576).toFixed(1)} MB/s`,
    );
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

  parted: (a, e) => {
    if (!a.includes('-l') && !a.includes('--list')) {
      return fail('用法: parted -l 查看分区（本模拟器仅支持只读列表）', e, 'err-syntax');
    }
    const lines = [];
    for (const d of e.blockDevices.filter(x => x.type === 'disk')) {
      const gb = parseFloat(d.size) || 0;
      lines.push(`Model: ATA QEMU HARDDISK (scsi)`);
      lines.push(`Disk /dev/${d.name}: ${gb.toFixed(1)}GB`);
      lines.push('Sector size (logical/physical): 512B/512B');
      lines.push('Partition Table: msdos');
      lines.push('Disk Flags: ');
      lines.push('');
      lines.push('Number  Start   End     Size    Type     File system  Flags');
      const parts = e.blockDevices.filter(x => x.type === 'part' && x.name.startsWith(d.name));
      let start = 1.05;
      parts.forEach((p, i) => {
        const pGb = parseFloat(p.size) || 0;
        lines.push(` ${String(i + 1).padEnd(7)} ${start.toFixed(2)}MB  ${(start + pGb * 1000).toFixed(1)}MB  ${(pGb * 1000).toFixed(0)}MB  primary  ${p.fsType || 'ext4'}`);
        start += pGb * 1000;
      });
      lines.push('');
    }
    emit(lines, e);
  },

  fsck: (a, e) => {
    const dev = a.find(x => !x.startsWith('-'));
    if (!dev) return fail('用法: fsck [-A] [-N] <设备>', e, 'err-syntax');
    const devName = dev.replace(/^\/dev\//, '');
    const d = e.blockDevices.find(x => x.name === devName);
    if (!d) return fail(`fsck: ${dev}: 没有那个文件或目录`, e, 'err-file');
    emit([
      `fsck from util-linux 2.37.2`,
      `e2fsck 1.46.5 (30-Dec-2021)`,
      `${dev}: clean, 131072/1310720 files, 1234567/5242880 blocks`,
    ], e);
  },

  swapon: (a, e) => {
    if (a.includes('-s') || a.includes('--summary') || a.includes('--show')) {
      if (!e.swap.on) return emit(['Filename\t\t\t\tType\t\tSize\tUsed\tPriority'], e);
      return emit([
        'Filename\t\t\t\tType\t\tSize\tUsed\tPriority',
        `${e.swap.device.padEnd(40)}partition\t${e.swap.total}\t${e.swap.used}\t-2`,
      ], e);
    }
    // swapon -a 或 swapon <设备>：启用交换
    e.swap.on = true;
    okMsg(`已启用交换分区 ${e.swap.device}（${e.swap.total}M）`, e, 'file-move');
  },

  swapoff: (a, e) => {
    e.swap.on = false;
    okMsg(`已停用交换分区 ${e.swap.device}`, e, 'file-move');
  },

  /* ---- 系统 / 调度 ---- */
  at: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    const when = pos[0];
    const cmd = pos.slice(1).join(' ');
    if (!when) return fail('用法: at <时间> [命令]（如 at now + 1 minute）', e, 'err-syntax');
    const job = e.nextAtJob++;
    e.atJobs.push({ job, when, cmd: cmd || '(从标准输入读取命令)', owner: e.env.USER });
    okMsg(`job ${job} at Fri Jul 25 10:00:00 2026（计划任务已登记${cmd ? '：' + cmd : ''}）`, e, 'proc-spawn');
  },

  atq: (a, e) => {
    if (!e.atJobs.length) return emit(['（没有计划任务）'], e);
    emit(e.atJobs.map(j => `${j.job}\tFri Jul 25 10:00:00 2026 a ${j.owner}`), e);
  },

  sysctl: (a, e) => {
    if (a.includes('-a') || a.includes('--all')) {
      return emit(Object.entries(e.sysctl).map(([k, v]) => `${k} = ${v}`), e);
    }
    if (a.includes('-w')) {
      const assign = a.find(x => x.includes('='));
      if (!assign) return fail('用法: sysctl -w key=value', e, 'err-syntax');
      const [k, v] = assign.split('=');
      e.sysctl[k] = v;
      return okMsg(`${k} = ${v}`, e, 'file-write');
    }
    const key = a.find(x => !x.startsWith('-'));
    if (!key) return fail('用法: sysctl -a | sysctl -w key=value | sysctl <key>', e, 'err-syntax');
    if (key.includes('=')) {
      const [k, v] = key.split('=');
      e.sysctl[k] = v;
      return okMsg(`${k} = ${v}`, e, 'file-write');
    }
    if (e.sysctl[key] === undefined) return fail(`sysctl: cannot stat /proc/sys/${key.replace(/\./g, '/')}: No such file or directory`, e, 'err-file');
    emit([`${key} = ${e.sysctl[key]}`], e);
  },

  logger: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    const msg = pos.join(' ') || '';
    if (!msg) return fail('用法: logger <消息>', e, 'err-syntax');
    const line = `Jul 25 10:00:00 termquest ${e.env.USER}: ${msg}`;
    (e.journal.user = e.journal.user || []).push(line);
    okMsg(`已记录日志：${msg}`, e, 'file-write');
  },

  wall: (a, e) => {
    const pos = a.filter(x => !x.startsWith('-'));
    const msg = pos.join(' ') || '(无消息内容)';
    emit([
      `Broadcast message from ${e.env.USER}@termquest (pts/0) (Fri Jul 25 10:00:00 2026):`,
      '',
      msg,
    ], e);
  },

  shutdown: (a, e) => {
    if (a.includes('-c')) return okMsg('已取消挂起的关机计划', e);
    const reboot = a.includes('-r');
    const when = a.find(x => !x.startsWith('-')) || 'now';
    okMsg(`${reboot ? 'Reboot' : 'Shutdown'} scheduled for ${when === 'now' ? 'Fri 2026-07-25 10:01:00 CST' : when}（模拟：系统将在该时间${reboot ? '重启' : '关机'}）`, e, 'docker-stop');
  },

  reboot: (a, e) => {
    okMsg('System is going down for reboot NOW!（模拟：系统即将重启）', e, 'docker-stop');
  },

  halt: (a, e) => {
    okMsg('System halted.（模拟：系统已停止）', e, 'docker-stop');
  },

  poweroff: (a, e) => {
    okMsg('System is going down for poweroff NOW!（模拟：系统即将断电）', e, 'docker-stop');
  },
};

function showSysHelp() {
  ['── 用户 ──',
    '  useradd [-m] [-s SHELL] [-g 主组] [-G 附加组] [-d 主目录] [-u UID] <名> · passwd <名>',
    '  usermod [-l 新名] [-s SHELL] [-d 目录] [-u UID] [-aG 组] <名> · userdel [-r] <名>',
    '  groupadd [-g GID] <组> · groupdel <组> · chage -l <名> · id [-u|-g|-G|-n] [名] · groups [名]',
    '  whoami · w · who · last [-n N] · lastlog · sudo <命令> · su <名>',
    '── 服务/日志 ──',
    '  systemctl start|stop|restart|status|enable|disable|mask|unmask <服务> [--now]',
    '  systemctl is-active|is-enabled|show|cat <服务> · list-units · list-unit-files · daemon-reload',
    '  service <名> start|stop|restart|status · journalctl [-u 服务] [-p err] [-n N] [-f] [-xe] [--since T] · dmesg',
    '── 磁盘 ──',
    '  df [-h|-T|-i] · du [-s|-h|-a] [-d 深度] [路径] · lsblk · fdisk -l · parted -l · fsck <设备>',
    '  mount [设备 挂载点] · umount <挂载点> · mkfs -t ext4 /dev/sdX · swapon [-s] · swapoff',
    '  dd if=<输入|/dev/zero> of=<文件> [bs=N] [count=N] [status=progress]',
    '── 文件/权限 ──',
    '  chmod · chown · ln -s · chattr [+i|-i|+a] 文件 · lsattr · find [路径] [-name 通配] [-type f|d] · rsync [-avz] 源 目标',
    '── 压缩 ──',
    '  tar -czf/-cjf 包 文件 · tar -tf/-tvf 包 · tar -xzf/-xjf 包 [-C 目录] [-v]',
    '  gzip [-k|-9] · gunzip · bzip2/bunzip2 · xz/unxz · zcat · zip [-r] 包.zip 文件 · unzip [-l] 包.zip',
    '── 定时任务 ──',
    '  crontab -l|-e|-r · crontab <文件> · at <时间> [命令] · atq',
    '── 进程/性能 ──',
    '  ps [aux|-ef] · top · htop · nice [-n N] 命令 · renice N PID · watch 命令',
    '  free [-h|-m] · uptime · vmstat · lsof [-i] [-p PID] · iostat · mpstat · sar · nproc · lscpu',
    '  lsmod · modprobe [-r] 模块',
    '── 系统 ──',
    '  sysctl -a|-w k=v|<key> · logger <消息> · wall <消息> · shutdown [-r|-c] [时间] · reboot · halt · poweroff',
    '── 其余 ──',
    '  ls · cat ... 照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
