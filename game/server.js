// 零依赖服务器 —— 静态文件 + 认证/进度/管理 API
// 运行 `node server.js` 即可启动游戏（含登录）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { loadUsers, loadSessions } from './server/db.js';
import { handleApi } from './server/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5188;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// 启动时加载数据（首次运行自动创建默认管理员）
loadUsers();
loadSessions();

const server = http.createServer(async (req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  // API 路由
  if (urlPath.startsWith('/api/')) {
    try { await handleApi(req, res, urlPath); }
    catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '服务器内部错误' }));
    }
    return;
  }

  // 静态文件
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const abs = path.normalize(path.join(__dirname, filePath));
  // 防止路径穿越
  if (!abs.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  🎮  TermQuest 终端闯关练习已启动（含登录系统）');
  console.log(`  ➜  本地访问: ${url}`);
  console.log('');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');
  // 自动打开浏览器（测试/无头环境可设 GITGAME_NO_OPEN=1 跳过）
  if (process.env.GITGAME_NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? `open ${url}`
    : process.platform === 'win32' ? `start ${url}`
    : `xdg-open ${url}`;
  exec(cmd, () => {});
});
