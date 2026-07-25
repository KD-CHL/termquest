// Shell + Git 混合模块关卡 —— 文本处理与 git 工作流结合、脚本自动化
// 共享 GitEngine（G）：setup/check 直接操作 G。
import { seed, commitTo } from './levels.js';

export const SHELLGIT_LEVELS = [
  /* ============ 01 文本编辑 ============ */
  {
    stage: '01 文本编辑', id: 'S01', title: 'sed 修复错别字', par: 3,
    desc: 'README.md 里有个错别字 "teh"（应为 "the"）。用 <code>sed -i \'s/teh/the/g\' README.md</code> 原地修复，然后 <code>git add</code> + <code>git commit</code>。',
    hints: ['cat README.md', 'sed -i \'s/teh/the/g\' README.md', 'git add README.md', 'git commit -m "fix typo"'],
    setup(g) {
      g.reset();
      g.files['README.md'] = g.index['README.md'] = 'The quick brown fox jumps over teh lazy dog.\n';
      const id = g.newId();
      g.commits[id] = { id, msg: 'init', parents: [], tree: g.snap(g.index) };
      g.branches.main = id;
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.files['README.md'] === 'The quick brown fox jumps over the lazy dog.\n' && c && c.msg !== 'init' && c.tree['README.md'] === 'The quick brown fox jumps over the lazy dog.\n';
    },
    done: 'sed -i 原地编辑文件，是批量修正文本的利器，改完记得提交。'
  },
  {
    stage: '01 文本编辑', id: 'S02', title: 'grep 定位再修复', par: 4,
    desc: 'config.ini 里混进了错误的调试配置 <code>debug=true</code>。先 <code>grep debug config.ini</code> 确认，再 <code>sed -i</code> 改成 <code>debug=false</code>，最后提交。',
    hints: ['grep debug config.ini', 'sed -i \'s/debug=true/debug=false/\' config.ini', 'git add config.ini', 'git commit -m "disable debug"'],
    setup(g) {
      g.reset();
      g.files['config.ini'] = g.index['config.ini'] = 'port=8080\ndebug=true\nlog=info\n';
      const id = g.newId();
      g.commits[id] = { id, msg: 'init', parents: [], tree: g.snap(g.index) };
      g.branches.main = id;
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('grep') && g.files['config.ini'].includes('debug=false') && c && c.tree['config.ini'].includes('debug=false');
    },
    done: '先 grep 定位、再 sed 修复、最后提交——这是处理配置错误的标准流程。'
  },
  {
    stage: '01 文本编辑', id: 'S03', title: '追加内容并提交', par: 3,
    desc: '用 <code>echo</code> 和 <code>>></code> 给 CHANGELOG.md 追加一行 "v1.1: 修复若干问题"，然后 <code>cat</code> 确认并提交。',
    hints: ['echo "v1.1: 修复若干问题" >> CHANGELOG.md', 'cat CHANGELOG.md', 'git add CHANGELOG.md', 'git commit -m "update changelog"'],
    setup(g) {
      g.reset();
      g.files['CHANGELOG.md'] = g.index['CHANGELOG.md'] = 'v1.0: 首次发布\n';
      const id = g.newId();
      g.commits[id] = { id, msg: 'init', parents: [], tree: g.snap(g.index) };
      g.branches.main = id;
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.files['CHANGELOG.md'].includes('v1.1') && c && c.tree['CHANGELOG.md'].includes('v1.1');
    },
    done: '>> 追加、cat 确认、commit 提交——文档维护的日常三连。'
  },

  /* ============ 02 脚本自动化 ============ */
  {
    stage: '02 脚本自动化', id: 'S04', title: '第一个脚本', par: 4,
    desc: '把提交流程写成脚本：用两行 <code>echo</code> 创建 <code>commit.sh</code>（内容为 <code>git add .</code> 和 <code>git commit -m "auto"</code>），然后 <code>bash commit.sh</code> 运行它（先创建一个 note.txt 让提交有内容）。',
    hints: ['echo "note" > note.txt', 'echo "git add ." > commit.sh', 'echo "git commit -m \\"auto\\"" >> commit.sh', 'bash commit.sh'],
    setup(g) { g.reset(); seed(g); },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('bash') && c && c.msg === 'auto' && c.tree['note.txt'] !== undefined;
    },
    done: '把重复的 git 命令写成脚本，一条 bash 命令搞定——自动化第一步。'
  },
  {
    stage: '02 脚本自动化', id: 'S05', title: '脚本批量建文件', par: 4,
    desc: '编写脚本 <code>gen.sh</code>：用 echo 写入三行，分别创建 a.txt、b.txt、c.txt。运行 <code>bash gen.sh</code> 后 <code>ls</code> 确认三个文件都生成了。',
    hints: ['echo "echo A > a.txt" > gen.sh', 'echo "echo B > b.txt" >> gen.sh', 'echo "echo C > c.txt" >> gen.sh', 'bash gen.sh', 'ls'],
    setup(g) { g.reset(); },
    check(g) {
      return g.used.has('bash') && g.used.has('ls') &&
        g.files['a.txt'] !== undefined && g.files['b.txt'] !== undefined && g.files['c.txt'] !== undefined;
    },
    done: '脚本可以批量生成文件——脚手架、初始化环境的常用手段。'
  },
  {
    stage: '02 脚本自动化', id: 'S06', title: '一键修复脚本', par: 5,
    desc: '两个文件里都有 "colour" 要改成 "color"。写一个 <code>fix.sh</code>：两行 sed 分别修复 en1.txt 和 en2.txt，运行后 <code>grep colour</code> 应无结果，最后提交。',
    hints: ['echo "sed -i \'s/colour/color/g\' en1.txt" > fix.sh', 'echo "sed -i \'s/colour/color/g\' en2.txt" >> fix.sh', 'bash fix.sh', 'git add .', 'git commit -m "normalize spelling"'],
    setup(g) {
      g.reset();
      g.files['en1.txt'] = g.index['en1.txt'] = 'The colour is red.\n';
      g.files['en2.txt'] = g.index['en2.txt'] = 'My favourite colour.\n';
      const id = g.newId();
      g.commits[id] = { id, msg: 'init', parents: [], tree: g.snap(g.index) };
      g.branches.main = id;
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('bash') && !g.files['en1.txt'].includes('colour') && !g.files['en2.txt'].includes('colour') &&
        c && c.tree['en1.txt'].includes('color') && c.tree['en2.txt'].includes('color');
    },
    done: '一个脚本修复多个文件——批量重构不再逐个手动编辑。'
  },

  /* ============ 03 综合工作流 ============ */
  {
    stage: '03 综合工作流', id: 'S07', title: '日志分析提交', par: 4,
    desc: '分析 app.log：用管道 <code>grep ERROR app.log | wc -l</code> 统计错误数，把结果写入 <code>report.txt</code>（用重定向），然后提交 report.txt。',
    hints: ['grep ERROR app.log | wc -l', 'grep ERROR app.log | wc -l > report.txt', 'git add report.txt', 'git commit -m "add error report"'],
    setup(g) {
      g.reset();
      g.files['app.log'] = g.index['app.log'] = 'INFO ok\nERROR db down\nINFO ok\nERROR timeout\nERROR crash\n';
      const id = g.newId();
      g.commits[id] = { id, msg: 'init', parents: [], tree: g.snap(g.index) };
      g.branches.main = id;
    },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('grep') && g.used.has('wc') && g.files['report.txt'] !== undefined &&
        g.files['report.txt'].trim() === '3' && c && c.tree['report.txt'] !== undefined;
    },
    done: '管道统计 + 重定向落盘 + 提交归档——一条流水线完成日志分析报告。'
  },
  {
    stage: '03 综合工作流', id: 'S08', title: '全自动发布', par: 5,
    desc: '终极挑战：写一个 <code>release.sh</code> 脚本，让它自动完成：① 给 version.txt 写入 v2.0；② git add；③ git commit -m "release v2.0"。运行 <code>bash release.sh</code>，然后用 <code>git log --oneline</code> 验证。',
    hints: ['echo "echo v2.0 > version.txt" > release.sh', 'echo "git add version.txt" >> release.sh', 'echo "git commit -m \\"release v2.0\\"" >> release.sh', 'bash release.sh', 'git log --oneline'],
    setup(g) { g.reset(); seed(g); },
    check(g) {
      const c = g.commits[g.branches.main];
      return g.used.has('bash') && g.used.has('log') && c && c.msg === 'release v2.0' &&
        c.tree['version.txt'] !== undefined && g.files['version.txt'].includes('v2.0');
    },
    done: '脚本驱动整个发布流程——CI/CD 流水线的雏形，恭喜毕业！'
  },
];
