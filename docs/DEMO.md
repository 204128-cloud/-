# RepoPilot 面试演示

讲解前可用 [120 问面试问答手册](INTERVIEW_QA.md) 练习架构、验收、失败反馈与评测追问。

推荐先用保存的真实 Qwen 补丁做离线演示，再展示历史失败反馈。两种演示都会重跑测试并生成新报告，无需 API Key，也不新增模型请求。

## 推荐：三分钟离线演示

在 RepoPilot 根目录的 PowerShell 中执行。需要 Node.js 22.19.0 或更新版本、npm 和 Git；首次安装依赖运行 `npm.cmd ci --ignore-scripts`。

首次克隆另按 [迁移说明](PUBLISHING.md#新机器启动) 从公开配置模板创建本地配置。下面的离线验收不请求模型。

```powershell
node scripts/prepare-extended-cases.mjs
node src/cli.ts verify .repopilot/extended-v1/tasks/port-validation.json patches/extended-v1/port-validation.qwen.diff
```

准备脚本核对仓库内冻结快照，在忽略目录创建独立案例仓库和任务，换机器也可使用；已有目录必须与原快照一致。验收使用保存的真实模型补丁，不把修复写回原案例仓库。

1. 展示 `cases/port-validation/src/parse-port.js` 中的缺陷：`parseInt` 会接受带尾随字符的端口字符串。
2. 打开 `patches/extended-v1/port-validation.qwen.diff`，展示先检查完整十进制字符串再解析的修改。
3. 执行上述命令，预期退出码 0、`status: "resolved"`；报告显示原目标断言失败、八项回归通过，修改后目标和八项回归全部通过，`integrity.stable` 与 `integrity.replayVerified` 均为 `true`。
4. 打开 [同预算真实结果](EQUAL_BUDGET.md#本机实测) 和 [结果快照](../benchmarks/results/extended-v1-qwen-2026-11-13.json)：三项任务、两条独立策略、六次真实请求尝试。全部首轮通过，没有触发失败反馈，不据此判断策略优劣。

如需展示另外两项，将命令中的任务和补丁文件名同时换成 `stable-priority-sort` 或 `truncate-codepoints`。新验收报告是当前本地重跑证据，保存的结果快照仍是 2026-11-13 的历史实测，两者不要混为一次运行。离线验收也会执行案例测试，因此仍只用于可信仓库。

## 可选：历史 Unicode 缺陷

用同一个 Unicode 连字符缺陷展示独立验收。两份补丁都由 Qwen 在此前的真实运行中生成，分别来自单次提议和两轮反馈。案例来源和许可证随源码保留。[案例说明](REAL_CASE.md) · [两轮运行](REPAIR.md#真实-qwen-两轮实测)

## 本机演示

在 Windows PowerShell 中进入 RepoPilot 根目录，使用 Node.js 22.19.0 或更新版本、npm 和 Git。首次安装依赖时运行 `npm.cmd ci --ignore-scripts`。本机已有演示仓库时，直接运行以下命令。

```powershell
$demoTask = 'tasks/regexp-unicode.json'
node src/cli.ts baseline $demoTask
node src/cli.ts verify $demoTask patches/regexp-unicode.model-attempt-1.diff
node src/cli.ts verify $demoTask patches/regexp-unicode.model-repair.diff
```

三条命令都可以在无 API Key 的环境中执行。第二条的退出码 1 是演示中的预期结果。

| 顺序 | 终端应显示 | 讲解要点 |
|---|---|---|
| 1. 复现 | `baselineStatus: "ready"`，目标断言失败，6 项回归通过 | 先确定同一提交上的故障和正常行为。 |
| 2. 验收失败候选 | `status: "unresolved"`，目标仍失败 | 补丁能应用且只修改授权源码，测试证据仍未满足修复条件。 |
| 3. 验收通过候选 | `status: "resolved"`，目标和 6 项回归全部通过 | 展示 `changedPaths`、`integrity.stable`、`integrity.replayVerified` 和交付补丁。 |

终端的 `reportPath` 指向本次报告。用编辑器打开最终 `report.json`，定位 `before-reproduce`、`after-reproduce` 和 `after-regression`，再打开 `artifacts.patch` 展示改动。用一张架构图讲清模型调用、人工审阅和独立验收之间的边界。[架构说明](ARCHITECTURE.md)

## 换机器复现

在 RepoPilot 根目录执行以下 PowerShell 块。需要可从 PATH 调用的 Git。命令在忽略目录中创建独立仓库和任务副本，使用当前机器生成的真实提交。项目自带的 `cases/regexp-unicode` 包含源码、测试、锁文件和 MIT 许可证。

```powershell
$demoRoot = Join-Path (Get-Location).Path ('.repopilot/demo-' + [guid]::NewGuid().ToString('N'))
$demoRepo = Join-Path $demoRoot 'repo'
New-Item -ItemType Directory -Path $demoRoot -Force | Out-Null
Copy-Item -LiteralPath 'cases/regexp-unicode' -Destination $demoRepo -Recurse -ErrorAction Stop

git -C $demoRepo -c init.templateDir= init --object-format=sha1 --initial-branch=main
if ($LASTEXITCODE -ne 0) { throw 'Git init failed' }
git -C $demoRepo -c core.autocrlf=false add --all
if ($LASTEXITCODE -ne 0) { throw 'Git add failed' }
git -C $demoRepo -c user.name=RepoPilot-Demo -c user.email=demo@example.invalid -c commit.gpgsign=false commit -m 'Freeze Unicode defect fixture'
if ($LASTEXITCODE -ne 0) { throw 'Git commit failed' }
$demoCommit = git -C $demoRepo rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Git rev-parse failed' }

$demoTask = Join-Path $demoRoot 'regexp-unicode.json'
$taskCopy = Get-Content -LiteralPath 'tasks/regexp-unicode.template.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$taskCopy.repoPath = $demoRepo
$taskCopy.baseCommit = $demoCommit
[IO.File]::WriteAllText($demoTask, ($taskCopy | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
```

保留当前终端中的 `$demoTask`，执行前面的三条 `node src/cli.ts …` 命令。路径和提交随机器变化，验收仍针对同一份案例源码和测试。迁移两项任务的完整评测时，按评测说明更新任务集版本及对应哈希。[任务集说明](BENCHMARK.md#固定任务集)

## 有密钥时现场运行

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Start-RepoPilot.ps1 repair $demoTask
```

模型配置指向自己的百炼业务空间。看到密钥提示后复制该空间的完整 API Key，回到终端只按回车。每轮打开补丁审阅，确认后输入 `yes`。一次运行最多尝试 3 个候选。模型输出随请求变化，现场讲解以本次独立验收结果为准。[修复流程](REPAIR.md)

## 展示顺序

1. **约 30 秒。** 说明问题和边界。RepoPilot 基于 Pi SDK 生成候选，宿主在固定提交上独立验收。
2. **约 2 分钟。** 展示一次基准失败，以及两个候选的 `unresolved` 和 `resolved`。重点讲同一个目标测试与回归集合如何约束结论。
3. **约 1 分钟。** 展示两批真实评测的区别。旧两案例共享首候选，共 3 次调用，Unicode 收到字符类回归失败后第二轮通过；新增三案例同预算独立对照，共 6 次请求尝试，两策略都首轮通过，未触发反馈。分开说明流程证据与实验限制。[旧实测](BENCHMARK.md#本机实测) · [独立对照](EQUAL_BUDGET.md#本机实测)
4. **约 30 秒。** 说明个人实现部分。任务契约、源码筛选、补丁审阅、测试证据、交付回放、失败反馈和评测均在 RepoPilot 中编排。[简历及口述稿](RESUME.md)
