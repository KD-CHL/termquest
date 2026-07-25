// 进度持久化 —— 以后端为主、localStorage 为缓存
// 登录用户的进度与账号绑定（存服务器），未登录/离线时回退到 localStorage。
import { app } from './state.js';
import { ALL_LEVELS } from './modules.js';
import { saveRemoteProgress } from './auth.js';

const LS_KEY = 'gitgame';

// 确保 levelStars 数组长度与全局关卡数一致（旧数据可能更短）
function padStars(arr) {
  const a = Array.isArray(arr) ? arr.slice(0, ALL_LEVELS.length) : [];
  while (a.length < ALL_LEVELS.length) a.push(0);
  return a;
}

export function saveProgress() {
  // 本地缓存（离线兜底）
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ levelStars: app.levelStars, totalCmds: app.totalCmds, cmdUsage: app.cmdUsage, unlockedAch: app.unlockedAch }));
  } catch (e) { /* 隐私模式等场景下忽略 */ }
  // 同步到后端（静默，失败不影响游戏）
  saveRemoteProgress(app.levelStars, app.totalCmds, app.cmdUsage, app.unlockedAch);
}

// user 为 /api/auth/me 返回的当前用户（含 progress）；优先用后端进度
export function loadProgress(user) {
  const remote = user && user.progress && Array.isArray(user.progress.levelStars) && user.progress.levelStars.length
    ? user.progress : null;
  if (remote) {
    app.levelStars = padStars(remote.levelStars);
    app.totalCmds = remote.totalCmds || 0;
    app.cmdUsage = remote.cmdUsage || {};
    app.unlockedAch = remote.achievements || [];
    return;
  }
  // 回退：本地缓存
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY));
    if (d) {
      app.levelStars = padStars(d.levelStars);
      app.totalCmds = d.totalCmds || 0;
      app.cmdUsage = d.cmdUsage || {};
      app.unlockedAch = d.unlockedAch || [];
    }
  } catch (e) { /* 忽略 */ }
}
