# 第三步：不调用模型的基准执行管线

`baseline` 验证一个固定提交是否能可靠复现约定缺陷，作为后续修复的起点。它不会调用模型、修改源码或生成修复补丁。

## 运行演示任务

```powershell
cd D:\项目\RepoPilot
npm.cmd run dev -- baseline D:\项目\RepoPilot\tasks\pagination-empty.json
```

演示仓库位于 `D:\项目\RepoPilot-demo`，故障基准提交为 `4fdfba1abf23e43d3d5b20997b88c7d43790dec4`。其中 `paginate([], 1, 10)` 错误地返回 `totalPages=1`。复现集合包含一个针对该行为的断言，回归集合包含六个原有行为测试。正式任务保存真实绝对路径和提交号，模板继续保留明确占位符。

执行器按顺序：

1. 使用现有 JSON Schema 验证任务，再检查源码路径、仓库根目录和真实 SHA-1 提交。
2. 创建独立 detached worktree，核对实际 HEAD；原仓库的 HEAD、索引和未提交内容不纳入本次执行。
3. 在工作副本执行 `npm ci --ignore-scripts --no-audit --no-fund`。
4. 执行指定的两个 npm scripts；通过宿主控制的 `NODE_OPTIONS` 注入 node:test reporter，保存测试文件、完整名称、结果和断言失败标志。每阶段使用独占写入标记，拒绝多个测试进程覆盖同一份证据。
5. 检查测试没有修改基准文件，并结合真实退出码和结构化用例证据判断基准。

## 报告与状态

每次运行创建独立的 `.repopilot/runs/baseline-*/`：

```text
baseline.json     # 本次基准报告
logs/             # 实际命令摘要和测试 JSONL 证据
worktree/         # 实际执行的固定提交副本，保留供审查
```

`baseline.json` 使用 `kind: "baseline_check"` 和 `baselineStatus`：

| 状态 | 含义 | CLI 退出码 |
|---|---|---|
| `ready` | 目标名称唯一、目标确实断言失败，原回归集合非空且全部通过，可以开始修复。 | 0 |
| `not_reproduced` | 目标确实执行并通过，没有复现约定缺陷。 | 1 |
| `error` | 输入、依赖、测试执行、基准完整性或证据不满足前提。 | 2 |

跳过、TODO、零测试、缺失或重名的目标、导入或 hook 故障、非断言异常、截断结果和退出码不一致，均不能得到 `ready`。测试名称来自事件记录，嵌套名称使用 `父名称 > 子名称`。不从控制台文案猜测测试成功。

基准报告不是任务修复报告，不使用任务契约的四种修复终态。此时补丁为 null；`ready` 不等于 `resolved`。

## 当前支持范围

- 可信本地 SHA-1 Git 仓库；只支持当前 Node 安装目录中带有 npm 的 Windows 环境。
- Git 先从 PATH 查找，再检查 Windows 常规安装目录和项目 `.repopilot/tools/git/cmd/git.exe`。后续执行使用绝对路径，因此已准备项目本地 Git 时无需修改系统 PATH 或重启终端。未找到报 `GIT_NOT_FOUND`，找到但不能启动报 `GIT_EXECUTION_FAILED`。
- 任务允许修改范围限于 `src/` 下已提交的具体 JS/TS 常规源码文件，拒绝测试、配置、重复路径和符号链接越界。
- 仓库根目录须有 `package.json` 和已提交的 `package-lock.json`；两个 npm scripts 使用 Node 自带的 `node:test`。当前演示不需要第三方依赖。
- 每个脚本只允许一次 `node --test` 调用，可以在该调用中运行多个测试文件；多个独立调用不合并，报告证据错误。依赖准备后及基准测试后会拒绝工作副本外部、断开或无法解析的链接。
- 安装脚本和 npm pre/post 生命周期脚本不执行；两个指定测试脚本本身会执行。依赖安装若需要被禁用的构建步骤，将报告错误。
- 子进程只获得运行所需环境变量白名单，不继承模型密钥；不保存标准输出、标准错误、原始异常或断言实际值。日志保存命令、退出码、字节计数及受限的用例证据。
- 每条命令超时 120 秒；中断和超时不保留伪造退出码。Windows 使用进程树终止，POSIX 进程组分支尚未在当前环境验收。worktree 用于隔离文件修改，不是执行不可信代码的安全沙箱。
- 本次工作副本和证据保留，不自动删除用户仓库或旧运行。`propose` 可生成单次模型候选，独立补丁验收见 `docs/VERIFY.md`；真实上游缺陷案例见 `docs/REAL_CASE.md`。

第三步的 ready 只确认修复前提；第四步使用 `verify <task.json> <patch.diff>` 独立验收候选补丁，具体行为见 `docs/VERIFY.md`。

## 本机项目 Git

当前本机使用的备用 Git 位于 `.repopilot/tools/git/`，来自 [Git for Windows 官方 MinGit 2.56.0.windows.4 发布包](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.4)。下载文件为 `MinGit-2.56.0.4-64-bit.zip`，已与发布页 SHA-256 `e3bf78351fe777fba47ddee5950082f8a98bb0f02604fdc7ba3ee2cb68ffa877` 核对一致。二进制、许可证和下载包保存在忽略目录，不提交到源码仓库。

换到新机器时可正常安装 [Git for Windows](https://git-scm.com/install/windows)，或把官方 MinGit 解压到同一项目相对目录，使 `cmd/git.exe` 存在。程序不会自动下载安装工具。
