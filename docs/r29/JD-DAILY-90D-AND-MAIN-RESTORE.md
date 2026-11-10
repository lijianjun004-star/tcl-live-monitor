# 京东 R2.9｜正式主分支长期驻守改造与验收

基线（2026-11-11，北京时间）：
- R2.6 MAIN 首次真实巡检 #42854763283 成功，7 房间（6 LIVE/1 UNKNOWN）。
- R2.7 MAIN 二次巡检 #42857860163 **失败**，原因：Shell here-document EOF 语法错误；此前不应称为已恢复完成。
- 热修复后 MAIN #42858497130 **成功**：restore`42854763283.1`，历史 checks 7→14，events 仍7；新滚动 Artifact ID `13784521383`。
- 本次初始查询自动 `schedule` 为 0 次，尚未证实定时器真实自动触发。

## 本 PR 的安全改动

**建立在热修复后的 MAIN SHA `78d7adf769e97562ce6553a7c221e4578bd25970` 上**，不是从旧 R2.7 PR 覆盖 MAIN。保留修复后的 `node --input-type=module -e`，避免重复引入 Bash heredoc EOF 问题。

- GitHub `schedule` 改为 `2,7,12,17,32,47,57 * * * *`，避开整点高峰（北京时间理论窗口 06:32 ～ 01:57，仍可按设置操作时间范围进入）；实际云端调度可能延迟或丢失，不承诺严格 5/15 分钟 SLA。
- 每次自动巡检照常上传隔离的 `r24-jd-main-state`，7 天滚动保留供下一次恢复。
- 每个北京时间自然日只上传一次 `r27-jd-daily-YYYY-MM-DD`，保留 `r23-state.json`、`r23-summary.json`（只包含去敏观察）。申请 `retention-days:90`，并用 MAIN 同仓库来源条件防止错误复用。
- 当天已经有主分支的日归档，就不重复上传；若新日归档查询/上传失败，标记 Job 失败。
- `UNKNOWN` 依旧不能计入 OFFLINE，暂不生成准确开播/下播时间，不生成正式开播率、满播率或不中断时长。
- 本 PR 不修改 Pages、主播练播房、历史状态算法、源站 URL、账号凭据或 3 平台范围。

## 验收标准

1. 审核 PR diff + CI（必须通过 R2.3 237 旧测试、R2.4/R2.6/R2.7 各安全门禁及本轮 14 个新增日归档测试）。
2. 以一次 **明确带 `[jd-main-smoke]` 的 MAIN 提交**启动当前只读源站巡检，检查能否从 `13784521383` 或后续最新 MAIN Artifact 取回状态，归档时间记录是否与 北京自然日 对应。
3. 首份日归档必须查到真实 Artifact ID、name、expires_at，方可算保留期配置生效；即使 90 天配置已接受，也不意味着已观测连续运行 90 天。
4. 必须看到 `event=schedule` 的真实 run 与至少一次无人工触发的状态恢复，才可把云端定时驻守标成 **实测通过**。

## 风险边界

- GitHub Actions 的 cron 非实时，整点偏移有助于降低拥塞但不提供 SLA，90天归档依赖 GitHub 配置及成功执行的日子。
- 日检查点中的 `checks` 是最近 7 天样本、`events` 可覆盖最近 90 天；**每天都成功归档**时才能通过多个检查点核实广义 90 天历史。仓库无运行的日期不能补造。
- 90天快照属于 GitHub Artifact，不是独立持久数据库或多副本存储；仍需要长期监测告警与故障补偿方案。

参考：
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
