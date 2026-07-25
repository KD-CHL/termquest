// 系统管理模块关卡 —— 用户 / 服务 / 日志 / 磁盘 / 挂载 / 定时任务 / 压缩 / 性能
// setup/check 操作 SysEngine（e）。
export const SYS_LEVELS = [
  /* ============ 01 用户与权限 ============ */
  {
    stage: '01 用户与权限', id: 'S01', title: '创建新用户', par: 3,
    desc: '团队来了新同事。用 <code>useradd dev</code> 创建账号，<code>passwd dev</code> 设置密码，再 <code>id dev</code> 确认 uid。',
    hints: ['useradd dev', 'passwd dev', 'id dev'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('useradd') && e.used.has('passwd') && e.used.has('id') && !!e.findUser('dev'); },
    done: 'useradd 建账号、passwd 设密码、id 查 uid/gid——Linux 多用户管理的基本功。'
  },
  {
    stage: '01 用户与权限', id: 'S02', title: 'sudo 的力量', par: 2,
    desc: 'nginx 服务卡住了，需要 root 权限重启。先 <code>sudo systemctl restart nginx</code>，再 <code>systemctl status nginx</code> 确认它恢复运行。',
    hints: ['sudo systemctl restart nginx', 'systemctl status nginx'],
    setup(e) { e.reset(); e.services.nginx.active = false; },
    check(e) { return e.used.has('sudo') && e.used.has('systemctl') && e.services.nginx.active; },
    done: 'sudo 以 root 身份执行命令，是普通用户管理系统的"尚方宝剑"。用完记得确认服务状态。'
  },

  /* ============ 02 服务与日志 ============ */
  {
    stage: '02 服务与日志', id: 'S03', title: '启动数据库服务', par: 3,
    desc: 'MySQL 还没启动。用 <code>systemctl start mysql</code> 启动它，<code>systemctl enable mysql</code> 设为开机自启，最后 <code>systemctl list-units</code> 总览所有服务。',
    hints: ['systemctl start mysql', 'systemctl enable mysql', 'systemctl list-units'],
    setup(e) { e.reset(); },
    check(e) { return e.services.mysql.active && e.services.mysql.enabled && e.used.has('systemctl'); },
    done: 'start 启动、enable 开机自启——systemctl 是 systemd 时代的服务总管。'
  },
  {
    stage: '02 服务与日志', id: 'S04', title: 'journalctl 排障', par: 2,
    desc: 'MySQL 连接数爆了。用 <code>journalctl -u mysql</code> 查看它的日志，再用 <code>journalctl -u mysql -p err</code> 只看错误级别。',
    hints: ['journalctl -u mysql', 'journalctl -u mysql -p err'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('journalctl') && e.lastOut.includes('Too many connections'); },
    done: 'journalctl 是 systemd 的日志中心：-u 按服务过滤，-p err 只看错误——排障效率翻倍。'
  },

  /* ============ 03 磁盘与挂载 ============ */
  {
    stage: '03 磁盘与挂载', id: 'S05', title: '磁盘告急', par: 3,
    desc: '监控说磁盘快满了。用 <code>df</code> 看各分区使用率（找出 90% 的那个），再用 <code>du -sh /data</code> 和 <code>du -sh project</code> 定位大目录。',
    hints: ['df', 'du -sh /data', 'du -sh project'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('df') && e.used.has('du') && e.lastOut !== ''; },
    done: 'df 看分区整体使用率，du -sh 看单个目录占用——"磁盘满了"排查的标准两步。'
  },
  {
    stage: '03 磁盘与挂载', id: 'S06', title: '挂载新硬盘', par: 3,
    desc: '新硬盘 <code>/dev/sdc1</code> 已就绪。先 <code>lsblk</code> 查看块设备，<code>mkdir -p /mnt/backup</code> 建挂载点，再 <code>mount /dev/sdc1 /mnt/backup</code> 挂载。',
    hints: ['lsblk', 'mkdir -p /mnt/backup', 'mount /dev/sdc1 /mnt/backup'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('lsblk') && e.used.has('mount') && e.mounts.some(m => m.includes('/mnt/backup')); },
    done: 'Linux 里硬盘要先挂载到目录才能用：lsblk 看设备，mount 挂载，umount 卸载。'
  },

  /* ============ 04 备份与压缩 ============ */
  {
    stage: '04 备份与压缩', id: 'S07', title: 'tar 打包备份', par: 2,
    desc: '把 <code>project/</code> 目录打包压缩成 <code>project.tar.gz</code>：<code>tar -czf project.tar.gz project</code>，再 <code>tar -tf project.tar.gz</code> 检查包内容。',
    hints: ['tar -czf project.tar.gz project', 'tar -tf project.tar.gz'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('tar') && !!e.archives['project.tar.gz'] && e.lastOut.includes('main.py'); },
    done: 'tar -czf 打包+gzip 压缩，-tf 预览内容，-xzf 解压——备份三件套，运维必备。'
  },
  {
    stage: '04 备份与压缩', id: 'S08', title: '定时备份任务', par: 3,
    desc: '设置每天凌晨 2 点自动备份。用 <code>echo "0 2 * * * /usr/local/bin/backup.sh" > mycron</code> 写入 cron 表达式，<code>crontab mycron</code> 安装，<code>crontab -l</code> 确认。',
    hints: ['echo "0 2 * * * /usr/local/bin/backup.sh" > mycron', 'crontab mycron', 'crontab -l'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('crontab') && e.cron.some(c => c.includes('backup.sh')); },
    done: 'cron 表达式：分 时 日 月 周。"0 2 * * *" = 每天 2:00。crontab -l 随时检查你的定时任务。'
  },

  /* ============ 05 性能监控 ============ */
  {
    stage: '05 性能监控', id: 'S09', title: '系统体检', par: 3,
    desc: '给系统做个体检：<code>free</code> 看内存，<code>uptime</code> 看负载，<code>lsof</code> 看打开的网络连接。',
    hints: ['free', 'uptime', 'lsof'],
    setup(e) { e.reset(); },
    check(e) { return e.used.has('free') && e.used.has('uptime') && e.used.has('lsof'); },
    done: 'free 看内存、uptime 看负载、lsof 看文件/连接——系统性能排查的"望闻问切"。'
  },

  /* ============ 06 综合实战 ============ */
  {
    stage: '06 综合实战', id: 'S10', title: '上线前全套准备', par: 5,
    desc: '综合挑战：① <code>useradd deploy</code> 建部署账号；② <code>tar -czf release.tar.gz project</code> 打包；③ <code>systemctl restart nginx</code> 重启服务；④ <code>journalctl -u nginx -p err</code> 确认无错误；⑤ <code>df</code> 确认磁盘空间。',
    hints: ['useradd deploy', 'tar -czf release.tar.gz project', 'systemctl restart nginx', 'journalctl -u nginx -p err', 'df'],
    setup(e) { e.reset(); },
    check(e) {
      return e.used.has('useradd') && e.used.has('tar') && e.used.has('systemctl') &&
        e.used.has('journalctl') && e.used.has('df') && !!e.findUser('deploy') && e.services.nginx.active;
    },
    done: '建账号 → 打包 → 重启服务 → 查日志 → 看磁盘——一套完整的上线自检流程。恭喜，系统管理模块通关！🎓'
  },
];
