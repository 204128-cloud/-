# 第七步：源码定位与上下文选取

本文运行 ID 对应本机历史记录，完整 `.repopilot/runs/` 报告未随仓库分发；公开案例、补丁及新增三案例的结果快照另行保留。

本步增加 `locate <task.json>`，并让 `propose` 复用同一定位流程。任务八个字段与独立验收契约保持不变，`allowedPaths` 仍表示人工明确授权的具体源码集合；定位从中选取相关子集，不扩大修改范围。

## 运行定位

```powershell
cd D:\项目\RepoPilot
npm.cmd run dev -- locate tasks/pagination-empty.json
npm.cmd run dev -- locate tasks/regexp-unicode.json
```

定位不调用模型、不需要 API Key。命令先复用基准执行器创建固定提交的 worktree、准备依赖并实际运行目标和回归测试；依赖准备沿用 `npm ci`，有外部依赖的项目仍可能需要网络。

基准有效后，程序读取授权源码，按问题描述与失败测试名排序并选择完整文件，保存本次 `location.json`。原仓库源码、索引与 HEAD 保持原样。

| 状态 | 含义 | 退出码 |
|---|---|---|
| `located` | 基准有效，已生成符合预算的源码上下文。 | 0 |
| `not_reproduced` | 目标实际执行并通过，没有复现任务缺陷。 | 1 |
| `error` | 基准、读取、定位或完整性检查失败。 | 2 |

`located` 只说明上下文已准备，修复成功仍由独立 `verify` 判断。

## 选择规则与边界

1. 使用 `issue + expectedFailure` 中的去重词，支持英文标识符、camelCase 拆词和中文连续文字的二元词。忽略少量常见英文、代码和扩展名词。只做词法匹配。
2. 每个文件按 `路径命中词数 × 5 + 源码命中词数` 排序；同分按路径字典序，重复词不增加分数。文件路径和源码分别计数，不按源码中出现次数刷分。
3. 只选择有命中的文件，最多 3 个。只有一个授权文件且没有命中时，明确记录 `single_file` 回退；多个文件均无命中时返回 `LOCATION_NO_MATCH`，需要补充具体符号或文件名。
4. 本地授权源码扫描上限为 1 MiB，超限返回 `SCAN_TOO_LARGE`。本地可扫描的文件总量大于模型上下文预算，允许省略体积较大的无关文件。
5. 逐个尝试放入完整文件，JSON 用户消息最多 32 KiB。预算包括问题、测试摘要、路径、源码和 JSON 转义的实际 UTF-8 字节；SDK 的系统提示和工具定义另行提供。最高相关文件自身不能完整放入时返回 `CONTEXT_TOO_LARGE`；其余超预算文件会被省略。

当前不解析调用图、错误堆栈或语义关系。只有中文自然语言且没有能匹配源码的词时，可能需要在问题中补充函数名。本步没有增加向量库、额外模型请求或自动扩大授权范围。

## 提议与验收

原来的模型提议命令继续可用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\项目\RepoPilot\Start-RepoPilot.ps1 propose D:\项目\RepoPilot\tasks\pagination-empty.json
```

`propose` 在同一次运行内准备定位结果，只发送选中的源码及原有问题、测试摘要。模型返回的编辑必须对应选中文件；即使另一个文件也在原始 `allowedPaths` 中，只要未选中，本次模型对它的编辑也会被拒绝。编辑批次在任何写入前整体校验。

提议报告新增 `artifacts.location`，指向同一运行目录的 `location.json`。该文件只包含路径、字节数、匹配计数、分数、选择状态和基准位置，不保存源码、问题原文或命中词。报告中的 `contextBytes` 是实际发送给模型的 JSON 用户消息字节数。

定位完成时及模型返回后仍检查任务原字节、HEAD、完整文件快照、授权源码 Git filter、选中源码的 UTF-8、原始哈希、常规文件身份、真实路径与独立链接数。保护测试和配置的验收逻辑沿用原实现。

候选生成后，审阅 `artifacts.patch`，再用原始任务调用 `verify`。验收器使用原任务授权和独立新建的 worktree，定位报告不替代任何测试或验收条件。

## 本机检查记录

2026-11-10 的两次实际命令均返回 `located`：

| 任务 | 选择文件 | 扫描源码字节 | JSON 上下文字节 | 报告 |
|---|---|---|---|---|
| 分页空数组 | `src/paginate.ts` | 514 | 1891 | location.json（`baseline-kgOhJ5/location.json`） |
| Unicode 连字符 | `src/index.js` | 236 | 1697 | location.json（`baseline-KMj7gA/location.json`） |

两个现有案例各只授权一个文件，用于确认命令兼容性。多文件筛选由独立自动化 fixture 验证：授权集合中包含相关源码与超过 32 KiB 的无关源码，模型回调只收到相关文件，生成的候选经独立验收返回 `resolved`；编辑未选文件的整批提议被拒绝。本地模型回调用于测试宿主行为，该结果不计作新的真实 Qwen 修复。

完整自动化测试、类型检查与构建通过。14 项定位专项测试覆盖排序、中文与 camelCase、完整文件选择、JSON 转义和 UTF-8 预算、扫描上限及无命中处理；7 项提议集成测试覆盖上下文筛选、独立验收和拒绝分支。

可以单独重跑相关检查：

```powershell
node --test test/localization.test.ts test/proposal.test.ts test/cli.test.ts
npm.cmd run check
npm.cmd run build
```
