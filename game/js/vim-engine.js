// VimEngine —— 继承 LinuxEngine（文件存储），叠加 vim 模态编辑状态
// vim 状态：null = 未打开；否则 { file, lines[], row, col, mode, yank[], modified, number, search }
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
      mode: 'normal',       // normal | insert
      yank: [],             // 复制缓冲区（行数组）
      modified: false,
      number: false,        // :set number
      search: null,
      msg: '',              // 底部消息
    };
    return this.vim;
  }

  closeVim() { this.vim = null; }

  // 保存缓冲区到文件
  saveVim() {
    if (!this.vim) return;
    this.writeFile(this.vim.file, this.vim.lines.join('\n') + '\n');
    this.vim.modified = false;
  }

  curLine() { return this.vim.lines[this.vim.row] || ''; }
  clampCursor() {
    const v = this.vim;
    v.row = Math.max(0, Math.min(v.row, v.lines.length - 1));
    const len = (v.lines[v.row] || '').length;
    v.col = Math.max(0, Math.min(v.col, Math.max(0, len - (v.mode === 'normal' && len > 0 ? 1 : 0))));
  }
}
