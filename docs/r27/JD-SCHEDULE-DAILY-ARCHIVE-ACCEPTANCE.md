# R2.7 京东云端长期驻守｜定时与每日历史备份

日期：2026-11-11（北京时间）
仓库：`lijianjun004-star/tcl-live-monitor`

## 真实基线（不得夸大）

- R2.6 在 `main` 真正执行 #42854763283：7 个内部房间，其中 6 LIVE、1 UNKNOWN、0 OFFLINE。
- 源站成功、状态写入成功、Artifact ID `13782840738`（`r24-jd-main-state`），正式分支完整链路通过。
- 本轮初始检查： `schedule` 运行数 **0**。这不代表正式巡检不能运行，但尚不能证明无人值守的定时触发。
- 原状态文件每次保留 7 天；历史 `checks` 仅滚动保留最近 7 天，转移事件最多保留 90 天。单个文件并不是 90 天详细样本。

## 变更

1. Cron 从 `0,5,10,15,30,45,55` 移动到 `2,7,12,17,32,47,57`，避免整点触发高负载。保持每小时 7 个检查机会，关键时段相邻 5 分钟、其余时段相邻间隔 10～15 分钟。北京时间第一计划检查 06:32，夜间 01:57 最后计划检查。**GitHub cron 为 best-effort，不保证严格准时或每次触发。**
2. 继续生成每次 7 天滚动 `r24-jd-main-state`；仅允许恢复同仓库 `main` 发布的历史状态。
3. 每个北京时间自然日仅存一次 `r27-jd-daily-YYYY-MM-DD` 去敏历史检查点，设置 `retention-days: 90`。若当天已有同仓库 MAIN 的有效同名 Artifact 则不重复上传。
4. 每天的检查点含 `r23-state.json` 和 `r23-summary.json`，日归档和滚动检查都不包含凭据、视频或业务敏感报表。
5. 当天首次归档查询失败或第一次归档上传失败，会使巡检 Job 失败（即使源扫描成功也不显示全部绿色），以保留清晰的持久性风险告警。
6. 保留经验证的 R2.3 source SHA `267b6709…`、API 只读、UNKNOWN≠OFFLINE、不部署 Pages。

## 90 天含义与限制

这是 **90 天日检查点留存配置**，不是经 90 天真实运行验证的 SLA。GitHub 公开仓库允许单个 Artifact 设置最多 90 天（如果仓库或组织设置更短上限，上传会失败并在 Actions 中如实显示）。旧 7 天文件不会因本次变更自动变成 90 天。

每天检查点中的 `checks` 是最近 7 天数据窗口，`events` 是最多 90 天的事件窗口；通过多日检查点可核查近 90 天中实际成功归档日的证据。**如果某天完全没触发巡检，不会凭空补回那天的数据**。未来若要求强连续 SLA、业务账户审计及自动补偿，需要另行配置持久数据库、外部调度监控。

## 本次应复验

- PR 全量离线测试及 14 项新增调度/归档门禁。
- MAIN 下一次受控冒烟 `[jd-main-smoke]` 是否成功恢复 R2.6 Artifact `13782840738`（该恢复才是 MAIN→MAIN 跨运行实证）。
- MAIN 是否真正创建当日 `r27-jd-daily-YYYY-MM-DD`，并核实其 `expires_at` 是否接近 90 天。
- 等待**真正的 `event=schedule`** 后再宣称自动定时已验证。
- 真实下播负例、真人数字人分段证据、账号映射、排班仍未达到正式考勤及满播率口径。

GitHub 官方文档：
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
