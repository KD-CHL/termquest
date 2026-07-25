// NetEngine —— 继承 LinuxEngine，叠加 DNS / 主机 / 端口 / 路由 / HTTP 内容
// 用于网络工具模块：ping / dig / curl / wget / nc / ss / traceroute / ssh-keygen ...
import { LinuxEngine } from './linux-engine.js';

export class NetEngine extends LinuxEngine {
  reset() {
    super.reset();
    // DNS 区域记录：域名 -> { A: [ip], MX: [...], NS: [...], CNAME: 目标 }
    this.dns = {
      'example.com':      { A: ['93.184.216.34'], MX: ['10 mail.example.com'], NS: ['ns1.example.com', 'ns2.example.com'] },
      'www.example.com':  { CNAME: 'example.com' },
      'api.github.com':   { A: ['140.82.112.6'] },
      'mysite.local':     { A: ['192.168.1.50'] },
      'db.internal':      { A: ['10.0.0.5'] },
      'down-server.local':{ A: ['192.168.1.99'] },   // 宕机主机（ping 不通）
    };
    // 反向解析（PTR）：ip -> 主机名（dig -x 用）
    this.ptr = {
      '93.184.216.34': 'example.com',
      '140.82.112.6':  'api.github.com',
      '192.168.1.50':  'mysite.local',
      '10.0.0.5':      'db.internal',
    };
    // 主机表：ip -> { hostname, up, ports: {端口: 服务名} }
    this.hosts = {
      '93.184.216.34':  { hostname: 'example.com', up: true, ports: { 80: 'http', 443: 'https' } },
      '140.82.112.6':   { hostname: 'api.github.com', up: true, ports: { 443: 'https', 22: 'ssh' } },
      '192.168.1.50':   { hostname: 'mysite.local', up: true, ports: { 22: 'ssh', 80: 'http', 3306: 'mysql' } },
      '10.0.0.5':       { hostname: 'db.internal', up: true, ports: { 5432: 'postgresql', 22: 'ssh' } },
      '192.168.1.99':   { hostname: 'down-server.local', up: false, ports: {} },
    };
    // 本机网卡（wlan0 处于 DOWN，用来体现 ifconfig -a / iwconfig 的差异）
    this.interfaces = [
      { name: 'lo', ip: '127.0.0.1', state: 'UP', mac: '00:00:00:00:00:00' },
      { name: 'eth0', ip: '192.168.1.10', state: 'UP', mac: '52:54:00:12:34:56' },
      { name: 'wlan0', ip: '192.168.1.20', state: 'DOWN', mac: '52:54:00:99:88:77', wireless: true, essid: 'TermQuest-WiFi' },
    ];
    this.localIp = '192.168.1.10';
    // 本机标识（hostname / hostname -f / hostname -I 用）
    this.hostname = 'net-host';
    this.domain = 'localdomain';
    // 解析器配置（resolvectl / systemd-resolve 用）
    this.dnsServers = ['8.8.8.8', '1.1.1.1'];
    this.searchDomains = ['localdomain'];
    // SSH 会话：sshHost = 'user@host' 表示已进入远程；remote 为远程 LinuxEngine
    this.sshHost = null;
    this.remote = new LinuxEngine();
    this._seedRemote();
    // 路由表
    this.routes = [
      'default via 192.168.1.1 dev eth0',
      '192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.10',
      '10.0.0.0/8 via 192.168.1.1 dev eth0',
    ];
    // ARP / 邻居缓存（arp / ip neigh 用）
    this.arp = [
      { ip: '192.168.1.1',  mac: '52:54:00:00:01:01', iface: 'eth0' },  // 网关 gateway
      { ip: '192.168.1.50', mac: '52:54:00:aa:bb:50', iface: 'eth0' },  // mysite.local
      { ip: '192.168.1.99', mac: '52:54:00:aa:bb:99', iface: 'eth0' },  // down-server.local
      { ip: '10.0.0.5',     mac: '52:54:00:cc:dd:05', iface: 'eth0' },  // db.internal
    ];
    // 活动连接（ss / netstat 用）
    this.connections = [
      { proto: 'tcp', local: '0.0.0.0:22', foreign: '0.0.0.0:*', state: 'LISTEN', proc: 'sshd' },
      { proto: 'tcp', local: '0.0.0.0:80', foreign: '0.0.0.0:*', state: 'LISTEN', proc: 'nginx' },
      { proto: 'tcp', local: '192.168.1.10:44123', foreign: '93.184.216.34:443', state: 'ESTABLISHED', proc: 'curl' },
      { proto: 'tcp', local: '192.168.1.10:51001', foreign: '10.0.0.5:5432', state: 'ESTABLISHED', proc: 'psql' },
      { proto: 'udp', local: '0.0.0.0:68', foreign: '0.0.0.0:*', state: 'UNCONN', proc: 'dhclient' },
      { proto: 'udp', local: '0.0.0.0:5353', foreign: '0.0.0.0:*', state: 'UNCONN', proc: 'avahi-daemon' },
    ];
    // HTTP 内容（curl / wget 用）：url -> { status, body }
    this.http = {
      'http://example.com': { status: 200, body: '<!doctype html>\n<html><head><title>Example Domain</title></head>\n<body><h1>Example Domain</h1><p>This domain is for use in illustrative examples.</p></body></html>' },
      'http://example.com/robots.txt': { status: 200, body: 'User-agent: *\nAllow: /' },
      'https://api.github.com/zen': { status: 200, body: 'Keep it logically awesome.' },
      'https://api.github.com/users/octocat': { status: 200, body: '{\n  "login": "octocat",\n  "id": 1,\n  "public_repos": 8,\n  "followers": 9000\n}' },
      'http://mysite.local/data.json': { status: 200, body: '{"status":"ok","users":42,"version":"1.2.3"}' },
      'http://mysite.local/health': { status: 200, body: 'OK' },
      'http://mysite.local/login': { status: 200, body: '{"login":"ok","user":"alice","token":"tq-8f3a2b"}' },
      'http://example.com/old': { status: 301, body: '<html><body><h1>301 Moved Permanently</h1></body></html>', redirect: 'http://example.com' },
    };
    this.sshKeys = null; // ssh-keygen 生成后 { pub, priv }
    this._seedNetFiles();
  }

  _seedNetFiles() {
    this.mkdir('/home/user/downloads');
    this.writeFile('/home/user/urls.txt', 'http://example.com\nhttps://api.github.com/zen\nhttp://mysite.local/data.json\n');
  }

  /* ---- 远程主机初始化（ssh / scp / rsync 练习用） ---- */
  _seedRemote() {
    const r = this.remote;
    r.writeFile('/etc/hostname', 'mysite.local\n');
    r.env.HOSTNAME = 'mysite.local';
    r.mkdir('/var/log');
    r.writeFile('/var/log/app.log', 'INFO boot ok\nERROR db connection lost\nINFO retry\nERROR timeout\n');
    r.writeFile('/home/user/welcome.txt', 'Welcome to mysite.local\n');
    r.writeFile('/home/user/status.txt', 'all systems operational\n');
    r.mkdir('/home/user/deploy');
    r.writeFile('/home/user/deploy/release.txt', 'v1.2.3\n');
  }

  /* ---- 为主机合成一个确定性的 IPv6 地址（ping6 / AAAA 用） ---- */
  ipv6For(name) {
    if (name === 'localhost' || name === '127.0.0.1') return '::1';
    const ip = this.findHost(name)?.ip || this.resolveDns(name);
    if (!ip) return null;
    const parts = ip.split('.').map(n => parseInt(n) || 0);
    return `2001:db8::${parts[2].toString(16)}${parts[3].toString(16)}`;
  }

  /* ---- DNS 解析：域名 -> ip（支持 CNAME 跳转） ---- */
  resolveDns(name) {
    let cur = name, hops = 0;
    while (cur && hops++ < 5) {
      const rec = this.dns[cur];
      if (!rec) return null;
      if (rec.A && rec.A.length) return rec.A[0];
      if (rec.CNAME) cur = rec.CNAME;
      else return null;
    }
    return null;
  }

  // 通过 ip 或主机名找到主机对象
  findHost(key) {
    if (this.hosts[key]) return { ip: key, ...this.hosts[key] };
    const ip = this.resolveDns(key);
    if (ip && this.hosts[ip]) return { ip, ...this.hosts[ip] };
    return null;
  }

  // 判断目标是否可达（本机 / 在线主机）
  isUp(key) {
    if (key === 'localhost' || key === '127.0.0.1' || key === this.localIp) return true;
    const h = this.findHost(key);
    return !!h && h.up;
  }
}
