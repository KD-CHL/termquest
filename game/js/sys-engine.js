// SysEngine —— 继承 LinuxEngine，叠加用户 / 服务 / 日志 / 磁盘 / 挂载 / 定时任务 / 内存
// 用于系统管理模块：useradd / systemctl / journalctl / df / du / mount / crontab / tar ...
import { LinuxEngine } from './linux-engine.js';

export class SysEngine extends LinuxEngine {
  reset() {
    super.reset();
    // 用户表
    this.users = [
      { name: 'root', uid: 0, group: 'root', shell: '/bin/bash', home: '/root', passwd: 'x' },
      { name: 'user', uid: 1000, group: 'user', shell: '/bin/bash', home: '/home/user', passwd: 'x' },
    ];
    this.nextUid = 1001;
    // 服务表：name -> { active, enabled, desc }
    this.services = {
      'nginx':  { active: true,  enabled: true,  desc: 'A high performance web server' },
      'sshd':   { active: true,  enabled: true,  desc: 'OpenSSH server daemon' },
      'mysql':  { active: false, enabled: false, desc: 'MySQL database server' },
      'redis':  { active: false, enabled: true,  desc: 'Redis key-value store' },
    };
    // systemd 日志：service -> [行]
    this.journal = {
      'nginx': ['Jul 25 09:00:01 termquest nginx[123]: Started worker process', 'Jul 25 09:15:22 termquest nginx[123]: ERROR upstream timed out (110)', 'Jul 25 09:20:00 termquest nginx[123]: client sent invalid request'],
      'mysql': ['Jul 25 08:00:00 termquest mysql[456]: InnoDB: Buffer pool(s) load completed', 'Jul 25 08:30:11 termquest mysql[456]: ERROR Too many connections', 'Jul 25 08:31:00 termquest mysql[456]: Aborted connection 42'],
      'redis': ['Jul 25 09:30:00 termquest redis[789]: Ready to accept connections'],
      'sshd':  ['Jul 25 07:12:33 termquest sshd[999]: Accepted password for user from 10.0.0.2'],
    };
    // 磁盘
    this.disks = [
      { fs: '/dev/sda1', size: '50G', used: '32G', avail: '18G', usePct: 64, mount: '/' },
      { fs: '/dev/sdb1', size: '200G', used: '180G', avail: '20G', usePct: 90, mount: '/data' },
    ];
    this.blockDevices = [
      { name: 'sda', size: '50G', type: 'disk', mount: '', fsType: '' },
      { name: 'sda1', size: '50G', type: 'part', mount: '/', fsType: 'ext4' },
      { name: 'sdb', size: '200G', type: 'disk', mount: '', fsType: '' },
      { name: 'sdb1', size: '200G', type: 'part', mount: '/data', fsType: 'ext4' },
    ];
    this.mounts = ['/dev/sda1 on / type ext4 (rw,relatime)', '/dev/sdb1 on /data type ext4 (rw)', 'tmpfs on /tmp type tmpfs (rw)'];
    // 定时任务
    this.cron = [];
    // 内存 (MB)
    this.mem = { total: 7800, used: 3200, free: 2400, cache: 2200 };
    // 归档：name -> { files: {path: content}, gz: bool }
    this.archives = {};
    this._seedSysFiles();
  }

  _seedSysFiles() {
    this.mkdir('/data');
    this.mkdir('/var/log');
    this.writeFile('/var/log/syslog', 'Jul 25 09:00:01 termquest CRON[1001]: (root) CMD (run-parts /etc/cron.hourly)\nJul 25 09:17:01 termquest systemd[1]: Started Daily apt upgrade.\n');
    this.writeFile('/home/user/report.txt', 'quarterly report\nrevenue: 120000\ncost: 80000\n');
    this.writeFile('/home/user/app.log', 'INFO boot\nERROR disk full\nINFO retry\n');
    this.mkdir('/home/user/project');
    this.writeFile('/home/user/project/main.py', 'print("hello")\n');
    this.writeFile('/home/user/project/README.md', '# project\n');
  }

  findUser(name) { return this.users.find(u => u.name === name); }
  findService(name) { return this.services[name]; }
}
