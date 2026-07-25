// 文件系统接口 —— 统一 shell 命令对文件的操作方式
// GitEngine 用扁平 {path: content} 映射；LinuxEngine 用目录树。
// 两者都暴露相同的 fs 接口，让 shell 命令处理器可以复用。

/**
 * 解析管道与重定向：把一行命令拆成 stages + 重定向信息
 * 返回 { stages: string[], redirect: {type: '>'|'>>'|null, file: string|null} }
 */
export function parsePipeline(input) {
  // 先提取重定向（只处理行尾的 > / >> file）
  let redirect = { type: null, file: null };
  const redirMatch = input.match(/^(.*?)\s*(>>|>)\s*(\S+)\s*$/);
  let line = input;
  if (redirMatch) {
    line = redirMatch[1];
    redirect = { type: redirMatch[2], file: redirMatch[3] };
  }
  // 按 | 分割（不在引号内的）
  const stages = [];
  let cur = '', q = null;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; cur += ch; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === '|') { stages.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) stages.push(cur.trim());
  return { stages, redirect };
}

/**
 * 为 GitEngine 创建 fs 适配器（扁平文件映射）
 */
export function gitFsAdapter(engine) {
  return {
    readFile(path) { return engine.files[path]; },
    writeFile(path, content) { engine.files[path] = content; },
    appendFile(path, content) { engine.files[path] = (engine.files[path] || '') + content; },
    removeFile(path) { delete engine.files[path]; delete engine.index[path]; },
    exists(path) { return engine.files[path] !== undefined; },
    listEntries() { return Object.keys(engine.files); },
    isDir() { return false; },
    mkdir() { return { ok: false, error: '不支持目录操作（git 模块使用扁平文件系统）' }; },
  };
}
