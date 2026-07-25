// VimEngine —— 继承 LinuxEngine（文件存储），叠加 vim 模态编辑状态
// vim 状态：null = 未打开；否则 { file, lines[], row, col, mode, yank[], modified, number, rnu,
//   search, searchDir, searchCase, undo[]（修改前快照栈，u 撤销）, savedLines[]（上次保存的内容）,
//   insertCol（cw/c$/s 行内续写的插入列，null = 整行输入模式）,
//   registers{}（命名寄存器 "a..）, marks{}（ma/'a）, visual/visualLine（可视模式）,
//   buffers[]/bufferState{}（:bn/:bp 缓冲区列表） }
import { LinuxEngine } from './linux-engine.js';

export class VimEngine extends LinuxEngine {
  reset() {
    super.reset();
    this.vim = null;
    this._seedVimFiles();
  }

  _seedVimFiles() {
    this.writeFile('/home/user/notes.txt', 'first line\nsecond line\nthird line\nfourth line\nfifth line\n');
    this.writeFile('/home/user/config.ini', '[server]\nport = 8080\ndebug = true\nhost = localhost\n');
    this.writeFile('/home/user/poem.txt', 'roses are red\nviolets are blue\nvim is awesome\nand so are you\n');
  }

  // 打开文件进入 vim
  openVim(file) {
    const r = this.readFile(file);
    const content = r.ok ? r.content : '';
    let lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    if (!lines.length) lines = [''];
    this.vim = {
      file: this.resolvePath(file),
      lines, row: 0, col: 0,
      mode: 'normal',       // normal | insert | visual
      yank: [],             // 复制缓冲区（行数组，默认寄存器）
      modified: false,
      number: false,        // :set number
      rnu: false,           // :set relativenumber（相对行号）
      search: null,
      searchDir: 1,         // 上次搜索方向：1 = /(向下)，-1 = ?(向上)
      searchCase: true,     // 搜索是否区分大小写（\c 关闭）
      msg: '',              // 底部消息
      undo: [],             // 修改前快照栈（u 撤销），上限 100
      savedLines: lines.slice(), // 上次保存时的内容（判定 modified）
      insertCol: null,      // cw/c$/s 后行内续写的列；null = 整行输入模式
      registers: {},        // 命名寄存器 {a: [行...]}（"ayy / "ap）
      marks: {},            // 标记 {a: {row, col}}（ma / 'a）
      visual: null,         // 可视模式锚点 {row, col} | null
      visualLine: false,    // V 行可视（true）/ v 字符可视（false）
      buffers: [this.resolvePath(file)], // 缓冲区文件列表（:bn/:bp）
      bufferState: {},      // 切换缓冲区时暂存的状态 {path: {...}}
    };
    return this.vim;
  }

  closeVim() { this.vim = null; }

  // 把当前缓冲区的编辑状态暂存到 bufferState（供 :bn/:bp 切换时恢复）
  saveBuffer() {
    const v = this.vim;
    if (!v) return;
    v.bufferState[v.file] = {
      lines: v.lines.slice(), row: v.row, col: v.col,
      modified: v.modified, undo: v.undo.slice(),
      savedLines: v.savedLines.slice(), insertCol: v.insertCol,
    };
  }

  // 切换到指定路径的缓冲区：优先恢复暂存状态，否则从文件系统重新读入
  switchBuffer(path) {
    const v = this.vim;
    if (!v) return;
    const resolved = this.resolvePath(path);
    const st = v.bufferState[resolved];
    if (st) {
      v.lines = st.lines.slice(); v.row = st.row; v.col = st.col;
      v.modified = st.modified; v.undo = st.undo.slice();
      v.savedLines = st.savedLines.slice(); v.insertCol = st.insertCol;
    } else {
      const r = this.readFile(resolved);
      let lines = (r.ok ? r.content : '').split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      if (!lines.length) lines = [''];
      v.lines = lines; v.row = 0; v.col = 0;
      v.modified = false; v.undo = []; v.savedLines = lines.slice(); v.insertCol = null;
    }
    v.file = resolved; v.mode = 'normal'; v.visual = null;
    if (!v.buffers.includes(resolved)) v.buffers.push(resolved);
    this.clampCursor();
  }

  // 保存缓冲区到文件
  saveVim() {
    if (!this.vim) return;
    this.writeFile(this.vim.file, this.vim.lines.join('\n') + '\n');
    this.vim.modified = false;
    this.vim.savedLines = this.vim.lines.slice();
  }

  // 在任何修改操作前推入快照（lines + 光标），上限 100 条
  pushUndo() {
    const v = this.vim;
    if (!v) return;
    v.undo.push({ lines: v.lines.slice(), row: v.row, col: v.col });
    if (v.undo.length > 100) v.undo.shift();
  }

  // u —— 弹出最近快照并恢复；成功返回 true，栈空返回 false
  undoVim() {
    const v = this.vim;
    if (!v || !v.undo.length) return false;
    const snap = v.undo.pop();
    v.lines = snap.lines;
    v.row = snap.row;
    v.col = snap.col;
    v.modified = v.lines.join('\n') !== (v.savedLines || v.lines).join('\n');
    this.clampCursor();
    return true;
  }

  curLine() { return this.vim.lines[this.vim.row] || ''; }
  clampCursor() {
    const v = this.vim;
    v.row = Math.max(0, Math.min(v.row, v.lines.length - 1));
    const len = (v.lines[v.row] || '').length;
    v.col = Math.max(0, Math.min(v.col, Math.max(0, len - (v.mode === 'normal' && len > 0 ? 1 : 0))));
  }
}
