# 08 — 高级操作

## 核心概念

这些是日常开发中进阶但非常实用的操作：

- **reflog**：记录 HEAD 的所有移动历史，是终极后悔药
- **bisect**：二分查找定位引入 bug 的提交
- **worktree**：同时检出多个分支到不同目录
- **submodule**：在一个仓库中嵌套另一个仓库
- **blame**：查看每一行是谁在什么时候写的

## 命令速查

```bash
# Reflog（救命工具）
git reflog                      # 查看 HEAD 的所有移动记录
git reflog show <branch>        # 查看某分支的历史
git checkout HEAD@{3}           # 回到 3 步之前的状态
git reset --hard HEAD@{5}       # 恢复到 5 步之前
git branch recovery HEAD@{2}    # 从 reflog 创建恢复分支

# Bisect（二分查找 bug）
git bisect start                # 开始
git bisect bad                  # 标记当前版本有 bug
git bisect good <commit>        # 标记一个已知正常的版本
# Git 自动检出中间的提交，你测试后：
git bisect good                 # 这个版本正常
git bisect bad                  # 这个版本有 bug
# 重复直到找到第一个引入 bug 的提交
git bisect reset                # 结束，回到原来的位置
git bisect run <script>         # 自动化：用脚本判断好坏

# Worktree（多工作目录）
git worktree add ../hotfix hotfix-branch   # 在新目录检出分支
git worktree list               # 列出所有 worktree
git worktree remove ../hotfix   # 删除 worktree
git worktree prune              # 清理无效记录

# Submodule（嵌套仓库）
git submodule add <url> <path>  # 添加子模块
git submodule init              # 初始化子模块配置
git submodule update            # 拉取子模块内容
git submodule update --init --recursive  # 克隆后一步到位
git submodule foreach git pull  # 更新所有子模块
git clone --recurse-submodules <url>     # 克隆时包含子模块

# Subtree（替代 submodule 的方案）
git subtree add --prefix=lib/tool <url> main --squash   # 添加
git subtree pull --prefix=lib/tool <url> main --squash  # 更新
git subtree push --prefix=lib/tool <url> main           # 推送修改

# Blame & 统计
git blame <file>                # 逐行显示最后修改者
git blame -L 10,20 <file>      # 只看第 10-20 行
git shortlog -sn                # 按作者统计提交数
git log --stat                  # 每次提交的文件变更统计
git diff --stat <c1> <c2>      # 两次提交间的变更概要
```

## 动手练习

### 练习 1：用 reflog 找回"删除"的提交
```bash
# 制造一个提交然后 reset 掉
echo "important" > important.txt && git add . && git commit -m "important work"
git reset --hard HEAD~1         # 提交"消失"了
git log --oneline               # 看不到了

# 用 reflog 找回
git reflog                      # 找到那条提交的记录
git branch recovery HEAD@{1}    # 从那个位置创建分支
git switch recovery             # 提交回来了！
```

### 练习 2：bisect 定位 bug
```bash
# 假设最近 10 次提交中某次引入了 bug
git bisect start
git bisect bad HEAD             # 当前有 bug
git bisect good HEAD~10         # 10 次之前是好的
# Git 检出中间的提交，你运行测试
# 如果正常：git bisect good
# 如果有 bug：git bisect bad
# 重复 3-4 次就能定位到具体提交
git bisect reset                # 结束
```

### 练习 3：worktree 并行开发
```bash
# 正在 feature 分支开发，突然要修 main 上的 bug
git worktree add ../termquest-hotfix main
cd ../termquest-hotfix           # 在另一个目录修 bug
# 修完后
cd ../termquest
git worktree remove ../termquest-hotfix
```

### 练习 4：blame 追溯代码
```bash
git blame README.md             # 看每一行是谁什么时候写的
git blame -L 5,15 README.md    # 只看第 5-15 行
```

### 练习 5：添加 submodule
```bash
git submodule add https://github.com/octocat/Hello-World.git libs/hello
git status                      # 看到 .gitmodules 和 libs/hello
git commit -m "add submodule"
# 其他人克隆后需要：
# git submodule update --init --recursive
```
