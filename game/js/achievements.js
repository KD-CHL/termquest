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
