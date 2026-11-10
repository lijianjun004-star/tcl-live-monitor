# R2.7 京东正式 MAIN 第二轮状态恢复复验

## 当前真实基线
- MAIN SHA: `b5cc0fd3653b9ce90e019ff8dbb45a21b56aa978`。
- MAIN 首次只读巡检：Actions `42854763283`，7 个内部房间，6 LIVE/1 UNKNOWN/0 OFFLINE。
- 首次 MAIN 状态 Artifact：`13782840738`，名称 `r24-jd-main-state`，保留 7 天。
- 截止本轮第一次检索：真正的 `schedule` 自动事件为 0，不能用受控 push 替代。

## 本轮目标
在仅有一份 MAIN Artifact 存在的情况下，让新一次受控 `main` 执行恢复前次状态，并由真实 GitHub Actions 日志打印：
- 源 Artifact 仅来自 `main`、同仓库且尚未过期。
- `last_processed_run` 必须存在且可验证；期望为 `42854763283.1`。
- 前次已保存的状态完整通过 `validateState`，不得用结构不完整的历史假装成功。
- 完整报告记录当前 `run_id`、上次 `run_id`、来源有效性、每轮 7 房状态、Checks/Events 累计及新 Artifact。
- 若解压、验证、源站/状态上传任何一步失败，Job 必须明确失败且 UNKNOWN 不被判为停播。

## 变更范围
- 仅修改 `.github/workflows/jd-r23-scheduled.yml` 的历史恢复校验与审计摘要。
- 新增 `tests/r27-jd-main-restore.test.mjs` 防回退测试及独立纯离线 CI 工作流。
- 不变更现有 7 天状态滚动时间、cron 频率、只读权限、检测器 SHA、Pages 文件或练播房仓库。
- **本 PR 在 CI 通过后，才可带 `[jd-main-smoke]` 合并一次，触发 MAIN 只读复验。**

## 90 天存储设计边界
不能把所有约 7 次/小时的运行 Artifact 直接保留 90 天，否则文件数量和滚动内容量可能导致共享免费存储额度耗尽。当前阶段保留 7 天热状态，将进一步独立设计：
1. 每日低频归档，保留 90 天（精简去敏状态/事件、链式校验）。
2. 遇 scheduler 漏跑或无更新时的缺样告警。
3. 账户用量与仓库设置复核，确认不额外计费。
4. 模拟 8 天停巡后的冷启动恢复。

GitHub 当前规则：公开仓库 Artifact 留存期 1～90 天，但仓库配置可能限制上限；超过配额/手动删除不保证历史一定存在。
请参考：https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository

## 尚未通过
- `schedule` 真正自动触发及连续两个定时周期
- 公共京东账号身份映射完整性
- 独立可信 OFFLINE 负例
- 90 天可靠持久留存及正式满播率

只有 Actions 真实 run + artifact 的组合才标记跨运行 PASS；离线测试成功不代替真实运行。
