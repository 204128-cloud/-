# 来源与第三方声明

RepoPilot 基于 [Pi](https://github.com/earendil-works/pi) SDK 构建，模型服务由 Qwen / 阿里云百炼提供。Pi 提供模型适配、基础 Agent 与终端组件；本项目增量包括任务契约、受限源码上下文、编辑校验、人工审阅、独立测试验收与回放、有限反馈和评测编排。开发过程中使用 AI 协作。

当前锁定的 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 版本为 1.5.0，其安装包清单声明 MIT。其他依赖按各自清单与许可证分发；锁文件保留实际依赖版本。

`cases/regexp-unicode/src/index.js` 来自 `escape-string-regexp` 的公开历史故障版本，随附原始 [MIT 许可证](cases/regexp-unicode/LICENSE) 和 [来源、字节哈希与适配说明](cases/regexp-unicode/UPSTREAM.md)。测试、锁文件及任务适配由 RepoPilot 添加。

RepoPilot 自身源码采用 [MIT 许可证](LICENSE)，署名为 204128-cloud。本文件记录来源与依赖，不替代各方原始许可证；第三方原有声明随对应文件保留。
