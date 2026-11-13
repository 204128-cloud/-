# RepoPilot 逐步功能检查

按顺序验收，先完成无需密钥的部分，再做真实百炼调用。每条 PowerShell 命令单独粘贴并执行，上一条结束后再执行下一条；看到 `>>` 表示命令尚未闭合，按 Ctrl+C 取消后重新复制完整命令。

## 1. 安装、类型检查、回归和构建

在 PowerShell 中执行：

```powershell
cd D:\项目\RepoPilot
node --version
npm.cmd --version
if (-not (Test-Path -LiteralPath config/models.json)) { Copy-Item -LiteralPath config/models.example.json -Destination config/models.json }
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
npm.cmd run build
node dist/cli.js --help
node dist/cli.js check
```

已有依赖时可以跳过 `npm.cmd ci`。当前完整自动化回归为 **343 项**，可能需要数分钟。通过标准：安装、类型检查、测试和构建退出码均为 0；测试汇总 `pass 343`、`fail 0`；编译后的帮助列出实际命令，`check` 输出 `sdk_configuration_check`。可在任一命令结束后立即运行 `$LASTEXITCODE` 查看它的退出码。

`check` 不调用模型。`credential: missing` 表示当前终端没有加载密钥；离线检查可以继续。`present` 也不表示已通过服务端鉴权。

## 2. 准备可重复的故障案例

```powershell
node scripts/prepare-extended-cases.mjs
$task = 'D:\项目\RepoPilot\.repopilot\extended-v1\tasks\port-validation.json'
$patch = 'D:\项目\RepoPilot\patches\extended-v1\port-validation.qwen.diff'
```

通过标准：输出 `kind: constructed_cases_prepared`、`modelRequests: 0`，列出端口校验、稳定排序、Unicode 截断三项任务。脚本建立独立的故障仓库，不修改你的业务仓库。

再次执行准备命令仍应成功。若报告已有文件或仓库变化，先检查对应文件；脚本会拒绝覆盖有差异的内容。

## 3. 检查基准、定位和独立验收

```powershell
node src/cli.ts baseline $task
node src/cli.ts locate $task
node src/cli.ts verify $task $patch
```

| 命令 | 通过标准 |
|---|---|
| `baseline` | `baselineStatus: ready`；修复前目标断言失败、八项回归通过。这表示复现成功。 |
| `locate` | `status: located`；`selectedPaths` 包含 `src/parse-port.js`；`contextBytes` 不超过 32768。 |
| `verify` | `status: resolved`、退出码 0；修复后目标和八项回归全过，`integrity.stable`、`integrity.replayVerified` 都为 `true`。 |

复制最后输出的 `reportPath`，在编辑器打开。核对 `before-reproduce`、`before-regression`、`after-reproduce`、`after-regression` 四阶段和 `artifacts.patch`。仅有补丁文件不代表修复成功。

还可验证编译入口：

```powershell
node dist/cli.js verify $task $patch
```

另外两项任务可重复上述步骤，同时把任务和补丁文件名换成 `stable-priority-sort` 或 `truncate-codepoints`。这些步骤不调用模型，但会执行可信案例的测试并准备 npm 依赖。原案例始终保留故障版本，因此可以重复验证。

## 4. 检查任务创建向导

```powershell
node src/cli.ts task init 'D:\项目\RepoPilot\.repopilot\extended-v1\repos\port-validation'
```

按提示操作：任务编号填 `manual-port-check`；问题填“端口字符串包含非数字尾缀时应拒绝”；复现选择 `test:reproduce`，回归选择 `test:regression`；失败测试名从原任务 JSON 的 `expectedFailure` 复制；授权选择 `src/parse-port.js`。输出路径使用向导默认值，确认后可选择基准预检。

通过标准：保存前先展示摘要并要求 `yes`；输出 `status: created`；选择预检时返回 `baselineStatus: ready`。再次使用同一个输出文件名应提示另选路径，不覆盖已存在的任务。若只想检查取消行为，在保存确认时输入 `no`，预期 `cancelled` 且不创建任务文件。

## 5. 启动真实终端界面

在同一 PowerShell 中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\项目\RepoPilot\Start-RepoPilot.ps1' tui
```

出现密钥提示后，从百炼控制台复制此前通过鉴权的完整业务空间 API Key，回到终端只按回车，不粘贴。密钥仅在本机提供；聊天框不接收密钥。若当前终端已设置有效的 `DASHSCOPE_API_KEY`，启动器会直接使用已有值。

先逐项输入以下本地命令：

| 操作 | 通过标准 |
|---|---|
| 启动 | Logo、欢迎语和介绍出现，多行输入区可用；终端无需另外打开欢迎页。 |
| `/help` | 显示命令；记录增加后欢迎内容能随聊天向上滚动。 |
| `/status` | 显示加载的模型、脱敏接口和任务状态，不发模型请求。 |
| `/doctor` | 显示离线诊断；未绑定任务会说明可继续普通对话。 |
| `/runs` | 列出历史运行，或明确显示暂无记录。 |
| `/report <运行ID>` | 使用 `/runs` 中的真实 ID，显示对应历史结论及产物位置。 |
| 输入 `/report nonexistent` | 提示提供历史列表中的完整运行编号，随后仍可正常输入。 |

复制检查：用鼠标选中一段回复文字，按 Ctrl+C，再到记事本或编辑器按 Ctrl+V，核对中文和换行。未选中文字时按 Ctrl+C 也应保持当前界面、请求与消息选择框。全屏 `tui` 使用 Ctrl+Q 退出，`/exit` 仍可使用；本节不要用 Ctrl+C 退出。PowerShell 和逐行 `chat` 的中断按键保持原行为。

## 6. 检查真实连接、对话和取消

仍在聊天界面内操作：

1. 输入 `/auth-check`，先输入 `no`：应取消且不联网。再输入 `/auth-check` 并确认 `yes`：应显示本次 HTTP 状态，正常为 `HTTP 200`、请求被接受。它只验证固定文本请求。
2. 问“请记住暗号是蓝色灯塔，只回复收到”，再问“刚才的暗号是什么”：应能根据上一轮回答。
3. 用 Shift+Enter 输入多行问题；Enter 提交：应作为一条消息发送，回复逐步显示。Ctrl+J 应无动作，多行粘贴仍保留原有换行。
4. 在回复生成期间编辑下一条问题并按 Enter：应出现“排队发送 / 引导当前回答”。默认选中排队，←/→ 或 Tab 切换，Enter 确认。按 Esc 返回编辑，草稿应保留且当前回复继续生成。
5. 要求生成一段较长说明，在尚未完成时按 Esc：应显示中断状态，并能继续问新问题。服务回复太快时，可能来不及触发该检查。

本节会调用真实百炼，产生相应用量。若鉴权失败，先核对业务空间兼容地址、密钥及模型权限；此时不要继续修复评测。

分别检查两种选择：

- **排队**：发送一个长问题，在生成中提交“接下来解释事件循环”，选择“排队发送”。当前回复继续显示，结束后新问题自动发送一次。可继续排队第三条，检查顺序和状态栏队列数量。
- **引导**：重新发送一个长问题，在生成中提交“请保留原问题，但用初学者能理解的方式简短解释”，选择“引导当前回答”。预期旧回复停止并标记已中断，新回复应结合原问题和新要求；这是新的模型请求。
- **暂停与清空**：存在待发消息时，在选择框外按 Esc。预期当前请求停止，队列暂停；输入 `/queue` 可查看，`/queue resume` 继续发送，或 `/queue clear` 清空。退出、`/reset`、成功恢复会话也会清空队列。

排队图片读取失败或模型请求失败时也应暂停队列，保留后续消息，等待你处理或清空；不能继续悄悄把后面的图片问题作为无图请求发送。

若当前回答恰好在选择框打开后结束，仍须确认才发送新消息，不应提前自动发送。任务操作确认和补丁审阅继续按原 yes/no 提示处理。以上队列功能在 `tui` 界面测试。

如需单独检查 SDK 的固定文本和只读工具，在聊天中 `/exit` 后运行下面的可选命令。正常输出 `status: passed`，`text.toolCalls: 0`、`readTool.toolCalls: 1`，结果 JSON 可单独解析；记录路径显示在提示流中。它会额外调用模型：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\项目\RepoPilot\Start-RepoPilot.ps1' smoke
```

再次启动 `tui` 后继续后面的检查。逐行聊天入口也可把启动命令的 `tui` 换成 `chat`；它使用同一个聊天引擎，完整回复一次显示，不提供全屏界面。

## 7. 检查图片和会话

现在也支持把路径和问题放在同一条消息中，例如 `"D:\项目\RepoPilot\assets\logo.png"描述一下这张图片`。预期界面显示“你 · 附图片”，模型收到真实图片内容和问题，不接收本地路径。只输入加引号的图片路径时，应显示“图片已就绪”，等待下一条问题。修改程序后需退出并重新启动聊天，已打开的进程不会自动加载更新。

在聊天中先使用项目自带的 Logo，也可以换成自己的本地 PNG、JPEG 或 WebP，文件不超过 5 MiB：

```text
/image "D:\项目\RepoPilot\assets\logo.png"
/image
请描述图片里的主要内容。
把刚才的回答翻译成英文。
/save
/sessions
```

通过标准：附图后显示文件名、格式和大小；查看附件不调用模型；问图时能识别可核对内容，追问保留上一轮上下文；保存后返回新的会话 ID。

继续检查：

- 再附图后输入 `/image clear`，应只移除待发送附件；文字对话仍在。
- 输入 `/image "D:\不存在的图片.png"`，应显示读取失败、当前没有待发送图片，聊天仍可用。
- 输入 `/reset`，应清空当前对话和附件，欢迎内容重新出现。
- 输入 `/resume <刚才的会话ID>`，先拒绝再重新确认：拒绝时保留当前对话，确认后恢复文字；图片原始数据不会恢复，需要重新附图。
- 恢复后追问保存过的内容，应使用恢复的文字上下文。绑定任务的会话须用同一份任务 JSON 启动后恢复。

## 8. 检查一次真实修复闭环

先在当前聊天输入 `/exit`，确认回到正常 PowerShell。使用第二步准备的 `$task`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\项目\RepoPilot\Start-RepoPilot.ps1' repair $task
```

按提示在本机提供密钥。候选出现后，打开提示中的补丁文件审阅；确认只修改授权源码且内容合理，再在原终端输入 `yes`。不要只凭模型说“修复了”判断通过。

通过标准：最终为 `resolved`，报告包含独立验收与交付补丁；目标、原回归、完整性与回放通过。若合法候选未通过测试，可进入下一轮，最多三轮；模型输出有随机性，`unresolved` 也是实际验收结果，需要查看失败证据，而不是直接认定程序坏了。

只想单独检查候选生成入口时，可将 `repair` 改成 `propose`。预期 `status: proposed`，按返回的 `artifacts.patch` 打开候选，再手动运行 `verify`；`proposed` 不代表修复成功。该操作会额外调用模型，完整 `repair` 已经包含生成和审阅流程，无须每次都重复。

如需检查聊天工具联动，用以下命令启动后说“帮我定位这个任务”，再说“请修复这项任务”：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\项目\RepoPilot\Start-RepoPilot.ps1' tui $task
```

宿主应分别要求任务操作确认和候选补丁审阅。TUI 展示完整彩色 diff；拒绝时保留候选并停止，确认后才独立验收，报告路径显示在聊天中。工具是否被提出由模型决定；直接 `repair` 命令可以单独验证修复管线。

## 9. 可选：完整评测

前八步通过后再按需执行；这会重复消耗模型调用，不是日常启动必做步骤：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File 'D:\项目\RepoPilot\Start-RepoPilot.ps1' bench-equal 'D:\项目\RepoPilot\.repopilot\extended-v1\suite.json'
```

三项任务、两条独立策略，每条策略最多三轮，整次上限 18 次模型请求尝试。每个候选分别审阅确认。最终查看 `benchmark.json`、`benchmark.md` 和各独立验收报告，核对两臂实际尝试之和。`completed` 表示评测完整完成，可以包含未修复任务；结果不能保证与历史六次首轮通过相同。

## 记录结果

每项记“通过 / 失败 / 未测”，附运行 ID、预期结果、实际结果和可复现步骤。报错截图不要包含密钥。HTTP 鉴权通过、模拟服务通过、历史报告通过和本次真实修复通过应分别记录。自动化与本轮检查结论见 [功能检查记录](AUDIT.md)。
