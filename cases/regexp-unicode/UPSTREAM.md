# escape-string-regexp：Unicode 连字符缺陷

这是一个真实上游缺陷的最小适配案例，用于验证 RepoPilot 对第二种任务的复用能力。

- 原项目：[sindresorhus/escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp)。
- 问题：[Hyphens in Unicode mode #20](https://github.com/sindresorhus/escape-string-regexp/issues/20)。
- 故障源码提交：`5085b257c801507460270b747f645276fbc1d937`。
- 上游修复：[PR #21](https://github.com/sindresorhus/escape-string-regexp/pull/21)，提交 `732905da074f0220487ad6a27590f89bd0819374`；其父提交就是上述故障提交。
- `src/index.js` 是该故障提交的 `index.js` 原始字节副本，仅改变存放路径；SHA-256：`48b8be4119e6f09b8942c490397fc047da012e0cc223d75a76363856af68fce4`。
- `LICENSE` 是同一提交的 `license` 原始字节副本；SHA-256：`48da2f39e100d4085767e94966b43f4fa95ff6a0698fba57ed460914e35f94a0`。

保留上游 MIT 许可证与作者署名。`package.json`、锁文件、换行约定和 `node:test` 测试由 RepoPilot 添加；未复制上游完整开发环境或声称运行其完整测试集。

复现用例要求转义结果能用于 Unicode 正则并匹配含连字符的原始文本。6 项回归覆盖字符类中的字面连字符、其他元字符、普通文本、空输入、参数类型和重复调用。只允许修改 `src/index.js`。任务问题描述和模型上下文不包含上游修复提交或答案；本文件只供来源审查。

固定源码和测试放在此目录；实际执行仓库在 `.repopilot/cases/regexp-unicode`，使用独立本地提交。该本地提交包含适配测试，不冒充上游提交。
