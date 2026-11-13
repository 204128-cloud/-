# 第六步：真实上游缺陷案例

本文运行 ID 对应本机历史记录，完整 `.repopilot/runs/` 报告未随仓库分发；公开案例、补丁及新增三案例的结果快照另行保留。

本步复用现有命令加入第二个案例，不修改 Agent、任务契约或验收器。目标是验证同一流程能接入不同源码与缺陷，并保留模型失败的实际证据。

## 来源和适配范围

案例源自 [escape-string-regexp issue #20](https://github.com/sindresorhus/escape-string-regexp/issues/20)：包含连字符的文本经转义后，用于 Unicode 正则会抛出 `Invalid escape`。上游通过 [PR #21](https://github.com/sindresorhus/escape-string-regexp/pull/21) 修复。

| 内容 | 固定版本或位置 |
|---|---|
| 上游故障提交 | `5085b257c801507460270b747f645276fbc1d937` |
| 上游参考修复提交 | `732905da074f0220487ad6a27590f89bd0819374` |
| 本项目案例文件 | `cases/regexp-unicode/` |
| 本机执行仓库 | `.repopilot/cases/regexp-unicode/` |
| 包含适配测试的本地基准提交 | `fcaf200e543842da63563973504e316af11604ba` |
| 正式任务 | `tasks/regexp-unicode.json` |
| 唯一允许修改的文件 | `src/index.js` |

故障源码和 MIT 许可证按原始字节保留，SHA-256 记录在 [UPSTREAM.md](../cases/regexp-unicode/UPSTREAM.md)。源码 Git blob 与上游一致：`58217a4efa3c835c532499a3dad887017dc70a6b`；参考修复源码 blob 为 `e5bb9db7933b7230327c7d99cc8459575f090dd4`。本地基准提交包含本项目添加的测试与零依赖 npm 配置，因此与上游提交不同。

测试使用 `node:test` 适配现有证据采集方式，未运行上游完整开发环境与测试集。历史公开问题可能出现在模型训练数据中，此案例用于流程验证，不作为无污染评测或成功率依据。

## 验收条件

目标测试检查 `-`、`a-b`、`--`、`foo - bar` 的转义结果能用于 Unicode 正则，并完整匹配原始文本。构造正则放在 `assert.doesNotThrow` 中，保证故障基准是断言失败。

6 项回归分别保护：非 Unicode 字符类中的字面连字符、其他正则元字符、普通文本、空输入、非法输入的 TypeError 和重复调用。字符类测试要求转义后的 `a-z` 匹配 `-` 且不匹配 `m`，防止通过删除连字符转义引入范围匹配。

模型只接收问题描述、基准测试身份与结果、允许的故障源码。本项目未向模型提供参考补丁或来源文档中的修复链接。

## 实际结果

2026-11-10 在本机运行：

| 输入 | 修改前目标 / 回归 | 修改后目标 / 回归 | 正式结果 |
|---|---|---|---|
| 纯基准 | 1 项断言失败 / 6 项通过 | 未执行 | `ready` |
| 真实 Qwen 首次候选 | 1 项断言失败 / 6 项通过 | 1 项断言失败 / 6 项通过 | `unresolved` |
| 上游参考修复 | 1 项断言失败 / 6 项通过 | 1 项通过 / 6 项通过 | `resolved` |

Qwen 候选只在匹配字符集合中增加了 `/`，保留了导致问题的连字符转义。该候选范围合法、文件快照稳定、补丁回放一致，但目标测试仍失败，验收器按测试证据拒绝修复结论。候选原样复制到 `patches/regexp-unicode.model-attempt-1.diff`，没有人工代改。

随后将上游参考修复只映射到本地 `src/index.js`，独立验收全部通过。参考补丁明确标记为 `patches/regexp-unicode.reference.diff`，不计作模型修复结果。本步共发起一次真实模型提议，未自动重试。

后续第八步已用新的 `repair` 运行完成真实 Qwen 两轮修复：首轮删除转义导致字符类回归失败；加入该实际反馈后，第二轮使用 `\\x2d` 转义连字符，目标与 6 项回归全部通过。该运行与本节第六步的单次失败记录分别保留，见 [两轮实测与模型交付补丁](REPAIR.md#真实-qwen-两轮实测)。

本地记录保存在 Git 忽略目录，可点击查看：

- 基准报告（`baseline-bVRVfw/baseline.json`）。
- 真实模型提议（`baseline-HTTVIa/proposal.json`）。
- 模型候选的独立失败报告（`baseline-ksWVfH/report.json`）。
- 参考补丁的独立通过报告（`baseline-naxLwN/report.json`）。

原始执行仓库仍处于干净故障基准。参考修复只应用于独立工作副本。

## 本机复现

以下命令不需要 API Key：

```powershell
cd D:\项目\RepoPilot
npm.cmd run dev -- baseline tasks/regexp-unicode.json
npm.cmd run dev -- verify tasks/regexp-unicode.json patches/regexp-unicode.reference.diff
npm.cmd run dev -- verify tasks/regexp-unicode.json patches/regexp-unicode.model-attempt-1.diff
```

预期依次为 `ready`、`resolved` / 退出码 0、`unresolved` / 退出码 1。每次都会重新执行基准和验收，生成新报告；保留的稳定错误补丁不等于修复成功。

需要新生成一次模型候选时：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\项目\RepoPilot\Start-RepoPilot.ps1 propose D:\项目\RepoPilot\tasks\regexp-unicode.json
```

提示出现后复制同一业务空间的 API Key，只按回车。审阅输出中的 `artifacts.patch`，然后用 `verify` 验收该实际路径。新的模型结果可能不同，应以新的正式报告为准。

## 迁移案例

`cases/regexp-unicode/` 是可保留的完整案例文件，运行仓库和本地报告不提交。在新机器或运行仓库缺失时，复制该目录到一个新的独立目录；初始化 SHA-1 Git 仓库并提交全部案例文件，再将实际绝对路径与 `git rev-parse HEAD` 写入任务的 `repoPath` 和 `baseCommit`。每台机器新建的本地提交可能不同，不应沿用不存在的提交号。不要覆盖现有仓库。

该案例不需要第三方依赖，锁文件已保留；执行器会在每次 worktree 中准备依赖并运行测试。上游出处、许可证和固定源码哈希随案例保留。
