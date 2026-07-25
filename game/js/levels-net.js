// 网络工具模块关卡 —— 连通性 / DNS / HTTP / 端口 / 路由 / SSH 密钥
// setup/check 操作 NetEngine（e）。
export const NET_LEVELS = [
  /* ============ 01 连通性探测 ============ */
  {
    stage: '01 连通性探测', id: 'N01', title: 'ping 通了吗', par: 2,
    desc: '先 <code>ping example.com</code> 确认网络可达，再用 <code>ping -c 3 mysite.local</code> 限定次数探测内网站点。',
    hints: ['ping example.com', 'ping -c 3 mysite.local'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('ping') && e.lastOut.includes('mysite.local') && e.lastOut.includes('packet loss'); },
    done: 'ping 用 ICMP 探测主机可达性，-c 限定次数避免刷屏。100% packet loss 说明主机宕机或网络不通。'
  },
  {
    stage: '01 连通性探测', id: 'N02', title: '谁掉线了', par: 2,
    desc: '监控报警：<code>down-server.local</code> 可能宕机了。用 <code>ping -c 2 down-server.local</code> 验证，再用 <code>traceroute down-server.local</code> 看断在哪一跳。',
    hints: ['ping -c 2 down-server.local', 'traceroute down-server.local'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('ping') && e.used.has('traceroute') && e.lastOut.includes('traceroute'); },
    done: 'ping 确认不通，traceroute 定位断点——网络排障的黄金搭档。100% 丢包 = 主机确实下线了。'
  },

  /* ============ 02 DNS 查询 ============ */
  {
    stage: '02 DNS 查询', id: 'N03', title: '域名背后的 IP', par: 2,
    desc: '用 <code>dig example.com</code> 查询 A 记录，再用 <code>dig example.com MX</code> 看它的邮件服务器记录。',
    hints: ['dig example.com', 'dig example.com MX'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('dig') && e.lastOut.includes('MX'); },
    done: 'dig 是 DNS 查询的瑞士军刀：A 记录解析 IP，MX 记录指向邮件服务器，NS 记录是权威域名服务器。'
  },
  {
    stage: '02 DNS 查询', id: 'N04', title: '快速解析', par: 3,
    desc: '用 <code>dig +short api.github.com</code> 只输出 IP，再用 <code>nslookup mysite.local</code> 和 <code>host db.internal</code> 交叉验证另外两个域名。',
    hints: ['dig +short api.github.com', 'nslookup mysite.local', 'host db.internal'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('dig') && e.used.has('nslookup') && e.used.has('host'); },
    done: 'dig +short 只给结果，适合脚本；nslookup 和 host 是老牌工具。三种方式互相印证，DNS 排查不慌。'
  },

  /* ============ 03 HTTP 请求 ============ */
  {
    stage: '03 HTTP 请求', id: 'N05', title: 'curl 抓网页', par: 2,
    desc: '用 <code>curl http://example.com</code> 获取首页内容，再用 <code>curl -I http://example.com</code> 只看响应头。',
    hints: ['curl http://example.com', 'curl -I http://example.com'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('curl') && e.lastOut.includes('HTTP/1.1'); },
    done: 'curl 是命令行 HTTP 客户端：默认输出响应体，-I 只看状态码和响应头——快速判断服务是否正常。'
  },
  {
    stage: '03 HTTP 请求', id: 'N06', title: '调用 API', par: 2,
    desc: '用 <code>curl https://api.github.com/users/octocat</code> 请求 JSON 接口，把结果用 <code>-o</code> 保存到 <code>user.json</code>，再 <code>cat user.json</code> 确认。',
    hints: ['curl https://api.github.com/users/octocat', 'curl -o user.json https://api.github.com/users/octocat', 'cat user.json'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('user.json'); return e.used.has('curl') && r.ok && r.content.includes('octocat'); },
    done: 'curl -o 把响应写入文件，配合 -X POST / -H 头部还能调复杂的 REST API——前后端联调必备。'
  },
  {
    stage: '03 HTTP 请求', id: 'N07', title: 'wget 下载', par: 2,
    desc: '用 <code>wget http://example.com/robots.txt</code> 下载文件，<code>ls</code> 确认文件落地，再 <code>cat robots.txt</code> 看内容。',
    hints: ['wget http://example.com/robots.txt', 'ls', 'cat robots.txt'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('wget') && e.exists('robots.txt'); },
    done: 'wget 专注下载：自动保存文件、显示进度。批量下载、断点续传（-c）是它的强项。'
  },

  /* ============ 04 端口与连接 ============ */
  {
    stage: '04 端口与连接', id: 'N08', title: '端口扫描', par: 3,
    desc: '内网 <code>mysite.local</code> 开了哪些服务？用 <code>nc -zv mysite.local 22</code>、<code>nc -zv mysite.local 80</code> 探测 SSH 和 Web 端口，再用 <code>nc -zv mysite.local 9999</code> 验证一个没开的端口。',
    hints: ['nc -zv mysite.local 22', 'nc -zv mysite.local 80', 'nc -zv mysite.local 9999'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('nc') && e.lastOut.includes('refused'); },
    done: 'nc -zv 快速探测端口：succeeded 说明服务在监听，refused 说明端口关闭。部署后先 nc 一下，心里有底。'
  },
  {
    stage: '04 端口与连接', id: 'N09', title: '本机连接全景', par: 3,
    desc: '用 <code>ss -tlnp</code> 查看本机监听中的端口和对应进程，再用 <code>netstat -an</code> 看全部连接（含 ESTABLISHED）。',
    hints: ['ss -tlnp', 'netstat -an'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('ss') && e.used.has('netstat') && e.lastOut.includes('ESTABLISHED'); },
    done: 'ss 是 netstat 的现代替代：-t TCP、-l 监听、-n 数字显示、-p 进程。排查"端口被谁占了"就靠它。'
  },

  /* ============ 05 综合实战 ============ */
  {
    stage: '05 综合实战', id: 'N10', title: 'SSH 密钥与全链路排障', par: 4,
    desc: '综合挑战：① <code>ssh-keygen -t rsa</code> 生成密钥对；② <code>cat ~/.ssh/id_rsa.pub</code> 查看公钥；③ <code>ip addr</code> 确认本机 IP；④ <code>curl http://mysite.local/health</code> 验证服务健康。',
    hints: ['ssh-keygen -t rsa', 'cat ~/.ssh/id_rsa.pub', 'ip addr', 'curl http://mysite.local/health'],
    setup(e) { e.reset(); },
    check(e) {
      return e.used.has('ssh-keygen') && e.sshKeys && e.used.has('ip') && e.used.has('curl') && e.lastOut.includes('OK');
    },
    done: '生成密钥 → 查公钥 → 确认网络 → 验证服务——一套完整的上线前自检流程。恭喜，网络工具模块全部通关！🎓'
  },
];
