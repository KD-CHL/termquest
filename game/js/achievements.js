// 成就徽章系统 —— 定义徽章、根据进度计算解锁、检测新解锁
// 成就是从进度数据（关卡星级 / 命令数 / 命令频次）实时推导的，
// app.unlockedAch 只记录"已经见过"的成就 id，用于判断哪些是新解锁（弹提示用）。
import { app } from './state.js';
import { ALL_LEVELS, getModules } from './modules.js';

// 某阶段是否全部通关
function stageCleared(ls, stageName) {
  return ALL_LEVELS.every((lv, i) => lv.stage !== stageName || ls[i] > 0);
}
// 某模块是否全部通关
function moduleCleared(ls, moduleId) {
  const m = getModules().find(x => x.id === moduleId);
  if (!m) return false;
  return ls.slice(m.offset, m.offset + m.levels.length).every(s => s > 0);
}
// 某阶段获得的星星数
function stageStars(ls, stageName) {
  return ALL_LEVELS.reduce((sum, lv, i) => (lv.stage === stageName ? sum + (ls[i] || 0) : sum), 0);
}

export const ACHIEVEMENTS = [
  {
    id: 'first-blood', icon: '🌱', title: '初出茅庐', desc: '通过第 1 关，完成第一次提交',
    check: c => c.levelStars[0] > 0,
  },
  {
    id: 'undo-adept', icon: '⏪', title: '撤销达人', desc: '通关「撤销」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '02 撤销'),
  },
  {
    id: 'brancher', icon: '🌿', title: '分支达人', desc: '通关「分支」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '03 分支'),
  },
  {
    id: 'conflict-slayer', icon: '⚔️', title: '冲突终结者', desc: '解决一次合并冲突',
    check: c => { const i = ALL_LEVELS.findIndex(l => l.title.includes('冲突')); return i >= 0 && c.levelStars[i] > 0; },
  },
  {
    id: 'three-star', icon: '🌟', title: '三星学霸', desc: '在任意一关拿到 3 星',
    check: c => c.levelStars.some(s => s === 3),
  },
  {
    id: 'halfway', icon: '⛰️', title: '半山腰', desc: '通关一半以上的关卡',
    check: c => c.levelStars.filter(s => s > 0).length >= Math.ceil(ALL_LEVELS.length / 2),
  },
  {
    id: 'all-clear', icon: '🏆', title: '全部通关', desc: `通关全部 ${ALL_LEVELS.length} 个关卡`,
    check: c => c.levelStars.length >= ALL_LEVELS.length && c.levelStars.slice(0, ALL_LEVELS.length).every(s => s > 0),
  },
  {
    id: 'perfectionist', icon: '💎', title: '完美主义者', desc: '所有关卡都拿到 3 星',
    check: c => c.levelStars.length >= ALL_LEVELS.length && c.levelStars.slice(0, ALL_LEVELS.length).every(s => s === 3),
  },
  {
    id: 'advanced', icon: '🧙', title: '高级玩家', desc: '通关「高级」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '06 高级'),
  },
  {
    id: 'keyboard-100', icon: '⌨️', title: '键盘侠', desc: '累计输入 100 条命令',
    check: c => c.totalCmds >= 100,
  },
  {
    id: 'cmd-master', icon: '🧑‍💻', title: '命令大师', desc: '累计输入 500 条命令',
    check: c => c.totalCmds >= 500,
  },
  {
    id: 'rebase-rider', icon: '🎢', title: '变基骑士', desc: '使用过 git rebase',
    check: c => (c.cmdUsage['git rebase'] || 0) > 0,
  },
  {
    id: 'reflog-rescuer', icon: '🕵️', title: 'reflog 救援队', desc: '用 git reflog 找回过提交',
    check: c => (c.cmdUsage['git reflog'] || 0) > 0,
  },
  {
    id: 'merge-master', icon: '🔀', title: '合并大师', desc: '累计使用 git merge 5 次',
    check: c => (c.cmdUsage['git merge'] || 0) >= 5,
  },
  {
    id: 'collector', icon: '⭐', title: '星星收藏家', desc: `累计获得 ${Math.ceil(ALL_LEVELS.length * 3 * 0.6)} 颗星星`,
    check: c => c.levelStars.reduce((a, b) => a + b, 0) >= Math.ceil(ALL_LEVELS.length * 3 * 0.6),
  },
  /* ── Linux 模块 ── */
  {
    id: 'pipe-plumber', icon: '🔧', title: '管道水管工', desc: '通关「管道与文本」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '02 管道与文本'),
  },
  {
    id: 'linux-master', icon: '🐧', title: 'Linux 大师', desc: '通关 Linux 基础模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'linux'),
  },
  /* ── Shell × Git 模块 ── */
  {
    id: 'script-kiddie', icon: '📜', title: '脚本小子', desc: '用 bash 运行过一个脚本',
    check: c => (c.cmdUsage['bash'] || 0) > 0,
  },
  {
    id: 'sed-surgeon', icon: '🔬', title: 'sed 外科医生', desc: '累计使用 sed 修改文本 3 次',
    check: c => (c.cmdUsage['sed'] || 0) >= 3,
  },
  /* ── Docker / SSH 模块 ── */
  {
    id: 'container-captain', icon: '🐳', title: '容器船长', desc: '通关「容器基础」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '01 容器基础'),
  },
  {
    id: 'compose-conductor', icon: '🎼', title: '编排指挥家', desc: '用 docker-compose 拉起多服务',
    check: c => (c.cmdUsage['docker-compose'] || 0) > 0,
  },
  {
    id: 'ssh-agent', icon: '🔐', title: 'SSH 特工', desc: '通过 SSH 登录远程主机',
    check: c => (c.cmdUsage['ssh'] || 0) > 0,
  },
  {
    id: 'cargo-shipper', icon: '📦', title: '货运司机', desc: '用 scp 或 rsync 传输过文件',
    check: c => (c.cmdUsage['scp'] || 0) > 0 || (c.cmdUsage['rsync'] || 0) > 0,
  },
  {
    id: 'ops-master', icon: '🛠️', title: '运维大师', desc: '通关 Docker 运维模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'ops'),
  },
  {
    id: 'polyglot', icon: '🧭', title: '跨界达人', desc: '在每个模块都至少通关 1 关',
    check: c => getModules().every(m => c.levelStars.slice(m.offset, m.offset + m.levels.length).some(s => s > 0)),
  },
  /* ── 网络工具模块 ── */
  {
    id: 'dns-detective', icon: '🔍', title: 'DNS 侦探', desc: '用 dig 查询过域名记录',
    check: c => (c.cmdUsage['dig'] || 0) > 0,
  },
  {
    id: 'net-navigator', icon: '🌐', title: '网络领航员', desc: '通关网络工具模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'net'),
  },
  /* ── 文本处理模块 ── */
  {
    id: 'awk-artisan', icon: '🪚', title: 'awk 工匠', desc: '用 awk 处理过表格数据',
    check: c => (c.cmdUsage['awk'] || 0) > 0,
  },
  {
    id: 'text-master', icon: '✂️', title: '文本大师', desc: '通关文本处理模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'text'),
  },
  /* ── 系统管理模块 ── */
  {
    id: 'log-hunter', icon: '📋', title: '日志猎人', desc: '用 journalctl 排查过服务日志',
    check: c => (c.cmdUsage['journalctl'] || 0) > 0,
  },
  {
    id: 'sysadmin', icon: '🔧', title: '系统管理员', desc: '通关系统管理模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'sys'),
  },
  /* ── Vim 模块 ── */
  {
    id: 'vim-virtuoso', icon: '⌨️', title: 'Vim 大师', desc: '通关 Vim 编辑器模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'vim'),
  },
  /* ── 数据库模块 ── */
  {
    id: 'sql-slinger', icon: '🗄️', title: 'SQL 枪手', desc: '进入过 sqlite3 写 SQL',
    check: c => (c.cmdUsage['sqlite3'] || 0) > 0,
  },
  {
    id: 'db-master', icon: '💾', title: '数据管家', desc: '通关数据库模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'db'),
  },
  /* ── Kubernetes 模块 ── */
  {
    id: 'pod-whisperer', icon: '🐳', title: 'Pod 低语者', desc: '用 kubectl 管理过集群',
    check: c => (c.cmdUsage['kubectl'] || 0) > 0,
  },
  {
    id: 'helmsman', icon: '☸', title: '集群舵手', desc: '通关 Kubernetes 模块全部关卡',
    check: c => moduleCleared(c.levelStars, 'k8s'),
  },
  /* ── 命令全面增强：新增成就 ── */
  {
    id: 'json-juggler', icon: '🤹', title: 'JSON 杂技师', desc: '用 jq 解析过 JSON 数据',
    check: c => (c.cmdUsage['jq'] || 0) > 0,
  },
  {
    id: 'route-reader', icon: '🗺️', title: '路由读图员', desc: '用 arp 或 route 查看过路由与邻居表',
    check: c => (c.cmdUsage['arp'] || 0) > 0 || (c.cmdUsage['route'] || 0) > 0,
  },
  {
    id: 'disk-jockey', icon: '💽', title: '磁盘骑手', desc: '用 dd 写入过磁盘镜像',
    check: c => (c.cmdUsage['dd'] || 0) > 0,
  },
  {
    id: 'filesystem-forger', icon: '🧱', title: '文件系统锻造师', desc: '用 mkfs 创建过文件系统',
    check: c => (c.cmdUsage['mkfs'] || 0) > 0,
  },
  {
    id: 'file-anatomist', icon: '🔬', title: '文件解剖师', desc: '用 stat 或 which 查看过文件与命令详情',
    check: c => (c.cmdUsage['stat'] || 0) > 0 || (c.cmdUsage['which'] || 0) > 0,
  },
  {
    id: 'xargs-wrangler', icon: '🧲', title: '参数搬运工', desc: '用 xargs 批量处理过命令参数',
    check: c => (c.cmdUsage['xargs'] || 0) > 0,
  },
  {
    id: 'push-pioneer', icon: '🚀', title: '推送先锋', desc: '用 git push 推送到远程仓库',
    check: c => (c.cmdUsage['git push'] || 0) > 0,
  },
  {
    id: 'clone-ranger', icon: '🧬', title: '克隆游侠', desc: '用 git clone 克隆过远程仓库',
    check: c => (c.cmdUsage['git clone'] || 0) > 0,
  },
  {
    id: 'insight-reader', icon: '📊', title: '图谱洞察者', desc: '通关「洞察」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '07 洞察'),
  },
  {
    id: 'remote-commander', icon: '📡', title: '远程指挥官', desc: '通关「远程」阶段全部关卡',
    check: c => stageCleared(c.levelStars, '09 远程'),
  },
  /* ── 命令全覆盖增强：新增成就 ── */
  {
    id: 'tree-climber', icon: '🌳', title: '树形观察员', desc: '用 tree 查看过目录结构',
    check: c => (c.cmdUsage['tree'] || 0) > 0,
  },
  {
    id: 'port-scanner', icon: '🛰️', title: '端口扫描手', desc: '用 nmap 扫描过主机端口',
    check: c => (c.cmdUsage['nmap'] || 0) > 0,
  },
  {
    id: 'packet-sniffer', icon: '📶', title: '抓包分析师', desc: '用 tcpdump 抓取过网络数据包',
    check: c => (c.cmdUsage['tcpdump'] || 0) > 0,
  },
  {
    id: 'bisect-detective', icon: '🔎', title: '二分侦探', desc: '用 git bisect 定位过问题提交',
    check: c => (c.cmdUsage['git bisect'] || 0) > 0,
  },
  {
    id: 'checkout-adept', icon: '🔄', title: 'checkout 能手', desc: '用 git checkout 切换过分支或恢复文件',
    check: c => (c.cmdUsage['git checkout'] || 0) > 0,
  },
  {
    id: 'sys-logger', icon: '📝', title: '系统记录员', desc: '用 logger 写入过系统日志',
    check: c => (c.cmdUsage['logger'] || 0) > 0,
  },
  {
    id: 'archiver', icon: '🗜️', title: '压缩归档师', desc: '用 zip / xz / bzip2 压缩过文件',
    check: c => (c.cmdUsage['zip'] || 0) > 0 || (c.cmdUsage['xz'] || 0) > 0 || (c.cmdUsage['bzip2'] || 0) > 0,
  },
  {
    id: 'path-tracer', icon: '🛤️', title: '路径追踪者', desc: '用 mtr 或 tracepath 追踪过网络路径',
    check: c => (c.cmdUsage['mtr'] || 0) > 0 || (c.cmdUsage['tracepath'] || 0) > 0,
  },
];

// 根据当前进度计算已解锁的成就 id 列表
export function computeUnlocked(ctx) {
  return ACHIEVEMENTS.filter(a => a.check(ctx)).map(a => a.id);
}

function ctx() {
  return { levelStars: app.levelStars, totalCmds: app.totalCmds, cmdUsage: app.cmdUsage };
}

// 检测新解锁的成就：更新 app.unlockedAch，返回新增的成就对象数组
// 调用方负责弹提示与 saveProgress()
export function detectNewAchievements() {
  const now = computeUnlocked(ctx());
  const seen = new Set(app.unlockedAch);
  const fresh = now.filter(id => !seen.has(id));
  if (fresh.length) app.unlockedAch = now;
  return fresh.map(id => ACHIEVEMENTS.find(a => a.id === id)).filter(Boolean);
}

export function unlockedCountAch() {
  return computeUnlocked(ctx()).length;
}
