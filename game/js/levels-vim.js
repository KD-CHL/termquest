// Vim 编辑器模块关卡 —— 模态编辑 / 移动 / 删改 / 复制粘贴 / 查找替换
// setup/check 操作 VimEngine（e）。:wq 后文件写回 e 的文件系统，check 读取验证。
export const VIM_LEVELS = [
  /* ============ 01 入门 ============ */
  {
    stage: '01 入门', id: 'V01', title: '第一次编辑', par: 4,
    desc: '用 <code>vim hello.txt</code> 打开（新建）文件，按 <code>i</code> 进入插入模式，输入 <code>hello vim</code>，按 <code>Esc</code> 回到普通模式，最后 <code>:wq</code> 保存退出。',
    hints: ['vim hello.txt', 'i', 'hello vim', 'Esc', ':wq'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('hello.txt'); return r.ok && r.content.includes('hello vim') && !e.vim; },
    done: 'vim 的核心是模态：i 进入插入模式打字，Esc 回到普通模式，:wq 保存退出。记住这个循环！'
  },
  {
    stage: '01 入门', id: 'V02', title: '下方插入新行', par: 5,
    desc: '打开 <code>notes.txt</code>，按 <code>j</code> 下移一行，按 <code>o</code> 在下方开新行并进入插入模式，输入 <code>inserted line</code>，<code>Esc</code> 后 <code>:wq</code> 保存。',
    hints: ['vim notes.txt', 'j', 'o', 'inserted line', 'Esc', ':wq'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('notes.txt'); return r.ok && r.content.includes('inserted line') && !e.vim; },
    done: 'o 在光标下方开新行并直接进入插入模式——比按回车优雅得多。O 则在上方开新行。'
  },

  /* ============ 02 删除与移动 ============ */
  {
    stage: '02 删除与移动', id: 'V03', title: '删除一行', par: 4,
    desc: '打开 <code>poem.txt</code>，按 <code>j</code> 移到第 2 行（violets...），按 <code>dd</code> 删除整行，<code>:wq</code> 保存。',
    hints: ['vim poem.txt', 'j', 'dd', ':wq'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('poem.txt'); return r.ok && !r.content.includes('violets') && r.content.includes('roses') && !e.vim; },
    done: 'dd 删除光标所在行，3dd 一次删 3 行。删除的内容会进寄存器，还能 p 粘回来。'
  },
  {
    stage: '02 删除与移动', id: 'V04', title: '改写整行', par: 5,
    desc: '打开 <code>config.ini</code>，按 <code>3j</code> 移到 host 那行，按 <code>cc</code> 清空该行并进入插入模式，输入 <code>host = 0.0.0.0</code>，<code>Esc</code> 后 <code>:wq</code>。',
    hints: ['vim config.ini', '3j', 'cc', 'host = 0.0.0.0', 'Esc', ':wq'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('config.ini'); return r.ok && r.content.includes('0.0.0.0') && !r.content.includes('localhost') && !e.vim; },
    done: 'cc = 删除整行 + 进入插入模式，是"重写这一行"的标准姿势。C 则是删到行尾继续编辑。'
  },

  /* ============ 03 复制粘贴 ============ */
  {
    stage: '03 复制粘贴', id: 'V05', title: '复制一行', par: 4,
    desc: '打开 <code>notes.txt</code>，光标在第 1 行按 <code>yy</code> 复制，再按 <code>p</code> 粘贴到下方（第 1 行会出现两次），<code>:wq</code> 保存。',
    hints: ['vim notes.txt', 'yy', 'p', ':wq'],
    setup(e) { e.reset(); },
    check(e) {
      const r = e.readFile('notes.txt');
      return r.ok && r.content.split('first line').length - 1 === 2 && !e.vim;
    },
    done: 'yy 复制（yank）当前行，p 粘贴到下方。3yy 复制 3 行。vim 的复制粘贴不用鼠标。'
  },

  /* ============ 04 查找替换 ============ */
  {
    stage: '04 查找替换', id: 'V06', title: '全文替换', par: 3,
    desc: '把 <code>config.ini</code> 里的端口从 8080 改成 9090：打开文件后直接输入 <code>:%s/8080/9090/g</code> 全文替换，<code>:wq</code> 保存。',
    hints: ['vim config.ini', ':%s/8080/9090/g', ':wq'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('config.ini'); return r.ok && r.content.includes('9090') && !r.content.includes('8080') && !e.vim; },
    done: ':%s/旧/新/g 是 vim 的全文替换：s 替换、% 全文、g 每行所有匹配。改配置神器。'
  },
  {
    stage: '04 查找替换', id: 'V07', title: '搜索并删除', par: 4,
    desc: '打开 <code>poem.txt</code>，输入 <code>/awesome</code> 搜索定位到那一行，按 <code>dd</code> 删掉它，<code>:wq</code> 保存。',
    hints: ['vim poem.txt', '/awesome', 'dd', ':wq'],
    setup(e) { e.reset(); },
    check(e) { const r = e.readFile('poem.txt'); return r.ok && !r.content.includes('awesome') && r.content.includes('roses') && !e.vim; },
    done: '/模式 向下搜索，n 跳下一个。搜索定位 + dd 删除，是清理文本的高效组合。'
  },

  /* ============ 05 综合实战 ============ */
  {
    stage: '05 综合实战', id: 'V08', title: '配置大改造', par: 7,
    desc: '综合挑战：打开 <code>config.ini</code>，① <code>:%s/8080/9090/g</code> 改端口；② <code>2j</code> 移到 debug 行，<code>dd</code> 删除；③ <code>gg</code> 回到开头，<code>O</code> 上方开新行，输入 <code># production config</code>；④ <code>Esc</code> 后 <code>:wq</code> 保存。',
    hints: ['vim config.ini', ':%s/8080/9090/g', '2j', 'dd', 'gg', 'O', '# production config', 'Esc', ':wq'],
    setup(e) { e.reset(); },
    check(e) {
      const r = e.readFile('config.ini');
      return r.ok && r.content.includes('9090') && !r.content.includes('debug') &&
        r.content.includes('# production config') && !e.vim;
    },
    done: '替换 + 删除 + 插入，一套组合拳完成配置改造。恭喜，Vim 模块通关——你已经入门了世界上最强大的编辑器！🎓'
  },
];
