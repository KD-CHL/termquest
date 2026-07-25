// 网络工具命令集 —— ping / dig / nslookup / curl / wget / nc / ss / traceroute / ssh-keygen
// 网络类命令由本模块处理，其余委托 linuxExecute（操作同一个 NetEngine）。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'whoami', 'hostname', 'uname', 'date', 'history', 'echo', 'wc', 'head', 'tail', 'env'];

export function netExecute(input) {
  input = input.trim();
  if (!input) return;
  const e = E();
  const base = input.split(/\s/)[0];

  if (base === 'help') { printCmd(input); showNetHelp(); return; }
  if (NET[base]) {
    printCmd(input);
    if (!FREE.includes(base)) { app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount(); }
    track(base); e.used.add(base);
    const t = tokenize(input);
    NET[base](t.slice(1), e);
    return;
  }
  // 其余 → 本地 linux 命令
  linuxExecute(input);
}

function ok(msg, sfxName) { if (sfxName) sfx(sfxName); print(msg, 'ok'); e_last(); after(true); }
function e_last() {}
function fail(msg, sfxName = 'net-error') { sfx(sfxName); print(msg, 'err'); E().lastOut = ''; after(false); }

const NET = {
  /* ---- 连通性 ---- */
  ping: (a, e) => {
    let count = 4;
    const ci = a.indexOf('-c'); if (ci >= 0 && a[ci + 1]) count = parseInt(a[ci + 1]) || 4;
    const host = a.filter(x => !x.startsWith('-') && a[a.indexOf(x) - 1] !== '-c')[0];
    if (!host) return fail('ping: 用法: ping [-c 次数] <主机>');
    const ip = host === 'localhost' ? '127.0.0.1' : (e.findHost(host)?.ip || e.resolveDns(host));
    if (!ip) { print(`ping: ${host}: Name or service not known`, 'err'); e.lastOut = ''; after(false); return; }
    const up = e.isUp(host);
    const lines = [`PING ${host} (${ip}) 56(84) bytes of data.`];
    if (up) {
      for (let i = 0; i < count; i++) {
        const t = (Math.sin(i + 1) * 8 + 12).toFixed(1);
        lines.push(`64 bytes from ${ip}: icmp_seq=${i + 1} ttl=57 time=${t} ms`);
      }
      lines.push('', `--- ${host} ping statistics ---`,
        `${count} packets transmitted, ${count} received, 0% packet loss`);
      sfx('net-connect');
    } else {
      for (let i = 0; i < count; i++) lines.push(`Request timeout for icmp_seq ${i}`);
      lines.push('', `--- ${host} ping statistics ---`,
        `${count} packets transmitted, 0 received, 100% packet loss`);
      sfx('net-error');
    }
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  traceroute: (a, e) => {
    const host = a.filter(x => !x.startsWith('-'))[0];
    if (!host) return fail('用法: traceroute <主机>');
    const ip = e.findHost(host)?.ip || e.resolveDns(host);
    if (!ip) return fail(`traceroute: ${host}: Name or service not known`);
    const lines = [`traceroute to ${host} (${ip}), 30 hops max`];
    const hops = [['192.168.1.1', 'gateway'], ['10.20.0.1', 'core-router'], [ip, e.findHost(host)?.hostname || host]];
    hops.forEach(([h, n], i) => lines.push(` ${i + 1}  ${n} (${h})  ${(i + 1) * 3.7} ms  ${(i + 1) * 3.9} ms  ${(i + 1) * 3.8} ms`));
    sfx('net-connect');
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  /* ---- DNS ---- */
  dig: (a, e) => {
    const args = a.filter(x => !x.startsWith('+'));
    const domain = args.find(x => !/^(A|MX|NS|CNAME|TXT|ANY)$/.test(x));
    let qtype = args.find(x => /^(A|MX|NS|CNAME|TXT|ANY)$/.test(x)) || 'A';
    if (!domain) return fail('用法: dig <域名> [A|MX|NS|CNAME]');
    const rec = e.dns[domain];
    const short = a.some(x => x.startsWith('+short'));
    if (!rec) {
      if (short) { e.lastOut = ''; after(true); return; }
      print(`;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 4242`, 'out');
      print(`;; ANSWER: 0`, 'out');
      e.lastOut = 'NXDOMAIN'; after(true); return;
    }
    const answers = [];
    const types = qtype === 'ANY' ? ['A', 'MX', 'NS', 'CNAME'] : [qtype];
    for (const t of types) {
      if (rec[t]) rec[t].forEach(v => answers.push(`${domain}.  300  IN  ${t}  ${v}`));
    }
    if (rec.CNAME && qtype === 'A') {
      const target = e.dns[rec.CNAME];
      answers.push(`${domain}.  300  IN  CNAME  ${rec.CNAME}.`);
      if (target && target.A) target.A.forEach(v => answers.push(`${rec.CNAME}.  300  IN  A  ${v}`));
    }
    if (short) {
      const out = answers.map(l => l.split(/\s+/).pop());
      out.forEach(l => print(l, 'out')); e.lastOut = out.join('\n'); after(true); return;
    }
    const lines = [
      `; <<>> DiG 9.18 <<>> ${domain} ${qtype}`,
      `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242`,
      `;; ANSWER SECTION:`,
      ...answers,
      `;; Query time: 12 msec`,
    ];
    sfx('text-grep');
    lines.forEach(l => print(l, 'out')); e.lastOut = answers.join('\n'); after(true);
  },

  nslookup: (a, e) => {
    const domain = a[0];
    if (!domain) return fail('用法: nslookup <域名>');
    const ip = e.resolveDns(domain);
    if (!ip) { print(`** server can't find ${domain}: NXDOMAIN`, 'err'); e.lastOut = ''; after(false); return; }
    const lines = [`Server:  8.8.8.8`, `Address: 8.8.8.8#53`, '', `Name: ${domain}`, `Address: ${ip}`];
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  host: (a, e) => {
    const domain = a[0];
    if (!domain) return fail('用法: host <域名>');
    const rec = e.dns[domain];
    if (!rec) { print(`Host ${domain} not found: 3(NXDOMAIN)`, 'err'); e.lastOut = ''; after(false); return; }
    const out = [];
    if (rec.A) rec.A.forEach(ip => out.push(`${domain} has address ${ip}`));
    if (rec.MX) rec.MX.forEach(m => out.push(`${domain} mail is handled by ${m}`));
    if (rec.CNAME) out.push(`${domain} is an alias for ${rec.CNAME}.`);
    out.forEach(l => print(l, 'out')); e.lastOut = out.join('\n'); after(true);
  },

  /* ---- HTTP ---- */
  curl: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join(' ');
    const url = a.find(x => !x.startsWith('-') && a[a.indexOf(x) - 1] !== '-o' && a[a.indexOf(x) - 1] !== '-X' && a[a.indexOf(x) - 1] !== '-H');
    if (!url) return fail('用法: curl [-I|-s] [-o 文件] [-X 方法] <URL>');
    const oi = a.indexOf('-o'); const outFile = oi >= 0 ? a[oi + 1] : null;
    const headOnly = a.includes('-I') || a.includes('--head');
    const resp = e.http[url] || e.http[url.replace(/\/$/, '')];
    if (!resp || !e.isUp(new URL(url).hostname)) {
      sfx('net-error'); print(`curl: (7) Failed to connect to ${new URL(url).hostname}: Connection refused`, 'err');
      e.lastOut = ''; after(false); return;
    }
    sfx('net-connect');
    if (headOnly) {
      const lines = [`HTTP/1.1 ${resp.status} OK`, `Content-Type: text/html; charset=UTF-8`, `Content-Length: ${resp.body.length}`, `Server: nginx`, ''];
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (outFile) {
      e.writeFile(outFile, resp.body);
      if (!flags.includes('-s')) print(`  % Total    % Received  Xferd  Average Speed\n100  ${resp.body.length}  100  ${resp.body.length}    0     0   2456      0 --:--:-- --:--:--  2456`, 'dim');
      print(`已保存到 ${outFile}`, 'ok'); e.lastOut = resp.body; after(true); return;
    }
    print(resp.body, 'out'); e.lastOut = resp.body; after(true);
  },

  wget: (a, e) => {
    const url = a.find(x => !x.startsWith('-'));
    if (!url) return fail('用法: wget <URL>');
    const resp = e.http[url] || e.http[url.replace(/\/$/, '')];
    if (!resp || !e.isUp(new URL(url).hostname)) {
      sfx('net-error'); print(`wget: unable to resolve host address: ${new URL(url).hostname}`, 'err');
      e.lastOut = ''; after(false); return;
    }
    const fname = url.split('/').pop() || 'index.html';
    sfx('ssh-transfer');
    print(`--2026-07-25 10:00:00--  ${url}`, 'dim');
    print(`Resolving ${new URL(url).hostname}... ${e.findHost(new URL(url).hostname)?.ip || 'ok'}`, 'dim');
    print(`Connecting... connected.`, 'dim');
    print(`HTTP request sent, awaiting response... ${resp.status} OK`, 'dim');
    print(`Length: ${resp.body.length} [text/html]`, 'dim');
    print(`Saving to: '${fname}'`, 'dim');
    e.writeFile(fname, resp.body);
    print(`'${fname}' saved [${resp.body.length}]`, 'ok');
    e.lastOut = fname; after(true);
  },

  /* ---- 端口 / 连接 ---- */
  nc: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    const rest = a.filter(x => !x.startsWith('-'));
    const [host, portStr] = rest;
    if (!host || !portStr) return fail('用法: nc -zv <主机> <端口>');
    const port = parseInt(portStr);
    const h = e.findHost(host);
    const open = h && h.up && h.ports[port];
    if (flags.includes('z')) {
      if (open) { sfx('net-connect'); print(`Connection to ${host} ${port} port [tcp/${h.ports[port]}] succeeded!`, 'ok'); e.lastOut = 'succeeded'; }
      else { sfx('net-error'); print(`nc: connect to ${host} port ${port} (tcp) failed: Connection refused`, 'err'); e.lastOut = 'refused'; }
      after(true); return;
    }
    if (open) { print(`Connected to ${host}:${port} (${h.ports[port]})`, 'ok'); e.lastOut = 'connected'; }
    else { print(`Connection refused`, 'err'); e.lastOut = 'refused'; }
    after(true);
  },

  telnet: (a, e) => {
    const [host, portStr] = a.filter(x => !x.startsWith('-'));
    if (!host) return fail('用法: telnet <主机> [端口]');
    const port = parseInt(portStr) || 23;
    const h = e.findHost(host);
    if (h && h.up && (h.ports[port] || port === 23)) {
      sfx('net-connect');
      print(`Trying ${h.ip}...`, 'dim');
      print(`Connected to ${host}.`, 'ok');
      print(`Escape character is '^]'.`, 'dim');
      e.lastOut = 'Connected';
    } else {
      sfx('net-error'); print(`Connection refused`, 'err'); e.lastOut = 'refused';
    }
    after(true);
  },

  ss: (a, e) => { printConns(e, a); },
  netstat: (a, e) => { printConns(e, a); },

  /* ---- 路由 / 网卡 ---- */
  ip: (a, e) => {
    const sub = a[0];
    if (sub === 'addr' || sub === 'address' || sub === 'a') {
      const lines = [];
      e.interfaces.forEach((it, i) => {
        lines.push(`${i + 1}: ${it.name}: <${it.state},LOOPBACK> mtu 1500`);
        lines.push(`    inet ${it.ip}/24 brd 255.255.255.255 scope global ${it.name}`);
        lines.push(`    link/ether ${it.mac}`);
      });
      lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true); return;
    }
    if (sub === 'route' || sub === 'r') {
      e.routes.forEach(l => print(l, 'out')); e.lastOut = e.routes.join('\n'); after(true); return;
    }
    print('用法: ip addr | ip route', 'info'); after(false);
  },

  ifconfig: (a, e) => {
    const lines = [];
    for (const it of e.interfaces) {
      lines.push(`${it.name}: flags=4163<UP,BROADCAST,RUNNING>  mtu 1500`);
      lines.push(`        inet ${it.ip}  netmask 255.255.255.0`);
      lines.push(`        ether ${it.mac}  txqueuelen 1000 (Ethernet)`);
      lines.push('');
    }
    lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
  },

  /* ---- SSH 密钥 ---- */
  'ssh-keygen': (a, e) => {
    const ti = a.indexOf('-t'); const type = ti >= 0 ? a[ti + 1] : 'rsa';
    const fi = a.indexOf('-f'); const file = fi >= 0 ? a[fi + 1] : '~/.ssh/id_' + type;
    e.mkdir('~/.ssh');
    const priv = `-----BEGIN ${type.toUpperCase()} PRIVATE KEY-----\nMIIE${btoaSafe('termquest-' + type)}\n-----END ${type.toUpperCase()} PRIVATE KEY-----\n`;
    const pub = `ssh-${type} AAAA${btoaSafe('termquest-pub-' + type)} user@termquest`;
    e.writeFile(file, priv, '-rw-------');
    e.writeFile(file + '.pub', pub);
    e.sshKeys = { pub, priv };
    sfx('file-create');
    print(`Generating public/private ${type} key pair.`, 'dim');
    print(`Your identification has been saved in ${file}`, 'ok');
    print(`Your public key has been saved in ${file}.pub`, 'ok');
    print(`The key fingerprint is:\nSHA256:${btoaSafe('fp').slice(0, 24)} user@termquest`, 'dim');
    e.lastOut = pub; after(true);
  },
};

function btoaSafe(s) {
  try { return btoa(s).replace(/=/g, ''); } catch { return s.split('').map(c => c.charCodeAt(0).toString(36)).join(''); }
}

function printConns(e, a) {
  const flags = a.filter(x => x.startsWith('-')).join('');
  const lines = ['Netid  State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port  Process'];
  for (const c of e.connections) {
    if (flags.includes('l') && c.state !== 'LISTEN') continue;
    if (flags.includes('t') && c.proto !== 'tcp') continue;
    const proc = flags.includes('p') ? `  users:(("${c.proc}",pid=${1000 + c.local.split(':').pop() % 999}))` : '';
    lines.push(`${c.proto}    ${c.state.padEnd(8)}0       0       ${c.local.padEnd(20)} ${c.foreign.padEnd(18)}${proc}`);
  }
  lines.forEach(l => print(l, 'out')); e.lastOut = lines.join('\n'); after(true);
}

function showNetHelp() {
  ['── 连通性 ──',
    '  ping [-c 次数] <主机> · traceroute <主机>',
    '── DNS ──',
    '  dig <域名> [A|MX|NS] [+short] · nslookup <域名> · host <域名>',
    '── HTTP ──',
    '  curl [-I] [-o 文件] <URL> · wget <URL>',
    '── 端口 / 连接 ──',
    '  nc -zv <主机> <端口> · telnet <主机> [端口]',
    '  ss [-tlnp] · netstat [-an]',
    '── 网络配置 ──',
    '  ip addr · ip route · ifconfig',
    '── SSH 密钥 ──',
    '  ssh-keygen -t rsa · cat ~/.ssh/id_rsa.pub',
    '── 其余 ──',
    '  ls · cat · echo · grep ... 等 Linux 命令照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
