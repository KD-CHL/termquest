// 网络工具命令集 —— 连通性 / DNS / HTTP / 端口 / 路由 / 抓包 / 扫描 / SSH 传输
// 网络类命令由本模块处理，其余委托 linuxExecute（操作同一个 NetEngine）。
// SSH 会话中则把命令路由到远程 LinuxEngine（e.remote）。
import { app } from './state.js';
import { print, printCmd } from './terminal.js';
import { sfx } from './effects.js';
import { tokenize } from './commands.js';
import { linuxExecute, runRemoteCmd } from './linux-commands.js';

function E() { return app.engine; }
function after(mutated) { if (app.afterCommand) app.afterCommand(mutated); }
function track(name) { app.cmdUsage[name] = (app.cmdUsage[name] || 0) + 1; }

const FREE = ['help', 'clear', 'ls', 'pwd', 'cat', 'whoami', 'hostname', 'uname', 'date', 'history', 'echo', 'wc', 'head', 'tail', 'env', 'arp', 'route', 'whois'];

export function netExecute(input) {
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
    const b = input.split(/\s/)[0];
    track(b); e.used.add(b);
    linuxExecute(input, e.remote);      // linuxExecute 自己会回显命令
    e.lastOut = e.remote.lastOut;        // 镜像远程输出供 check 使用
    return;
  }

  const base = input.split(/\s/)[0];
  if (base === 'help') { printCmd(input); showNetHelp(); return; }
  if (NET[base]) {
    printCmd(input);
    if (!FREE.includes(base)) { app.cmdCount++; if (app.updateCmdCount) app.updateCmdCount(); }
    track(base); e.used.add(base);
    const t = tokenize(input);
    try {
      NET[base](t.slice(1), e);
    } catch (err) {
      // 健壮性兜底：任何参数组合都不应抛异常
      print(`${base}: 参数解析出错（${err && err.message ? err.message : '未知错误'}）`, 'err');
      e.lastOut = ''; after(false);
    }
    return;
  }
  // 其余 → 本地 linux 命令
  linuxExecute(input);
}

function e_last() {}
function ok(msg, sfxName) { if (sfxName) sfx(sfxName); print(msg, 'ok'); e_last(); after(true); }
function fail(msg, sfxName = 'net-error') { sfx(sfxName); print(msg, 'err'); E().lastOut = ''; after(false); }

// 统一输出：逐行打印 + 记录 lastOut
function emit(e, lines, cls = 'out') { lines.forEach(l => print(l, cls)); e.lastOut = lines.join('\n'); }

// 安全解析 URL（非法 URL 返回 null，避免 new URL 抛异常）
function safeUrl(u) { try { return new URL(u); } catch { return null; } }

// 端口号 -> 服务名（netstat / nmap 用）
const PORT_NAMES = { 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3', 143: 'imap', 443: 'https', 465: 'smtps', 587: 'submission', 3306: 'mysql', 5432: 'postgresql', 6379: 'redis', 8080: 'http-proxy' };

const NET = {
  /* ================= 连通性 ================= */
  ping: (a, e) => {
    const v6 = a.includes('-6');
    let count = 4;
    const ci = a.indexOf('-c'); if (ci >= 0 && a[ci + 1]) count = parseInt(a[ci + 1]) || 4;
    const si = a.indexOf('-s'); const size = (si >= 0 && a[si + 1]) ? parseInt(a[si + 1]) || 56 : 56;
    // 记录带值选项的值下标，避免把值当成主机名
    const valIdx = new Set();
    ['-c', '-i', '-s', '-W', '-t', '-Q'].forEach(f => { const k = a.indexOf(f); if (k >= 0) valIdx.add(k + 1); });
    const host = a.find((x, i) => !x.startsWith('-') && !valIdx.has(i));
    if (!host) return fail('ping: 用法: ping [-4|-6] [-c 次数] [-i 间隔] [-s 大小] [-W 超时] <主机>');

    if (v6) {
      const ip6 = (host === 'localhost') ? '::1' : e.ipv6For(host);
      if (!ip6) { print(`ping: ${host}: Name or service not known`, 'err'); e.lastOut = ''; after(false); return; }
      const up = e.isUp(host) || host === 'localhost';
      const lines = [`PING ${host}(${ip6}) ${size} data bytes`];
      if (up) {
        for (let i = 0; i < count; i++) { const t = (Math.sin(i + 1) * 8 + 12).toFixed(1); lines.push(`64 bytes from ${ip6}: icmp_seq=${i + 1} ttl=57 time=${t} ms`); }
        lines.push('', `--- ${host} ping statistics ---`, `${count} packets transmitted, ${count} received, 0% packet loss`);
        sfx('net-connect');
      } else {
        for (let i = 0; i < count; i++) lines.push(`Request timeout for icmp_seq ${i}`);
        lines.push('', `--- ${host} ping statistics ---`, `${count} packets transmitted, 0 received, 100% packet loss`);
        sfx('net-error');
      }
      emit(e, lines); after(true); return;
    }

    const ip = host === 'localhost' ? '127.0.0.1' : (e.findHost(host)?.ip || e.resolveDns(host));
    if (!ip) { print(`ping: ${host}: Name or service not known`, 'err'); e.lastOut = ''; after(false); return; }
    const up = e.isUp(host);
    const replyBytes = size + 8;           // ICMP 回显 = 数据 + 8 字节头
    const lines = [`PING ${host} (${ip}) ${size}(${size + 28}) bytes of data.`];
    if (up) {
      for (let i = 0; i < count; i++) { const t = (Math.sin(i + 1) * 8 + 12).toFixed(1); lines.push(`${replyBytes} bytes from ${ip}: icmp_seq=${i + 1} ttl=57 time=${t} ms`); }
      lines.push('', `--- ${host} ping statistics ---`,
        `${count} packets transmitted, ${count} received, 0% packet loss, time ${count * 1000}ms`);
      sfx('net-connect');
    } else {
      for (let i = 0; i < count; i++) lines.push(`Request timeout for icmp_seq ${i}`);
      lines.push('', `--- ${host} ping statistics ---`,
        `${count} packets transmitted, 0 received, 100% packet loss, time ${count * 1000}ms`);
      sfx('net-error');
    }
    emit(e, lines); after(true);
  },

  // ping6 = ping -6
  ping6: (a, e) => NET.ping(a.includes('-6') ? a : [...a, '-6'], e),

  traceroute: (a, e) => {
    const numeric = a.includes('-n');
    const mi = a.indexOf('-m'); const maxHops = (mi >= 0 && a[mi + 1]) ? parseInt(a[mi + 1]) || 30 : 30;
    const valIdx = new Set();
    ['-m', '-w', '-q', '-p'].forEach(f => { const k = a.indexOf(f); if (k >= 0) valIdx.add(k + 1); });
    const host = a.find((x, i) => !x.startsWith('-') && !valIdx.has(i));
    if (!host) return fail('用法: traceroute [-n] [-m 最大跳数] [-w 等待秒] <主机>');
    const ip = e.findHost(host)?.ip || e.resolveDns(host);
    if (!ip) return fail(`traceroute: ${host}: Name or service not known`);
    const name = e.findHost(host)?.hostname || host;
    const lines = [`traceroute to ${host} (${ip}), ${maxHops} hops max, 60 byte packets`];
    const hops = [['192.168.1.1', 'gateway'], ['10.20.0.1', 'core-router'], [ip, name]];
    hops.forEach(([h, n], i) => {
      const label = numeric ? h : `${n} (${h})`;
      lines.push(` ${i + 1}  ${label}  ${((i + 1) * 3.7).toFixed(3)} ms  ${((i + 1) * 3.9).toFixed(3)} ms  ${((i + 1) * 3.8).toFixed(3)} ms`);
    });
    sfx('net-connect');
    emit(e, lines); after(true);
  },

  // mtr：ping + traceroute 合体（报告模式）
  mtr: (a, e) => {
    const valIdx = new Set();
    ['-c', '-s', '-i'].forEach(f => { const k = a.indexOf(f); if (k >= 0) valIdx.add(k + 1); });
    const host = a.find((x, i) => !x.startsWith('-') && !valIdx.has(i));
    if (!host) return fail('用法: mtr [-r] [-c 次数] <主机>');
    const ip = e.findHost(host)?.ip || e.resolveDns(host);
    if (!ip) return fail(`mtr: ${host}: Name or service not known`);
    const name = e.findHost(host)?.hostname || host;
    const hops = ['192.168.1.1', '10.20.0.1', ip];
    const lines = [`Start: 2026-07-25T10:00:00+0800`,
      `HOST: ${e.hostname}              Loss%   Snt   Last   Avg  Best  Wrst StDev`];
    hops.forEach((h, i) => {
      const label = i === 2 ? name : h;
      lines.push(`  ${i + 1}.|-- ${label.padEnd(20)} 0.0%    10 ${((i + 1) * 3.7).toFixed(1).padStart(6)} ${((i + 1) * 3.9).toFixed(1).padStart(5)} ${((i + 1) * 3.5).toFixed(1).padStart(5)} ${((i + 1) * 4.5).toFixed(1).padStart(5)}   0.${i + 3}`);
    });
    sfx('net-connect');
    emit(e, lines); after(true);
  },

  tracepath: (a, e) => {
    const host = a.find(x => !x.startsWith('-'));
    if (!host) return fail('用法: tracepath [-n] [-p 端口] <主机>');
    const ip = e.findHost(host)?.ip || e.resolveDns(host);
    if (!ip) return fail(`tracepath: ${host}: Name or service not known`);
    const name = e.findHost(host)?.hostname || host;
    const lines = [` 1?: [LOCALHOST]                      pmtu 1500`];
    const hops = [['192.168.1.1', false], ['10.20.0.1', false], [ip, true]];
    hops.forEach(([h, reached], i) => {
      const label = reached ? name : h;
      lines.push(` ${i + 1}:  ${label.padEnd(40)} ${((i + 1) * 3.7).toFixed(3)}ms ${reached ? 'reached' : ''}`.trimEnd());
    });
    lines.push(`     Resume: pmtu 1500 hops 3 back 3`);
    sfx('net-connect');
    emit(e, lines); after(true);
  },

  arping: (a, e) => {
    const ci = a.indexOf('-c'); const count = (ci >= 0 && a[ci + 1]) ? parseInt(a[ci + 1]) || 3 : 3;
    const Ii = a.indexOf('-I'); const iface = (Ii >= 0 && a[Ii + 1]) ? a[Ii + 1] : 'eth0';
    const valIdx = new Set();
    ['-c', '-I', '-w', '-s'].forEach(f => { const k = a.indexOf(f); if (k >= 0) valIdx.add(k + 1); });
    const ip = a.find((x, i) => !x.startsWith('-') && !valIdx.has(i));
    if (!ip) return fail('用法: arping [-I 网卡] [-c 次数] <IP地址>');
    const entry = (e.arp || []).find(n => n.ip === ip);
    const lines = [`ARPING ${ip} from ${e.localIp} ${iface}`];
    if (entry) {
      for (let i = 0; i < count; i++) lines.push(`Unicast reply from ${ip} [${entry.mac}]  0.${500 + i * 13}ms`);
      lines.push(`Sent ${count} probes (1 broadcast(s))`, `Received ${count} response(s)`);
      sfx('net-connect');
    } else {
      lines.push(`Sent ${count} probes (1 broadcast(s))`, `Received 0 response(s)`);
      sfx('net-error');
    }
    emit(e, lines); after(true);
  },

  /* ================= DNS ================= */
  dig: (a, e) => {
    const short = a.some(x => x.startsWith('+short'));
    const trace = a.some(x => x.startsWith('+trace'));
    const at = a.find(x => x.startsWith('@')); const server = at ? at.slice(1) : null;
    const pi = a.indexOf('-p'); const serverPort = (pi >= 0 && a[pi + 1]) ? a[pi + 1] : null;
    const serverLine = `;; SERVER: ${server || '8.8.8.8'}#${serverPort || 53}(${server || '8.8.8.8'})`;

    // -x <ip> 反向解析（PTR）
    const xi = a.indexOf('-x');
    if (xi >= 0) {
      const ip = a[xi + 1];
      if (!ip) return fail('用法: dig -x <IP地址> [+short]');
      const rev = ip.split('.').reverse().join('.') + '.in-addr.arpa.';
      const name = e.ptr ? e.ptr[ip] : null;
      if (!name) {
        if (short) { e.lastOut = ''; after(true); return; }
        emit(e, [`; <<>> DiG 9.18 <<>> -x ${ip}`, `;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 4242`, `;; ANSWER: 0`]);
        e.lastOut = 'NXDOMAIN'; after(true); return;
      }
      const ans = `${rev}  300  IN  PTR  ${name}.`;
      if (short) { print(`${name}.`, 'out'); e.lastOut = `${name}.`; after(true); return; }
      sfx('text-grep');
      emit(e, [`; <<>> DiG 9.18 <<>> -x ${ip}`, `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242`,
        `;; ANSWER SECTION:`, ans, `;; Query time: 12 msec`, serverLine]);
      e.lastOut = ans; after(true); return;
    }

    // -t 类型
    let qtype = null;
    const ti = a.indexOf('-t'); if (ti >= 0 && a[ti + 1]) qtype = a[ti + 1].toUpperCase();
    const TYPE = /^(A|AAAA|MX|NS|CNAME|TXT|SOA|PTR|ANY|SRV)$/;
    const positional = a.filter(x => !x.startsWith('+') && !x.startsWith('-') && !x.startsWith('@'));
    const domain = positional.find(x => !TYPE.test(x));
    if (!qtype) qtype = positional.find(x => TYPE.test(x)) || 'A';

    if (!domain) {
      // 无参数：打印版本与用法
      emit(e, [`; <<>> DiG 9.18 <<>>`, `;; 用法: dig [@server] <域名> [类型] [+short|+trace] [-x IP] [-t 类型] [-p 端口]`]);
      e.lastOut = 'DiG 9.18'; after(true); return;
    }

    const rec = e.dns[domain];
    // +trace：先打印从根服务器开始的迭代解析过程
    const traceLines = trace ? [
      `; <<>> DiG 9.18 <<>> +trace ${domain}`,
      `.                       518400  IN  NS  a.root-servers.net.`,
      `;; Received 1 from ${server || 'a.root-servers.net'}`,
      `${domain.endsWith('.com') ? 'com.' : 'local.'}                172800  IN  NS  ns1.${domain}.`,
      `;; Received 2 from ns1.${domain}`,
    ] : [];

    if (!rec) {
      if (short) { e.lastOut = ''; after(true); return; }
      emit(e, [...traceLines, `;; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 4242`, `;; ANSWER: 0`, serverLine]);
      e.lastOut = 'NXDOMAIN'; after(true); return;
    }
    const answers = [];
    const types = qtype === 'ANY' ? ['A', 'MX', 'NS', 'CNAME'] : [qtype];
    for (const t of types) {
      if (t === 'AAAA') { const v6 = e.ipv6For(domain); if (v6) answers.push(`${domain}.  300  IN  AAAA  ${v6}`); continue; }
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
    sfx('text-grep');
    emit(e, [...traceLines, `; <<>> DiG 9.18 <<>> ${domain} ${qtype}`,
      `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242`,
      `;; ANSWER SECTION:`, ...answers, `;; Query time: 12 msec`, serverLine]);
    e.lastOut = answers.join('\n'); after(true);
  },

  nslookup: (a, e) => {
    let qtype = 'A';
    const tflag = a.find(x => /^-(type|query)=/i.test(x) || /^type=/i.test(x));
    if (tflag) qtype = tflag.split('=').pop().toUpperCase();
    const rest = a.filter(x => !x.startsWith('-') && !/^type=/i.test(x));
    const domain = rest[0];
    if (rest[1] && /^(A|AAAA|MX|NS|CNAME|TXT)$/.test(rest[1])) qtype = rest[1].toUpperCase();
    const server = '8.8.8.8';
    if (!domain) {
      // 简化的交互模式
      emit(e, [`Server:  ${server}`, `Address: ${server}#53`, `> `,
        `(交互模式已简化：请直接用 nslookup <域名> [类型] 或 nslookup -type=MX <域名>)`]);
      e.lastOut = 'nslookup'; after(true); return;
    }
    const rec = e.dns[domain];
    const ip = e.resolveDns(domain);
    if (!rec && !ip) { print(`** server can't find ${domain}: NXDOMAIN`, 'err'); e.lastOut = ''; after(false); return; }
    const lines = [`Server:  ${server}`, `Address: ${server}#53`, ''];
    if (qtype === 'MX' && rec && rec.MX) lines.push(`${domain}  mail exchanger = ${rec.MX.join(', ')}`);
    else if (qtype === 'NS' && rec && rec.NS) lines.push(`${domain}  nameserver = ${rec.NS.join(', ')}`);
    else if (qtype === 'TXT' && rec && rec.TXT) lines.push(`${domain}  text = ${rec.TXT.join(' ')}`);
    else {
      if (!ip) { print(`** server can't find ${domain}: NXDOMAIN`, 'err'); e.lastOut = ''; after(false); return; }
      lines.push(`Name: ${domain}`, `Address: ${ip}`);
    }
    emit(e, lines); after(true);
  },

  host: (a, e) => {
    let qtype = null; const verbose = a.includes('-a');
    const ti = a.indexOf('-t'); if (ti >= 0 && a[ti + 1]) qtype = a[ti + 1].toUpperCase();
    const domain = a.find(x => !x.startsWith('-') && x !== qtype);
    if (!domain) return fail('用法: host [-a] [-t 类型] <域名>');
    const rec = e.dns[domain];
    if (!rec) { print(`Host ${domain} not found: 3(NXDOMAIN)`, 'err'); e.lastOut = ''; after(false); return; }
    if (verbose) {
      const lines = [`; <<>> DiG 9.18 <<>> ${domain}`, `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 4242`, `;; ANSWER SECTION:`];
      for (const t of ['A', 'MX', 'NS', 'CNAME']) if (rec[t]) rec[t].forEach(v => lines.push(`${domain}.  300  IN  ${t}  ${v}`));
      lines.push(`;; Query time: 12 msec`);
      sfx('text-grep');
      emit(e, lines); after(true); return;
    }
    const out = [];
    const want = qtype || 'ALL';
    if ((want === 'ALL' || want === 'A') && rec.A) rec.A.forEach(ip => out.push(`${domain} has address ${ip}`));
    if (want === 'ALL' || want === 'AAAA') { const v6 = e.ipv6For(domain); if (v6) out.push(`${domain} has IPv6 address ${v6}`); }
    if ((want === 'ALL' || want === 'MX') && rec.MX) rec.MX.forEach(m => out.push(`${domain} mail is handled by ${m}`));
    if ((want === 'ALL' || want === 'NS') && rec.NS) rec.NS.forEach(n => out.push(`${domain} name server ${n}`));
    if ((want === 'ALL' || want === 'CNAME') && rec.CNAME) out.push(`${domain} is an alias for ${rec.CNAME}.`);
    if (!out.length) out.push(`${domain} has no ${qtype} record`);
    sfx('text-grep');
    emit(e, out); after(true);
  },

  getent: (a, e) => {
    const db = a[0]; const key = a[1];
    if (!db) return fail('用法: getent <数据库> [键]  （数据库: hosts / ahosts / passwd / group / services）');
    if (db === 'hosts' || db === 'ahosts') {
      if (!key) { print(`getent: 用法: getent hosts <主机名>`, 'err'); e.lastOut = ''; after(false); return; }
      const ip = e.hosts[key] ? key : e.resolveDns(key);
      if (!ip) { e.lastOut = ''; after(false); return; }   // 真实 getent 对未知主机无输出
      const line = `${ip.padEnd(16)} ${key}`;
      print(line, 'out'); e.lastOut = line; after(true); return;
    }
    if (db === 'passwd') {
      const r = e.readFile('/etc/passwd');
      const lines = (r.ok ? r.content : '').split('\n').filter(Boolean).filter(l => !key || l.startsWith(key + ':'));
      if (!lines.length) { e.lastOut = ''; after(false); return; }
      emit(e, lines); after(true); return;
    }
    if (db === 'group') {
      const lines = [`root:x:0:`, `user:x:1000:`].filter(l => !key || l.startsWith(key + ':'));
      emit(e, lines); after(true); return;
    }
    if (db === 'services') {
      const lines = Object.entries(PORT_NAMES).map(([p, n]) => `${n.padEnd(14)} ${p}/tcp`);
      emit(e, lines); after(true); return;
    }
    print(`getent: 未知数据库: ${db}`, 'err'); e.lastOut = ''; after(false);
  },

  resolvectl: (a, e) => {
    const sub = a[0];
    if (!sub || sub === 'status') {
      emit(e, [
        `Global`,
        `       Protocols: +LLMNR +mDNS -DNSOverTLS DNSSEC=no`,
        `       Resolvers: ${e.dnsServers.join(' ')}`,
        `  Search Domains: ${e.searchDomains.join(' ')}`,
        ``,
        `Link 2 (eth0)`,
        `    Current DNS Server: ${e.dnsServers[0]}`,
        `         DNS Servers: ${e.dnsServers.join(' ')}`,
        `          DNS Domain: ${e.searchDomains[0]}`,
      ]); after(true); return;
    }
    if (sub === 'query' || sub === 'dns') {
      const domain = a[1];
      if (!domain) return fail('用法: resolvectl query <域名>');
      const ip = e.resolveDns(domain);
      if (!ip) { print(`${domain}: 无法解析: NXDOMAIN`, 'err'); e.lastOut = ''; after(false); return; }
      emit(e, [`${domain}: ${ip}`, ``, `-- Information acquired via protocol DNS in 4.2ms.`, `-- Data is authenticated: no`]);
      after(true); return;
    }
    // 第一个参数直接当域名查询
    const ip = e.resolveDns(sub);
    if (ip) { print(`${sub}: ${ip}`, 'out'); e.lastOut = `${sub}: ${ip}`; after(true); return; }
    print(`resolvectl: 用法: resolvectl [status | query <域名>]`, 'info'); e.lastOut = 'resolvectl'; after(true);
  },
  'systemd-resolve': (a, e) => NET.resolvectl(a, e),

  /* ================= HTTP ================= */
  curl: (a, e) => {
    const valFlags = ['-o', '-X', '-H', '-d', '--data', '--request', '--header', '-u', '--user',
      '-F', '--form', '-w', '--write-out', '--connect-timeout', '-A', '--user-agent'];
    let url = null;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x.startsWith('-')) { if (valFlags.includes(x)) i++; continue; }
      else { url = x; break; }
    }
    if (!url) return fail('用法: curl [-I|-s|-L|-k] [-o 文件|-O] [-X 方法] [-H 头部] [-d 数据] [-F 字段] [-u 用户:密码] [-A UA] [-w 格式] <URL>');
    const u = safeUrl(url);
    if (!u) { sfx('net-error'); print(`curl: (3) URL rejected: Malformed input to the URL function`, 'err'); e.lastOut = ''; after(false); return; }

    const oi = a.indexOf('-o'); const outFile = (oi >= 0 && a[oi + 1]) ? a[oi + 1] : null;
    const remoteName = a.includes('-O') || a.includes('--remote-name');
    const xi = a.indexOf('-X'); const method = (xi >= 0 && a[xi + 1]) ? a[xi + 1].toUpperCase() : null;
    const di = Math.max(a.indexOf('-d'), a.indexOf('--data'));
    const data = (di >= 0 && a[di + 1] !== undefined) ? a[di + 1] : null;
    const fi = Math.max(a.indexOf('-F'), a.indexOf('--form'));
    const form = (fi >= 0 && a[fi + 1] !== undefined) ? a[fi + 1] : null;
    const headers = []; a.forEach((x, i) => { if (x === '-H' && a[i + 1]) headers.push(a[i + 1]); });
    const ui = Math.max(a.indexOf('-u'), a.indexOf('--user'));
    const user = (ui >= 0 && a[ui + 1]) ? a[ui + 1] : null;
    const ai = Math.max(a.indexOf('-A'), a.indexOf('--user-agent'));
    const agent = (ai >= 0 && a[ai + 1]) ? a[ai + 1] : null;
    const wi = Math.max(a.indexOf('-w'), a.indexOf('--write-out'));
    const writeOut = (wi >= 0 && a[wi + 1] !== undefined) ? a[wi + 1] : null;
    const flags = a.filter(x => x.startsWith('-')).join(' ');
    const follow = a.includes('-L') || a.includes('--location');
    const headOnly = a.includes('-I') || a.includes('--head');
    const silent = a.includes('-s') || a.includes('--silent');
    const insecure = a.includes('-k') || a.includes('--insecure');

    let resp = e.http[url] || e.http[url.replace(/\/$/, '')];
    if (!resp || !e.isUp(u.hostname)) {
      sfx('net-error'); print(`curl: (7) Failed to connect to ${u.hostname} port ${u.port || (u.protocol === 'https:' ? 443 : 80)}: Connection refused`, 'err');
      e.lastOut = ''; after(false); return;
    }
    sfx('net-connect');

    // -L 跟随重定向
    const trail = [];
    if (follow) {
      let hops = 0;
      while (resp && resp.redirect && hops++ < 3) {
        const target = resp.redirect;
        trail.push(`* Issue another request to this URL: '${target}'`);
        const next = e.http[target] || e.http[target.replace(/\/$/, '')];
        if (!next) break;
        resp = next;
      }
    }

    const effMethod = method || ((data !== null || form !== null) ? 'POST' : 'GET');
    const reqLines = [];
    if (method || data !== null || form !== null || headers.length || user || agent) {
      reqLines.push(`> ${effMethod} ${u.pathname}${u.search} HTTP/1.1`);
      reqLines.push(`> Host: ${u.hostname}`);
      if (agent) reqLines.push(`> User-Agent: ${agent}`);
      headers.forEach(h => reqLines.push(`> ${h}`));
      if (user) reqLines.push(`> Authorization: Basic ${btoaSafe(user)}`);
      if (insecure) reqLines.push(`* SSL certificate verify disabled (-k)`);
      if (data !== null) { reqLines.push(`> Content-Length: ${String(data).length}`); reqLines.push(`* upload: ${data}`); }
      if (form !== null) { reqLines.push(`> Content-Type: multipart/form-data`); reqLines.push(`* form field: ${form}`); }
    }

    if (headOnly) {
      const lines = [...reqLines, ...trail, `HTTP/1.1 ${resp.status} OK`,
        `Content-Type: text/html; charset=UTF-8`, `Content-Length: ${resp.body.length}`, `Server: nginx`, ''];
      emit(e, lines); after(true); return;
    }

    const saveAs = outFile || (remoteName ? (u.pathname.split('/').pop() || 'index.html') : null);
    if (saveAs) {
      [...reqLines, ...trail].forEach(l => print(l, 'dim'));
      e.writeFile(saveAs, resp.body);
      if (!silent) print(`  % Total    % Received  Xferd  Average Speed\n100  ${resp.body.length}  100  ${resp.body.length}    0     0   2456      0 --:--:-- --:--:--  2456`, 'dim');
      print(`已保存到 ${saveAs}`, 'ok'); e.lastOut = resp.body; after(true); return;
    }

    const lines = [...reqLines, ...trail, resp.body];
    if (writeOut !== null) {
      const w = writeOut
        .replace(/%\{http_code\}/g, String(resp.status))
        .replace(/%\{time_total\}/g, '0.012')
        .replace(/%\{size_download\}/g, String(resp.body.length))
        .replace(/%\{url_effective\}/g, url)
        .replace(/%\{content_type\}/g, 'text/html');
      lines.push(w);
    }
    emit(e, lines); after(true);
  },

  wget: (a, e) => {
    const oi = a.indexOf('-O'); const outFile = (oi >= 0 && a[oi + 1]) ? a[oi + 1] : null;
    const quiet = a.includes('-q') || a.includes('--quiet');
    const cont = a.includes('-c') || a.includes('--continue');
    const noCheck = a.includes('--no-check-certificate');
    const url = a.find(x => !x.startsWith('-') && x !== outFile);
    if (!url) return fail('用法: wget [-O 文件] [-q] [-c] [--no-check-certificate] <URL>');
    const u = safeUrl(url);
    if (!u) { sfx('net-error'); print(`wget: ${url}: 不支持的协议或地址格式错误`, 'err'); e.lastOut = ''; after(false); return; }
    const resp = e.http[url] || e.http[url.replace(/\/$/, '')];
    if (!resp || !e.isUp(u.hostname)) {
      sfx('net-error'); print(`wget: unable to resolve host address: ${u.hostname}`, 'err');
      e.lastOut = ''; after(false); return;
    }
    const fname = outFile || (url.split('/').pop() || 'index.html');
    sfx('ssh-transfer');
    if (!quiet) {
      print(`--2026-07-25 10:00:00--  ${url}`, 'dim');
      print(`Resolving ${u.hostname}... ${e.findHost(u.hostname)?.ip || 'ok'}`, 'dim');
      if (noCheck && u.protocol === 'https:') print(`WARNING: cannot verify ${u.hostname}'s certificate, issued by 'CN=TermQuest CA'.`, 'dim');
      print(`Connecting to ${u.hostname}|${e.findHost(u.hostname)?.ip || ''}|:${u.port || (u.protocol === 'https:' ? 443 : 80)}... connected.`, 'dim');
      if (cont) print(`Reusing existing connection to ${u.hostname}.`, 'dim');
      print(`HTTP request sent, awaiting response... ${resp.status} OK`, 'dim');
      print(`Length: ${resp.body.length} [text/html]`, 'dim');
      print(`Saving to: '${fname}'`, 'dim');
    }
    e.writeFile(fname, resp.body);
    if (!quiet) print(`'${fname}' saved [${resp.body.length}]`, 'ok');
    else print(`已保存到 ${fname}`, 'ok');
    e.lastOut = fname; after(true);
  },

  /* ================= 端口 / 连接 ================= */
  nc: (a, e) => {
    const flags = a.filter(x => x.startsWith('-')).join('');
    // 解析出位置参数（跳过 -w 的值）
    const positional = [];
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      if (x === '-w') { i++; continue; }
      if (x.startsWith('-')) continue;
      positional.push(x);
    }
    const proto = flags.includes('u') ? 'udp' : 'tcp';

    // 监听模式
    if (flags.includes('l')) {
      const port = positional.find(x => /^\d+$/.test(x));
      if (!port) return fail('用法: nc -l [-u] [-k] [-p 端口] <端口>');
      sfx('net-connect');
      const lines = [`listening on [any] ${port} ...`];
      if (flags.includes('k')) lines.push(`(keep-alive: 连接断开后持续监听)`);
      lines.push(`(${proto} 监听中，等待入站连接)`);
      emit(e, lines); e.lastOut = `listening ${port}`; after(true); return;
    }

    const [host, portStr] = positional;
    if (!host || !portStr) return fail('用法: nc [-zvu] [-w 秒] <主机> <端口>');
    const port = parseInt(portStr);
    const h = e.findHost(host);
    const open = h && h.up && (h.ports[port] || (proto === 'udp' && h.up && [53, 67, 68, 123, 5353].includes(port)));
    const svc = (h && h.ports[port]) || PORT_NAMES[port] || proto;

    if (flags.includes('z')) {
      if (open) { sfx('net-connect'); print(`Connection to ${host} ${port} port [${proto}/${svc}] succeeded!`, 'ok'); e.lastOut = 'succeeded'; }
      else { sfx('net-error'); print(`nc: connect to ${host} port ${port} (${proto}) failed: Connection refused`, 'err'); e.lastOut = 'refused'; }
      after(true); return;
    }
    if (open) { print(`Connected to ${host}:${port} (${svc})`, 'ok'); e.lastOut = 'connected'; }
    else { print(`Connection refused`, 'err'); e.lastOut = 'refused'; }
    after(true);
  },

  telnet: (a, e) => {
    const positional = a.filter(x => !x.startsWith('-'));
    const [host, portStr] = positional;
    if (!host) return fail('用法: telnet <主机> [端口]');
    const port = parseInt(portStr) || 23;
    const h = e.findHost(host);
    if (!h) { sfx('net-error'); print(`telnet: could not resolve ${host}: Name or service not known`, 'err'); e.lastOut = ''; after(false); return; }
    print(`Trying ${h.ip}...`, 'dim');
    if (h.up && (h.ports[port] || port === 23)) {
      sfx('net-connect');
      const lines = [`Connected to ${host}.`, `Escape character is '^]'.`];
      if (h.ports[port]) lines.push(`${h.ports[port].toUpperCase()} banner: Welcome to ${host} ${port}/${h.ports[port]}`);
      emit(e, lines); e.lastOut = 'Connected'; after(true); return;
    }
    sfx('net-error'); print(`telnet: Unable to connect to remote host: Connection refused`, 'err'); e.lastOut = 'refused'; after(true);
  },

  ss: (a, e) => {
    if (a.includes('-s') || a.includes('--summary')) { printSocketSummary(e); return; }
    printConns(e, a);
  },

  netstat: (a, e) => { runNetstat(a, e); },

  nmap: (a, e) => {
    const udp = a.includes('-sU');
    const pi = a.indexOf('-p'); const portSpec = (pi >= 0 && a[pi + 1]) ? a[pi + 1] : null;
    const valIdx = new Set(); if (pi >= 0) valIdx.add(pi + 1);
    const host = a.find((x, i) => !x.startsWith('-') && !valIdx.has(i));
    if (!host) return fail('用法: nmap [-sT|-sU] [-p 端口[,端口...]] <主机>');
    const h = e.findHost(host);
    if (!h) {
      emit(e, [`Starting Nmap 7.94 ( https://nmap.org )`, `Nmap done: 0 IP addresses (0 hosts up) scanned in 0.05 seconds`]);
      print(`Failed to resolve "${host}".`, 'err'); e.lastOut = 'Failed to resolve'; after(false); return;
    }
    const proto = udp ? 'udp' : 'tcp';
    let ports;
    if (portSpec) {
      ports = [];
      for (const part of portSpec.split(',')) {
        if (part.includes('-')) { const [s, en] = part.split('-').map(n => parseInt(n)); for (let p = s; p <= en && p <= s + 100; p++) ports.push(p); }
        else ports.push(parseInt(part));
      }
    } else {
      ports = [21, 22, 23, 25, 53, 80, 110, 143, 443, 3306, 5432, 8080];
    }
    const lines = [`Starting Nmap 7.94 ( https://nmap.org )`,
      `Nmap scan report for ${h.hostname || host} (${h.ip})`,
      `Host is up (0.00042s latency).`];
    const openRows = [];
    for (const p of ports) {
      const svc = h.ports[p] || PORT_NAMES[p] || 'unknown';
      if (h.up && h.ports[p]) openRows.push([`${p}/${proto}`, 'open', svc]);
      else if (h.up && udp) openRows.push([`${p}/${proto}`, 'open|filtered', svc]);
    }
    const closed = Math.max(0, ports.length - openRows.length);
    if (!udp) lines.push(`Not shown: ${closed} closed ${proto} ports`);
    lines.push(`PORT      STATE         SERVICE`);
    for (const [pp, st, sv] of openRows) lines.push(`${pp.padEnd(10)}${st.padEnd(14)}${sv}`);
    if (!openRows.length) lines.push(`All ${ports.length} scanned ports on ${h.hostname || host} (${h.ip}) are ${udp ? 'open|filtered' : 'closed'}`);
    lines.push(``, `Nmap done: 1 IP address (1 host up) scanned in 1.32 seconds`);
    sfx('text-grep');
    emit(e, lines); after(true);
  },

  tcpdump: (a, e) => {
    const ci = a.indexOf('-c'); const count = (ci >= 0 && a[ci + 1]) ? parseInt(a[ci + 1]) || 5 : 5;
    const Ii = a.indexOf('-i'); const iface = (Ii >= 0 && a[Ii + 1]) ? a[Ii + 1] : 'eth0';
    // 由活动连接 + arp 生成若干抓包样本
    const samples = [];
    let seq = 0;
    const ts = () => { seq++; return `10:00:0${Math.min(9, seq)}.${String(100000 + seq * 13579).slice(0, 6)}`; };
    for (const c of e.connections) {
      const [lip, lport] = c.local.split(':');
      if (c.proto === 'tcp') {
        const [fip, fport] = c.foreign.split(':');
        samples.push(`${ts()} IP ${lip}.${lport} > ${fip}.${fport}: Flags [P.], seq 1:120, ack 1, win 501, length 119`);
      } else {
        samples.push(`${ts()} IP ${lip}.${lport} > 224.0.0.251.5353: UDP, length 120`);
      }
    }
    for (const n of (e.arp || [])) samples.push(`${ts()} ARP, Request who-has ${n.ip} tell ${e.localIp}, length 28`);
    const shown = samples.slice(0, Math.max(1, count));
    const lines = [`tcpdump: verbose output suppressed, use -v[v]... for full protocol decode`,
      `listening on ${iface}, link-type EN10MB (Ethernet), snapshot length 262144 bytes`,
      ...shown,
      `${shown.length} packets captured`,
      `${shown.length + 2} packets received by filter`,
      `0 packets dropped by kernel`];
    sfx('net-connect');
    emit(e, lines); after(true);
  },

  openssl: (a, e) => {
    if (a[0] !== 's_client') {
      print(`openssl: 支持的子命令: s_client -connect <主机:端口>`, 'info'); e.lastOut = 'openssl'; after(true); return;
    }
    const ci = a.indexOf('-connect'); const target = (ci >= 0 && a[ci + 1]) ? a[ci + 1] : null;
    if (!target) return fail('用法: openssl s_client -connect <主机:端口>');
    const [host, portStr] = target.split(':'); const port = parseInt(portStr) || 443;
    const h = e.findHost(host);
    if (!h || !h.up) {
      sfx('net-error');
      emit(e, [`CONNECTED(00000003)`, `connect:errno=111`, `无法连接到 ${host}:${port} (Connection refused)`], 'err');
      e.lastOut = ''; after(false); return;
    }
    const cn = h.hostname || host;
    sfx('ssh-handshake');
    emit(e, [
      `CONNECTED(00000003)`,
      `depth=1 C = US, O = Let's Encrypt, CN = R3`,
      `verify return:1`,
      `depth=0 CN = ${cn}`,
      `verify return:1`,
      `---`,
      `Certificate chain`,
      ` 0 s:CN = ${cn}`,
      `   i:C = US, O = Let's Encrypt, CN = R3`,
      `---`,
      `Server certificate`,
      `-----BEGIN CERTIFICATE-----`,
      `MIIB${btoaSafe('termquest-cert-' + cn).slice(0, 40)} (simulated)`,
      `-----END CERTIFICATE-----`,
      `subject=CN = ${cn}`,
      `issuer=C = US, O = Let's Encrypt, CN = R3`,
      `---`,
      `New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384`,
      `Server public key is 2048 bit`,
      `SSL handshake has read 1543 bytes and written 387 bytes`,
      `Verification: OK`,
    ]); after(true);
  },

  /* ================= 路由 / 网卡 ================= */
  ip: (a, e) => {
    const brief = a.some(x => x === '-brief' || x === '-br' || x === '-b' || x === 'brief');
    const sub = a.find(x => !x.startsWith('-') && x !== 'brief');
    if (sub === 'addr' || sub === 'address' || sub === 'a' || (!sub && brief)) {
      if (brief) {
        const lines = e.interfaces.map(it => `${it.name.padEnd(16)} ${it.state.padEnd(14)} ${it.ip ? it.ip + '/24' : ''}`.trimEnd());
        emit(e, lines); after(true); return;
      }
      const lines = [];
      e.interfaces.forEach((it, i) => {
        const lo = it.name === 'lo';
        const flags = lo ? 'LOOPBACK,UP,LOWER_UP' : (it.state === 'UP' ? 'BROADCAST,MULTICAST,UP,LOWER_UP' : 'BROADCAST,MULTICAST');
        lines.push(`${i + 1}: ${it.name}: <${flags}> mtu ${lo ? 65536 : 1500} qdisc ${lo ? 'noqueue' : 'fq_codel'} state ${it.state} group default qlen 1000`);
        lines.push(`    link/${lo ? 'loopback' : 'ether'} ${it.mac} brd ${lo ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}`);
        if (it.ip) lines.push(`    inet ${it.ip}/${lo ? '8' : '24'} brd ${lo ? '127.255.255.255' : '255.255.255.255'} scope ${lo ? 'host' : 'global'} ${it.name}`);
      });
      emit(e, lines); after(true); return;
    }
    if (sub === 'route' || sub === 'r') { emit(e, e.routes); after(true); return; }
    if (sub === 'neigh' || sub === 'neighbor' || sub === 'n') {
      const lines = (e.arp || []).map(n => `${n.ip} dev ${n.iface} lladdr ${n.mac} STALE`);
      emit(e, lines); after(true); return;
    }
    if (sub === 'link' || sub === 'l') {
      if (brief) {
        const lines = e.interfaces.map(it => `${it.name.padEnd(16)} ${it.state.padEnd(10)} ${it.mac}`);
        emit(e, lines); after(true); return;
      }
      const lines = [];
      e.interfaces.forEach((it, i) => {
        const lo = it.name === 'lo';
        lines.push(`${i + 1}: ${it.name}: <${lo ? 'LOOPBACK' : 'BROADCAST,MULTICAST'},${it.state},LOWER_UP> mtu ${lo ? 65536 : 1500} qdisc ${lo ? 'noqueue' : 'fq_codel'} state ${lo ? 'UNKNOWN' : 'UP'} mode DEFAULT`);
        lines.push(`    link/${lo ? 'loopback' : 'ether'} ${it.mac} brd ${lo ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}`);
      });
      emit(e, lines); after(true); return;
    }
    print('用法: ip [-brief] addr | ip route | ip neigh | ip link', 'info'); after(false);
  },

  ifconfig: (a, e) => {
    const all = a.includes('-a');
    const lines = [];
    for (const it of e.interfaces) {
      if (!all && it.state === 'DOWN') continue;   // 默认隐藏 DOWN 接口，-a 显示全部
      const lo = it.name === 'lo';
      lines.push(`${it.name}: flags=4163<UP,BROADCAST,RUNNING${lo ? ',LOOPBACK' : ''}>  mtu ${lo ? 65536 : 1500}`);
      lines.push(`        inet ${it.ip}  netmask ${lo ? '255.0.0.0' : '255.255.255.0'}`);
      lines.push(`        ether ${it.mac}  txqueuelen 1000 (${lo ? 'Local Loopback' : 'Ethernet'})`);
      lines.push('');
    }
    emit(e, lines); after(true);
  },

  arp: (a, e) => {
    const numeric = a.includes('-n');
    const bsd = a.includes('-a');
    if (bsd) {
      const lines = (e.arp || []).map(n => {
        const name = !numeric && e.hosts[n.ip] ? e.hosts[n.ip].hostname : '?';
        return `${name} (${n.ip}) at ${n.mac} [ether] on ${n.iface}`;
      });
      emit(e, lines); after(true); return;
    }
    const lines = ['Address                  HWtype  HWaddress           Flags Mask            Iface'];
    for (const n of e.arp || []) {
      const name = !numeric && e.hosts[n.ip] ? e.hosts[n.ip].hostname : n.ip;
      lines.push(`${name.padEnd(24)} ether   ${n.mac}   C                     ${n.iface}`);
    }
    emit(e, lines); after(true);
  },

  route: (a, e) => {
    const numeric = a.includes('-n');
    const rows = [];
    for (const r of e.routes) {
      const m = r.match(/^(\S+)(?:\s+via\s+(\S+))?\s+dev\s+(\S+)/);
      if (!m) continue;
      const [, dest, gw, iface] = m;
      let destOut, genmask;
      if (dest === 'default') { destOut = '0.0.0.0'; genmask = '0.0.0.0'; }
      else {
        const [net, bits] = dest.split('/');
        destOut = net; genmask = prefixToMask(parseInt(bits) || 24);
      }
      rows.push({
        dest: numeric || destOut !== '0.0.0.0' ? destOut : 'default',
        gw: gw ? (numeric ? gw : (e.hosts[gw]?.hostname || gw)) : '0.0.0.0',
        genmask, flags: gw ? 'UG' : 'U', iface,
      });
    }
    const lines = ['Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags Metric Ref    Use Iface'];
    for (const r of rows) {
      lines.push(`${r.dest.padEnd(16)}${r.gw.padEnd(16)}${r.genmask.padEnd(16)}${r.flags.padEnd(6)}100    0        0 ${r.iface}`);
    }
    emit(e, lines); after(true);
  },

  ethtool: (a, e) => {
    const iface = a.find(x => !x.startsWith('-')) || 'eth0';
    const it = e.interfaces.find(x => x.name === iface);
    if (!it) { sfx('net-error'); print(`Cannot get device information: No such device`, 'err'); e.lastOut = ''; after(false); return; }
    const lo = it.name === 'lo';
    const lines = lo
      ? [`Settings for ${it.name}:`, `\tCannot get device settings: Operation not supported`]
      : [`Settings for ${it.name}:`,
        `\tSupported ports: [ TP ]`,
        `\tSupported link modes:   10baseT/Half 10baseT/Full `,
        `\t                        100baseT/Half 100baseT/Full `,
        `\t                        1000baseT/Full `,
        `\tSupports auto-negotiation: Yes`,
        `\tSpeed: 1000Mb/s`,
        `\tDuplex: Full`,
        `\tPort: Twisted Pair`,
        `\tPHYAD: 0`,
        `\tAuto-negotiation: on`,
        `\tLink detected: ${it.state === 'UP' ? 'yes' : 'no'}`];
    emit(e, lines); after(true);
  },

  iwconfig: (a, e) => {
    const target = a.find(x => !x.startsWith('-'));
    const ifaces = target ? e.interfaces.filter(it => it.name === target) : e.interfaces;
    if (target && !ifaces.length) { print(`${target}  No such device`, 'err'); e.lastOut = ''; after(false); return; }
    const lines = [];
    for (const it of ifaces) {
      if (it.wireless) {
        lines.push(`${it.name.padEnd(10)}IEEE 802.11  ESSID:"${it.essid || 'off/any'}"  `);
        lines.push(`          Mode:Managed  Frequency:2.437 GHz  Access Point: ${it.mac}   `);
        lines.push(`          Bit Rate=54 Mb/s   Tx-Power=20 dBm   `);
        lines.push(`          Link Quality=${it.state === 'UP' ? '70' : '0'}/70  Signal level=${it.state === 'UP' ? '-40' : '-95'} dBm  `);
        lines.push('');
      } else {
        lines.push(`${it.name.padEnd(10)}no wireless extensions.`);
        lines.push('');
      }
    }
    emit(e, lines); after(true);
  },

  hostname: (a, e) => {
    if (a.includes('-I') || a.includes('--all-ip-addresses')) {
      const line = e.interfaces.filter(it => it.name !== 'lo').map(it => it.ip).filter(Boolean).join(' ');
      print(line, 'out'); e.lastOut = line; after(true); return;
    }
    if (a.includes('-f') || a.includes('--fqdn') || a.includes('--long')) {
      const line = `${e.hostname}.${e.domain}`;
      print(line, 'out'); e.lastOut = line; after(true); return;
    }
    if (a.includes('-d') || a.includes('--domain')) { print(e.domain, 'out'); e.lastOut = e.domain; after(true); return; }
    if (a.includes('-i') || a.includes('--ip-address')) { print(e.localIp, 'out'); e.lastOut = e.localIp; after(true); return; }
    print(e.hostname, 'out'); e.lastOut = e.hostname; after(true);
  },

  lsof: (a, e) => {
    const inet = a.some(x => x === '-i' || x === '-i4' || x === '-i6' || x === '-iTCP' || x === '-iUDP' || x.startsWith('-i:'));
    if (!inet) { print(`用法: lsof -i[:端口]   （列出网络连接；本模块聚焦网络文件）`, 'info'); e.lastOut = 'lsof'; after(true); return; }
    const iflag = a.find(x => x.startsWith('-i:'));
    const portFilter = iflag ? parseInt(iflag.slice(3)) : null;
    const lines = [`COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME`];
    e.connections.forEach((c, idx) => {
      const [lip, lport] = c.local.split(':');
      const [fip, fport] = c.foreign.split(':');
      if (portFilter && parseInt(lport) !== portFilter && parseInt(fport) !== portFilter) return;
      const pid = 1000 + (parseInt(lport) || idx) % 999;
      const type = c.proto === 'udp' ? 'UDP' : 'TCP';
      const name = (c.state === 'LISTEN' || c.foreign.endsWith(':*'))
        ? `${lip === '0.0.0.0' ? '*' : lip}:${lport} (LISTEN)`
        : `${lip}:${lport}->${fip}:${fport} (${c.state})`;
      lines.push(`${c.proc.padEnd(10)}${String(pid).padEnd(5)} user    3u  IPv4  ${11000 + idx}      0t0  ${type} ${name}`);
    });
    sfx('text-grep');
    emit(e, lines); after(true);
  },

  whois: (a, e) => {
    const domain = a.find(x => !x.startsWith('-'));
    if (!domain) return fail('用法: whois <域名>');
    const rec = e.dns[domain];
    if (!rec) {
      emit(e, [`No match for "${domain.toUpperCase()}".`, `>>> Last update of whois database: 2026-07-25T10:00:00Z <<<`]);
      e.lastOut = 'No match'; after(true); return;
    }
    let h = 0; for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const created = 1995 + (h % 24);
    const mon = `0${1 + (h % 9)}`, day = `1${h % 9}`;
    const ns = (rec.NS && rec.NS.length ? rec.NS : ['ns1.' + domain, 'ns2.' + domain]).map(n => n.toUpperCase());
    sfx('text-grep');
    emit(e, [
      `Domain Name: ${domain.toUpperCase()}`,
      `Registry Domain ID: D${1000000 + (h % 8999999)}-COM`,
      `Registrar WHOIS Server: whois.termquest-registry.example`,
      `Registrar: TermQuest Registry, Inc.`,
      `Registrar IANA ID: 9999`,
      `Domain Status: clientTransferProhibited https://icann.org/epp#clientTransferProhibited`,
      `Creation Date: ${created}-${mon}-${day}T04:00:00Z`,
      `Registry Expiry Date: ${created + 30}-${mon}-${day}T04:00:00Z`,
      `Updated Date: ${created + 29}-${mon}-${day}T08:12:00Z`,
      ...ns.map(n => `Name Server: ${n}`),
      `DNSSEC: ${rec.NS ? 'signedDelegation' : 'unsigned'}`,
      `>>> Last update of whois database: 2026-07-25T10:00:00Z <<<`,
    ]); after(true);
  },

  /* ================= SSH / 传输 ================= */
  ssh: (a, e) => {
    // 跳过 -p / -i / -l / -o 的值
    const skip = new Set();
    ['-p', '-i', '-l', '-o'].forEach(f => { const k = a.indexOf(f); if (k >= 0) skip.add(k + 1); });
    const pos = a.filter((x, i) => !x.startsWith('-') && !skip.has(i));
    const target = pos[0];
    if (!target) return fail('用法: ssh [-p 端口] <用户>@<主机> [命令]');
    let user = 'user', host = target;
    if (target.includes('@')) [user, host] = target.split('@');
    const h = e.findHost(host);
    if (!h) { sfx('net-error'); print(`ssh: Could not resolve hostname ${host}: Name or service not known`, 'err'); e.lastOut = ''; after(false); return; }
    if (!h.up) { sfx('net-error'); print(`ssh: connect to host ${host} port 22: No route to host`, 'err'); e.lastOut = ''; after(false); return; }
    if (!h.ports[22]) { sfx('net-error'); print(`ssh: connect to host ${host} port 22: Connection refused`, 'err'); e.lastOut = ''; after(false); return; }
    sfx('ssh-handshake');
    print(`Connecting to ${host} (${h.ip})...`, 'dim');
    const cmd = pos.slice(1).join(' ');
    if (cmd) {
      const res = runRemoteCmd(cmd, e.remote);
      res.out.forEach(l => print(l, 'out'));
      e.lastOut = res.out.join('\n');
      print(`Connection to ${host} closed.`, 'dim');
    } else {
      e.sshHost = `${user}@${host}`;
      print(`Welcome to ${host} (GNU/Linux)`, 'info');
      print(`Last login: Sat Jul 25 09:12:33 2026 from ${e.localIp}`, 'dim');
      print(`提示：已进入远程主机 ${host}，命令将在远程执行，输入 exit 断开`, 'info');
      e.lastOut = `Welcome to ${host}`;
    }
    after(true);
  },

  scp: (a, e) => {
    const recursive = a.includes('-r');
    const args = a.filter(x => !x.startsWith('-'));
    if (args.length < 2) return fail('用法: scp [-r] <本地文件> <用户>@<主机>:<远程路径>  （或反向）');
    const [src, dst] = args;
    sfx('ssh-transfer');
    if (dst.includes('@') && dst.includes(':')) {
      const [tgt, path] = dst.split(':');
      const host = tgt.split('@')[1];
      const h = e.findHost(host);
      if (!h || !h.up) { sfx('net-error'); print(`scp: ${host}: No route to host`, 'err'); e.lastOut = ''; after(false); return; }
      const remotePath = path || '/home/user/';
      if (recursive && e.isDir(src)) {
        const baseName = e.basename(e.resolvePath(src));
        const files = e.walk(src);
        const remoteBase = remotePath.replace(/\/$/, '');
        const mkdirp = p => { const segs = e.remote.resolvePath(p).split('/').filter(Boolean); let cur = ''; for (const s of segs) { cur += '/' + s; if (!e.remote.isDir(cur)) e.remote.mkdir(cur); } };
        let count = 0, total = 0;
        for (const rel of files) {
          const r = e.readFile(src + '/' + rel);
          if (r.ok) { const target = remoteBase + '/' + baseName + '/' + rel; mkdirp(e.remote.dirname(target)); e.remote.writeFile(target, r.content); count++; total += r.content.length; }
        }
        print(`${src}/  100%  ${total}B  ${count} 个文件  1.2MB/s  00:00`, 'out');
        print(`已传输到 ${host}:${remoteBase}/${baseName}/（${count} 个文件）`, 'ok');
        e.lastOut = remoteBase + '/' + baseName;
      } else {
        const r = e.readFile(src);
        if (r.err) { sfx('net-error'); print(`scp: ${src}: No such file or directory`, 'err'); e.lastOut = ''; after(false); return; }
        const finalPath = e.remote.isDir(remotePath) ? remotePath.replace(/\/$/, '') + '/' + e.basename(e.resolvePath(src)) : remotePath;
        e.remote.writeFile(finalPath, r.content);
        print(`${src}  100%  ${r.content.length}B  1.2MB/s  00:00`, 'out');
        print(`已传输到 ${host}:${finalPath}`, 'ok');
        e.lastOut = finalPath;
      }
    } else if (src.includes('@') && src.includes(':')) {
      const [tgt, path] = src.split(':');
      const host = tgt.split('@')[1];
      const h = e.findHost(host);
      if (!h || !h.up) { sfx('net-error'); print(`scp: ${host}: No route to host`, 'err'); e.lastOut = ''; after(false); return; }
      const r = e.remote.readFile(path);
      if (r.err) { sfx('net-error'); print(`scp: ${path}: No such file or directory`, 'err'); e.lastOut = ''; after(false); return; }
      const localPath = e.isDir(dst) ? dst.replace(/\/$/, '') + '/' + e.remote.basename(e.remote.resolvePath(path)) : dst;
      e.writeFile(localPath, r.content);
      print(`${path}  100%  ${r.content.length}B  1.2MB/s  00:00`, 'out');
      print(`已下载到 ${localPath}`, 'ok');
      e.lastOut = localPath;
    } else {
      print('scp: 需要指定 <用户>@<主机>:<路径> 形式的远程端', 'err'); sfx('net-error'); e.lastOut = ''; after(false); return;
    }
    after(true);
  },

  rsync: (a, e) => {
    const dryRun = a.includes('-n') || a.includes('--dry-run');
    const args = a.filter(x => !x.startsWith('-'));
    const [src, dst] = args;
    if (!src || !dst) return fail('用法: rsync [-avz] [-n] <源> <用户>@<主机>:<目标>');
    sfx('ssh-transfer');
    if (dst.includes('@') && dst.includes(':')) {
      const host = dst.split('@')[1].split(':')[0];
      const h = e.findHost(host);
      if (!h || !h.up) { sfx('net-error'); print(`rsync: 无法连接到 ${host}: No route to host`, 'err'); e.lastOut = ''; after(false); return; }
      const r = e.readFile(src);
      if (r.err) { sfx('net-error'); print(`rsync: link_stat "${src}" failed: No such file or directory`, 'err'); e.lastOut = ''; after(false); return; }
      const path = dst.split(':')[1] || '/home/user/';
      const finalPath = e.remote.isDir(path) ? path.replace(/\/$/, '') + '/' + e.basename(e.resolvePath(src)) : path;
      const baseName = e.basename(e.resolvePath(src));
      const lines = ['sending incremental file list', baseName, ''];
      if (dryRun) {
        lines.push(`sent ${r.content.length} bytes  received 35 bytes  (dry run)`);
        lines.push(`total size is ${r.content.length}  speedup is 1.00 (DRY RUN)`);
        emit(e, lines); e.lastOut = finalPath + ' (dry run)';
      } else {
        e.remote.writeFile(finalPath, r.content);
        lines.push(`sent ${r.content.length} bytes  received 35 bytes  ${(r.content.length / 1024 + 0.1).toFixed(2)} KB/sec`);
        lines.push(`total size is ${r.content.length}  speedup is 1.00`);
        emit(e, lines); e.lastOut = finalPath;
      }
    } else {
      print('rsync: 目标必须是 <用户>@<主机>:<路径> 形式', 'err'); sfx('net-error'); e.lastOut = ''; after(false); return;
    }
    after(true);
  },

  /* ================= SSH 密钥 ================= */
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

// CIDR 前缀长度 -> 点分十进制掩码（route -n 用）
function prefixToMask(bits) {
  const mask = bits <= 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return [(mask >>> 24) & 255, (mask >>> 16) & 255, (mask >>> 8) & 255, mask & 255].join('.');
}

// ss 连接表（保持原有 ss 风格输出）
function printConns(e, a) {
  const flags = a.filter(x => x.startsWith('-')).join('');
  const lines = ['Netid  State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port  Process'];
  for (const c of e.connections) {
    if (flags.includes('l') && c.state !== 'LISTEN') continue;
    if (flags.includes('t') && c.proto !== 'tcp') continue;
    if (flags.includes('u') && c.proto !== 'udp') continue;
    // -a：显示全部（默认即 LISTEN + 非 LISTEN，无需额外过滤）
    const proc = flags.includes('p') ? `  users:(("${c.proc}",pid=${1000 + c.local.split(':').pop() % 999}))` : '';
    lines.push(`${c.proto}    ${c.state.padEnd(8)}0       0       ${c.local.padEnd(20)} ${c.foreign.padEnd(18)}${proc}`);
  }
  emit(e, lines); after(true);
}

// ss -s 摘要
function printSocketSummary(e) {
  const tcp = e.connections.filter(c => c.proto === 'tcp');
  const udp = e.connections.filter(c => c.proto === 'udp');
  const estab = tcp.filter(c => c.state === 'ESTABLISHED').length;
  const tw = tcp.filter(c => c.state === 'TIME-WAIT').length;
  const pad = n => String(n).padEnd(10);
  emit(e, [
    `Total: ${e.connections.length}`,
    `TCP:   ${tcp.length} (estab ${estab}, closed 0, orphaned 0, timewait ${tw})`,
    `UDP:   ${udp.length}`,
    `Transport Total     IP        IPv6`,
    `RAW       0         0         0`,
    `UDP       ${pad(udp.length)}${pad(udp.length)}0`,
    `TCP       ${pad(tcp.length)}${pad(tcp.length)}0`,
    `INET      ${pad(e.connections.length)}${pad(e.connections.length)}0`,
  ]); after(true);
}

// netstat：-r 路由 / -i 接口 / -s 统计 / 其余为连接表
function runNetstat(a, e) {
  const flags = a.filter(x => x.startsWith('-')).join('');
  const showProc = flags.includes('p');

  if (flags.includes('r')) {
    const rows = [];
    for (const r of e.routes) {
      const m = r.match(/^(\S+)(?:\s+via\s+(\S+))?\s+dev\s+(\S+)/);
      if (!m) continue;
      const [, dest, gw, iface] = m;
      let destOut, genmask;
      if (dest === 'default') { destOut = '0.0.0.0'; genmask = '0.0.0.0'; }
      else { const [net, bits] = dest.split('/'); destOut = net; genmask = prefixToMask(parseInt(bits) || 24); }
      rows.push(`${destOut.padEnd(16)}${(gw || '0.0.0.0').padEnd(16)}${genmask.padEnd(16)}${(gw ? 'UG' : 'U').padEnd(8)}0     0          0 ${iface}`);
    }
    emit(e, ['Kernel IP routing table',
      'Destination     Gateway         Genmask         Flags   MSS Window  irtt Iface', ...rows]);
    after(true); return;
  }

  if (flags.includes('i')) {
    const lines = ['Kernel Interface table',
      'Iface      MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg'];
    e.interfaces.forEach((it, idx) => {
      const mtu = it.name === 'lo' ? 65536 : 1500;
      const rx = it.name === 'lo' ? 0 : 1234 + idx * 17;
      const flg = (it.name === 'lo' ? 'L' : 'B') + 'M' + (it.state === 'UP' ? 'RU' : '');
      lines.push(`${it.name.padEnd(9)}${String(mtu).padStart(6)} ${String(rx).padStart(7)}      0      0 0      ${String(rx).padStart(7)}      0      0      0 ${flg}`);
    });
    emit(e, lines); after(true); return;
  }

  if (flags.includes('s')) {
    const tcp = e.connections.filter(c => c.proto === 'tcp');
    const udp = e.connections.filter(c => c.proto === 'udp');
    const estab = tcp.filter(c => c.state === 'ESTABLISHED').length;
    const listen = tcp.filter(c => c.state === 'LISTEN').length;
    emit(e, [
      'Ip:', '    Forwarding: 2', '    2345 total packets received', '    0 forwarded',
      '    0 incoming packets discarded', '    2340 incoming packets delivered', '    2300 requests sent out', '',
      'Tcp:', `    ${listen} active connection openings`, `    ${estab} established connections`,
      '    0 failed connection attempts', '    0 connection resets received', '',
      'Udp:', `    ${udp.length} datagrams received`, '    0 datagrams to unknown port', '    0 datagrams received with errors', '',
      'UdpLite:', '',
    ]); after(true); return;
  }

  // 连接表
  const showAll = flags.includes('a');
  const listenOnly = flags.includes('l');
  const tcpOnly = flags.includes('t');
  const udpOnly = flags.includes('u');
  const numeric = flags.includes('n');
  const fmtAddr = ap => {
    const i = ap.lastIndexOf(':');
    if (i < 0) return ap;
    let ip = ap.slice(0, i), port = ap.slice(i + 1);
    if (!numeric) {
      if (PORT_NAMES[port]) port = PORT_NAMES[port];
      ip = ip === '0.0.0.0' ? '0.0.0.0' : (e.hosts[ip]?.hostname || ip);
    }
    return `${ip}:${port}`;
  };
  const lines = ['Active Internet connections (servers and established)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State       ' + (showProc ? 'PID/Program name' : '')];
  for (const c of e.connections) {
    if (tcpOnly && c.proto !== 'tcp') continue;
    if (udpOnly && c.proto !== 'udp') continue;
    const isListen = c.state === 'LISTEN' || (c.proto === 'udp' && c.state === 'UNCONN');
    if (listenOnly && !isListen) continue;
    if (!showAll && !listenOnly && isListen) continue;   // 默认隐藏监听
    const state = c.proto === 'udp' ? '' : c.state;
    const proc = showProc ? `${1000 + (parseInt(c.local.split(':').pop()) || 0) % 999}/${c.proc}` : '';
    lines.push(`${c.proto.padEnd(5)} 0      0      ${fmtAddr(c.local).padEnd(24)}${fmtAddr(c.foreign).padEnd(24)}${state.padEnd(12)}${proc}`);
  }
  emit(e, lines); after(true);
}

function showNetHelp() {
  ['── 连通性 ──',
    '  ping [-4|-6] [-c 次数] [-i 间隔] [-s 大小] [-W 超时] <主机> · ping6 <主机>',
    '  traceroute [-n] [-m 跳数] [-w 秒] <主机> · mtr [-r] <主机> · tracepath <主机> · arping <IP>',
    '── DNS ──',
    '  dig [@server] <域名> [类型] [+short|+trace] [-x IP] [-t 类型] [-p 端口]',
    '  nslookup <域名> [类型] · host [-a] [-t 类型] <域名> · getent hosts <域名>',
    '  resolvectl [status|query <域名>] · whois <域名>',
    '── HTTP ──',
    '  curl [-I|-s|-L|-k] [-o 文件|-O] [-X 方法] [-H 头] [-d 数据] [-F 字段] [-u 用户] [-A UA] [-w 格式] <URL>',
    '  wget [-O 文件] [-q] [-c] [--no-check-certificate] <URL>',
    '── 端口 / 连接 / 抓包 ──',
    '  nc [-zvu] [-l 端口] [-w 秒] <主机> <端口> · telnet <主机> [端口]',
    '  ss [-atlnp] · ss -s · netstat [-an|-tulnp|-r|-i|-s] · lsof -i[:端口]',
    '  nmap [-sT|-sU] [-p 端口] <主机> · tcpdump [-i 网卡] [-c 数量] · openssl s_client -connect 主机:端口',
    '── 网络配置 ──',
    '  ip [-brief] addr|route|neigh|link · ifconfig [-a] · arp [-n|-a] · route [-n]',
    '  ethtool <网卡> · iwconfig [网卡] · hostname [-I|-f|-i]',
    '── SSH / 传输 ──',
    '  ssh <用户>@<主机> [命令]  （会话中 exit 断开） · scp [-r] <文件> <用户>@<主机>:<路径>',
    '  rsync [-avz] [-n] <源> <用户>@<主机>:<目标> · ssh-keygen -t rsa',
    '── 其余 ──',
    '  ls · cat · echo · grep ... 等 Linux 命令照常可用 · clear 清屏',
  ].forEach(l => print(l, 'info'));
}
