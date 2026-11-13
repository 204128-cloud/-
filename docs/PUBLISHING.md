# 发布前检查

公开文件和迁移验证已完成，项目所有者选择 MIT，并确认目标仓库为 [204128-cloud/-](https://github.com/204128-cloud/-)。发布提交沿用远程 main 分支的初始化历史。

## 本机文件与公开模板

| 本机保留、Git 忽略 | 随项目提供 |
|---|---|
| `config/models.json`：本机百炼业务空间接口 | `config/models.example.json`：无效域名占位、环境变量引用和模型配置 |
| `tasks/*.json`（模板除外）：任务向导与历史任务保存的机器路径、提交和问题 | `tasks/*.template.json`：仓库路径与提交占位符 |
| `benchmarks/smoke.json`：绑定旧本机任务字节的历史任务集 | 构造案例清单、结果快照与 `scripts/prepare-extended-cases.mjs` |
| `.repopilot/`、`.env`、`.env.*`、认证存储、依赖和构建产物 | 源码、测试、锁文件、原始案例许可证和交付补丁 |

本机配置和旧运行任务保留原文件。测试中的凭据样式字符串使用明显的 `LOCAL_FAKE` 标记，图片路径示例使用演示用户。旧实验的指标与哈希保持原记录。

## 新机器启动

在克隆目录的 PowerShell 执行；项目需要已安装的 Node.js、npm 和 Git。

```powershell
if (-not (Test-Path -LiteralPath config/models.json)) { Copy-Item -LiteralPath config/models.example.json -Destination config/models.json }
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
npm.cmd run build
node dist/cli.js check
node scripts/prepare-extended-cases.mjs
node dist/cli.js verify .repopilot/extended-v1/tasks/port-validation.json patches/extended-v1/port-validation.qwen.diff
```

配置模板的 `.example.invalid` 地址仅供离线加载。真实调用前，把本地 `config/models.json` 中的 `baseUrl` 替换为百炼控制台提供的北京业务空间 OpenAI 兼容地址，密钥继续通过启动器在终端提供。环境变量引用保留，不把密钥写入 JSON。

`prepare-extended-cases.mjs` 生成新机器上的真实路径、提交和任务哈希。自己的仓库用 `task init` 创建任务。历史 Unicode 案例按 [迁移演示](DEMO.md#换机器复现) 从模板生成；迁移旧两案例评测需要为新任务字节建立新任务集，不复用旧 `smoke.json` 哈希。

## 当前发布决定

- 已隔离带业务空间地址的配置和机器绑定的历史任务；公开模板不包含真实接口或密钥。
- 公开文档中的 `D:\项目\RepoPilot` 是使用示例路径，安装位置不同时替换为实际克隆目录。运行任务应由准备脚本或向导生成。
- 保留 Pi SDK 来源、AI 协作说明及上游案例许可证，见 [来源声明](../NOTICE.md)。
- 根目录采用 [MIT](../LICENSE)，项目署名为 204128-cloud，第三方原有声明保留。
- 目标为 `https://github.com/204128-cloud/-` 的 main 分支。远程原有一个 README 初始化提交，沿用其历史并更新项目内容。四张终端展示快照的来源见 [展示说明](../assets/showcase/README.md)。

## 本次检查结果

- 首轮检查的 Git 待提交范围为 153 个文件；加入展示材料后为 159 个文件，凭据样式、私人业务空间地址、个人用户名路径及本地文档链接复查通过。密钥样式测试数据均明确标记为虚构值。
- 14 处指向未发布本机报告的 Markdown 链接改为历史运行引用，保留旧实验事实。
- 用待提交文件单独建立目录，从公开配置模板创建本地配置，完成安装、类型检查、构建、完整测试、离线配置加载、案例准备和补丁验收，共七个阶段。
- 独立目录完整回归 **343 项通过、零失败**；离线补丁验收 `resolved`，完整性与补丁回放通过。源码及测试与工作目录一致，未调用真实百炼。
- 现有本机配置仍能通过离线加载检查。发布范围排除实际模型配置、运行任务和本机日志；MIT 许可信息已同步到包清单。

本机证据为 `.repopilot/publish-preflight-result.json`、`publish-migration-tests.txt` 和 `publish-final-scan.json`，这些文件不随项目提交。安装和演示按本页步骤进行，真实服务与终端体验仍按检查指南核对。
