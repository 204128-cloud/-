# 第九步：新增三个构造故障基准

新增 `extended-v1`，包含端口参数校验、稳定排序和 Unicode 截断三个项目自建案例。它们是开发案例，不是外部真实缺陷、隐藏测试集或模型修复成功记录。原有 `smoke-v1` 两项任务和实测结果保持独立。

## 冻结内容与生成文件

[案例清单](../benchmarks/extended-v1.cases.json) 保存问题、目标测试名、单文件修改授权，以及 18 个快照文件按 UTF-8 / LF 规范化后的 SHA-256。三个目录中的 `CASE.md` 说明来源、完整契约和限制。清单本身不是可直接传给 `bench` 的任务集。

运行离线准备脚本，不需要 API Key：

```powershell
cd D:\项目\RepoPilot
node scripts/prepare-extended-cases.mjs
```

脚本在 `.repopilot/extended-v1/` 生成三个独立 Git 仓库、含本机绝对路径及固定提交的任务 JSON，以及记录任务字节哈希的 `suite.json`。子进程环境不继承模型密钥。Git 身份、提交时间、LF 内容和 SHA-1 对象格式固定，便于换目录或换机器重建相同提交；固定提交时间只是重建元数据，不是实际测试时间。脚本不执行测试或模型请求，不修改全局 Git 配置。

准备脚本可以重复执行。快照不符合冻结哈希、已有仓库变脏、生成文件内容不同时会停止，保留现有文件而不覆盖。需要修改案例时应明确修订版本和哈希，不能把旧评测结果套到新输入上。生成目录和本机路径文件被 Git 忽略，迁移时从快照重新准备。

## 本机基准结果

2026-11-13，三个任务均通过正式 `baseline` 管线，状态为 `ready`。每项均有一个唯一的目标断言失败，以及八项通过的原回归；原仓库无未提交修改，未生成补丁，模型调用数为 0。

| 案例 | 目标缺陷 | 固定提交 | 报告运行 ID |
|---|---|---|---|
| `port-validation` | 把 `3000ms` 等非完整十进制字符串当成端口 | `e509bae11b79d96cc77327e96a4ec4a3188aa200` | `baseline-dP9AfM` |
| `stable-priority-sort` | 同优先级对象被按 ID 重排，破坏输入顺序 | `cfcdc3e50279400d0e926e3d967afc0d2e7434b1` | `baseline-OVhTt6` |
| `truncate-codepoints` | 按 UTF-16 截断主体文本，拆开 emoji 代理对 | `56de2f5e7d099c6a2178f4119fcf37b5888e8f6a` | `baseline-LnjeAE` |

`ready` 只确认修复前提，不代表 `resolved`。总计 3 项目标预期失败、24 项回归通过，不能计为三次模型修复成功。

可以独立重跑每项基准：

```powershell
node src/cli.ts baseline .repopilot/extended-v1/tasks/port-validation.json
node src/cli.ts baseline .repopilot/extended-v1/tasks/stable-priority-sort.json
node src/cli.ts baseline .repopilot/extended-v1/tasks/truncate-codepoints.json
```

在聊天中用 `/runs` 或 `/report baseline-dP9AfM` 查看已有本地报告。重新运行会产生新的运行 ID。本机汇总在 `.repopilot/extended-v1/baseline-summary.json`，迁移不会携带旧运行目录。

## 本轮验证与下一阶段

本轮还验证了：重复准备结果不变；在新的临时项目根目录重建后，三个提交 SHA 完全一致；本机路径和任务集哈希会正确重新生成；修改冻结快照、覆盖任务文件或弄脏案例仓库均被拒绝，并保留被改内容。`npm.cmd run check` 通过。

本节记录的是基准准备阶段，没有把这些案例宣称为未参与开发的独立评测集。后续已加入 `bench-equal` 并在 2026-11-13 完成真实 Qwen 对照：两策略各三项首轮通过，共六次请求尝试、六份独立验收，没有触发失败反馈。基准快照和原仓库仍保留故障版本。[真实对照结果与已验收补丁](EQUAL_BUDGET.md#本机实测)
