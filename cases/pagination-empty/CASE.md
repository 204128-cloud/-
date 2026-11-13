# 分页空数组案例

这是本项目构造的合成缺陷，用于基准管线、独立验收与配对冒烟评测，不作为真实外部项目缺陷计数。

`package.json`、`package-lock.json`、`.gitignore`、`src/paginate.ts` 和两个 `test/paginate.*.test.ts` 从本机演示仓库固定提交 `4fdfba1abf23e43d3d5b20997b88c7d43790dec4` 导出；导出使用 Git 提交内容，未复制 `.git`、依赖目录或未提交文件。

故障为 `paginate([], 1, 10)` 返回 `totalPages=1`，目标要求为 0；另有 6 项回归保护非空分页和参数校验。本机正式任务在 `tasks/pagination-empty.json`，迁移时可将此目录复制到新的独立仓库，提交后更新正式任务的仓库路径及实际提交，再更新评测任务集版本与哈希。
