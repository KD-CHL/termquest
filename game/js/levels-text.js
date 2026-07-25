// 文本处理进阶模块关卡 —— find / xargs / awk / sed / paste / join / diff
// setup/check 操作 LinuxEngine（e）。
function seed(e) {
  e.reset();
  const home = '/home/user';
  e.writeFile(home + '/people.csv', 'alice,30,beijing\nbob,25,shanghai\ncarol,35,shenzhen\ndave,22,guangzhou\n');
  e.writeFile(home + '/sales.txt', 'apple 10\nbanana 20\ncherry 30\n');
  e.writeFile(home + '/config.txt', '# config\ndebug=true\nport=8080\ntimeout=30\n');
  e.writeFile(home + '/poem.txt', 'line one\nline two\nline three\nline four\nline five\n');
  e.writeFile(home + '/todo.md', '- buy milk\n- write report\n');
}

export const TEXT_LEVELS = [
  /* ============ 01 find 查找 ============ */
  {
    stage: '01 find 查找', id: 'T01', title: '按名字找文件', par: 2,
    desc: '工作目录里混着日志和数据。用 <code>find . -name "*.csv"</code> 找出所有 CSV 文件，再用 <code>find . -name "config*"</code> 找配置文件。',
    hints: ['find . -name "*.csv"', 'find . -name "config*"'],
    setup(e) { seed(e); e.writeFile('/home/user/app.log', 'INFO ok\n'); e.writeFile('/home/user/db.log', 'INFO ok\n'); },
    check(e) { return e.used.has('find') && e.lastOut.includes('config'); },
    done: 'find 是文件搜索的终极工具：-name 按通配符匹配，比 ls + grep 强大得多。'
  },
  {
    stage: '01 find 查找', id: 'T02', title: '按类型统计', par: 2,
    desc: '用 <code>find . -type f</code> 列出所有普通文件，再用管道 <code>find . -type f | wc -l</code> 统计文件总数（应为 5）。',
    hints: ['find . -type f', 'find . -type f | wc -l'],
    setup(e) { seed(e); },
    check(e) { return e.used.has('find') && e.used.has('wc') && e.lastOut.trim() === '5'; },
    done: '-type f 只找文件、-type d 只找目录。find | wc -l 是"这里到底有多少文件"的标准答案。'
  },
  {
    stage: '01 find 查找', id: 'T03', title: 'xargs 批量删除', par: 2,
    desc: '有一堆 <code>.tmp</code> 临时文件要清理。用 <code>find . -name "*.tmp" | xargs rm</code> 一条命令全部删除，再 <code>ls</code> 确认。',
    hints: ['ls', 'find . -name "*.tmp" | xargs rm', 'ls'],
    setup(e) {
      seed(e);
      ['a', 'b', 'c'].forEach(n => e.writeFile(`/home/user/${n}.tmp`, 'temp\n'));
    },
    check(e) { return e.used.has('xargs') && !e.exists('a.tmp') && !e.exists('b.tmp') && !e.exists('c.tmp'); },
    done: 'xargs 把前一个命令的输出变成后一个命令的参数——find 找到什么，rm 就删什么，批量操作利器。'
  },

  /* ============ 02 awk 进阶 ============ */
  {
    stage: '02 awk 进阶', id: 'T04', title: '条件过滤', par: 2,
    desc: '<code>people.csv</code> 是逗号分隔的人员表。用 <code>awk -F, \'$2 > 28 {print $1}\' people.csv</code> 找出年龄大于 28 的人的名字。',
    hints: ['cat people.csv', `awk -F, '$2 > 28 {print $1}' people.csv`],
    setup(e) { seed(e); },
    check(e) { return e.used.has('awk') && e.lastOut.includes('alice') && e.lastOut.includes('carol') && !e.lastOut.includes('bob'); },
    done: 'awk 是列处理器：-F 指定分隔符，$N 引用第 N 列，条件 + {动作} 实现精准过滤。'
  },
  {
    stage: '02 awk 进阶', id: 'T05', title: '聚合求和', par: 2,
    desc: '<code>sales.txt</code> 第二列是销量。用 <code>awk \'{sum+=$2} END {print sum}\' sales.txt</code> 计算总销量（应为 60）。',
    hints: ['cat sales.txt', `awk '{sum+=$2} END {print sum}' sales.txt`],
    setup(e) { seed(e); },
    check(e) { return e.used.has('awk') && e.lastOut.trim() === '60'; },
    done: 'awk 不只是过滤，还能累加统计：sum+=$2 逐行累加，END 块在处理完所有行后输出结果。'
  },

  /* ============ 03 sed 进阶 ============ */
  {
    stage: '03 sed 进阶', id: 'T06', title: '删除指定行', par: 2,
    desc: '<code>config.txt</code> 第 2 行是 <code>debug=true</code>。用 <code>sed -i \'2d\' config.txt</code> 直接删掉这一行，再 <code>cat config.txt</code> 确认。',
    hints: ['cat config.txt', `sed -i '2d' config.txt`, 'cat config.txt'],
    setup(e) { seed(e); },
    check(e) { const r = e.readFile('config.txt'); return e.used.has('sed') && r.ok && !r.content.includes('debug=true') && r.content.includes('port=8080'); },
    done: 'sed Nd 按行号删除，-i 直接改文件。批量清理配置、去掉多余行，一行命令搞定。'
  },
  {
    stage: '03 sed 进阶', id: 'T07', title: '精确提取与正则删除', par: 3,
    desc: '用 <code>sed -n \'3p\' poem.txt</code> 只打印第 3 行，再用 <code>sed \'/two/d\' poem.txt</code> 删除包含 "two" 的行（不改文件，只看输出）。',
    hints: [`sed -n '3p' poem.txt`, `sed '/two/d' poem.txt`],
    setup(e) { seed(e); },
    check(e) { return e.used.has('sed') && e.lastOut.includes('line one') && !e.lastOut.includes('line two'); },
    done: '-n 配合 p 实现精确提取，/正则/d 按内容删除——sed 的两种"手术刀"用法。'
  },

  /* ============ 04 合并与对比 ============ */
  {
    stage: '04 合并与对比', id: 'T08', title: 'paste 并排合并', par: 2,
    desc: '把 <code>names.txt</code> 和 <code>scores.txt</code> 用 <code>paste names.txt scores.txt</code> 并排合并（Tab 分隔），再用 <code>join names.txt scores.txt</code> 按第一列连接。',
    hints: ['paste names.txt scores.txt', 'join names.txt scores.txt'],
    setup(e) {
      e.reset();
      e.writeFile('/home/user/names.txt', 'alice\nbob\ncarol\n');
      e.writeFile('/home/user/scores.txt', 'alice 90\nbob 85\ncarol 92\n');
    },
    check(e) { return e.used.has('paste') && e.used.has('join') && e.lastOut.includes('alice'); },
    done: 'paste 按行并排（适合列对齐），join 按 key 连接（类似数据库 JOIN）——两种合并姿势各有用途。'
  },
  {
    stage: '04 合并与对比', id: 'T09', title: 'diff 找不同', par: 2,
    desc: '两个版本的配置文件 <code>v1.conf</code> 和 <code>v2.conf</code>。用 <code>diff v1.conf v2.conf</code> 找出差异（< 是 v1 独有，> 是 v2 独有）。',
    hints: ['cat v1.conf', 'cat v2.conf', 'diff v1.conf v2.conf'],
    setup(e) {
      e.reset();
      e.writeFile('/home/user/v1.conf', 'port=8080\ndebug=true\nlog=info\n');
      e.writeFile('/home/user/v2.conf', 'port=9090\ndebug=true\nlog=debug\n');
    },
    check(e) { return e.used.has('diff') && e.lastOut.includes('<') && e.lastOut.includes('>'); },
    done: 'diff 逐行对比：< 标记第一个文件独有，> 标记第二个文件独有。git diff 的底层就是它。'
  },

  /* ============ 05 综合实战 ============ */
  {
    stage: '05 综合实战', id: 'T10', title: '数据管道流水线', par: 3,
    desc: '综合挑战：用一条管道统计 <code>people.csv</code> 中来自 beijing 的人数：<code>grep beijing people.csv | wc -l</code>，再用 <code>awk -F, \'{print $3}\' people.csv | sort | uniq -c</code> 统计各城市人数。',
    hints: ['grep beijing people.csv | wc -l', `awk -F, '{print $3}' people.csv | sort | uniq -c`],
    setup(e) { seed(e); },
    check(e) { return e.used.has('grep') && e.used.has('awk') && e.used.has('uniq') && e.lastOut.includes('beijing'); },
    done: 'grep 过滤 → awk 提列 → sort 排序 → uniq 计数——文本管道四连击，数据分析信手拈来。恭喜通关！🎓'
  },
];
