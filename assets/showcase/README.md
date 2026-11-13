# RepoPilot 界面展示

这些图片来自当前 RepoPilot 程序实际渲染的终端画面：生产版 `runChatTui` 和 Pi SDK 运行在终端模拟器中，截取 ANSI 渲染后的单元格，再按字体与颜色输出 PNG。它们是界面渲染快照，未拍摄用户桌面。

模型服务使用本机 HTTP 模拟，回复包含“本地演示”标识。候选复用公开的已验收端口补丁；任务确认、完整补丁预览、独立测试验收、补丁回放和历史报告读取均走实际程序流程。本次没有调用真实百炼，图片附件仅在本地读取并展示待发送状态，不能把这些画面当作新的真实识图或模型修复成绩。

| 文件 | 展示内容 |
|---|---|
| [01-welcome.png](01-welcome.png) | 居中 Logo、介绍和固定多行输入区 |
| [02-image-chat.png](02-image-chat.png) | 本地演示回复、附件名称/格式/大小及清除提示 |
| [03-patch-review.png](03-patch-review.png) | 实际候选哈希、完整彩色 diff 和确认提示 |
| [04-verification.png](04-verification.png) | 真实目标测试与八项回归结果、独立验收和报告引用 |

复现独立验收可按 [离线演示](../../docs/DEMO.md) 操作；实际百炼和窗口操作按 [检查指南](../../docs/TESTING.md) 验证。终端尺寸为 128 列、42 行，PNG 尺寸为 1408 × 924；字体使用 Consolas 与 Microsoft YaHei UI。环境与文件哈希见 [生成记录](provenance.json)。
