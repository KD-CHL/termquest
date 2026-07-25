// 共享状态 —— 引擎实例 + 可变应用状态
// 说明：ES Module 的导出绑定对导入方是只读的，
// 所以可变状态统一放进 app 对象，保证各模块读写同一份。
import { GitEngine } from './engine.js';

export const G = new GitEngine();

export const app = {
  currentLevel: 0,
  cmdCount: 0,
  levelStars: [],        // 每关星级 0-3，启动时按关卡数初始化
  levelDoneFlags: [],    // 本关是否已通关（防重复弹窗）
  totalCmds: 0,          // 累计命令数
  cmdUsage: {},          // 命令使用频次 {命令: 次数}
  unlockedAch: [],       // 已解锁成就 id 列表
  soundOn: true,
  sandbox: false,        // 自由模式
  currentUser: null,     // 当前登录用户 {id, username, role, progress}
  // 多模块支持
  currentModule: null,   // 当前模块描述符（由 modules.js 初始化）
  engine: null,          // 当前引擎实例（由 modules.js 初始化）
  // 命令执行后的回调钩子（由 ui.js 注入），解耦 commands 与 ui
  afterCommand: null,    // (shouldCheck) => void
};

export function isAdmin() {
  return app.currentUser && app.currentUser.role === 'admin';
}
