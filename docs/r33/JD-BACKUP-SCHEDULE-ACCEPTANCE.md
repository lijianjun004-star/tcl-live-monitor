# R3.3 京东 GitHub 备用调度｜独立验收说明

日期：2026-11-11（北京时间）

## 已发生的真实问题

当前 MAIN 通过 GitHub Actions `schedule` 在北京时间 06:08、09:54、16:37 实际触发了三次；其中 09:54、16:37 的源读取、历史恢复、状态上传均成功。两次采样相隔约 6 小时 42 分钟，远远未达到 5/15 分钟持续巡检的计划。最新受控 MAIN 源扫描 `42994727793` 从前次 35 个 checks 接续到 42 个 checks，7 个内部 JD 房间显示 LIVE，但仍不是全天连续真人直播证明。

参考：
- 自动巡检 `42942292027`：[Actions](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42942292027)
- 自动巡检 `42988446429`：[Actions](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42988446429)
- GitHub 官方明确承认 cron 可能在高负载时延迟、丢弃：
  https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

## 本轮优化

1. **主巡检仍为现有 R3.2**：`.github/workflows/jd-r23-scheduled.yml` 的 cron `2,7,12,17,32,47,57 * * * *` 完全保留。
2. 新建备用入口 `.github/workflows/jd-r33-backup.yml`：使用错峰 cron `4,9,14,19,34,49,59 * * * *`，无新增平台开发者账户或付费外部服务。
3. 备用入口第一步仅查询**同仓库 MAIN 最新未过期 Artifact** `r24-jd-main-state`，读取其 `r23-state.json` 和 `r23-summary.json`。
4. 只在北京时间 06:30～次日 02:00 且**没有最近 8 分钟已确认成功的 MAIN 巡检**时允许备用触发；若主巡检成功、数据足够新，则跳过。
5. 如果前次来源不可信（`source_accepted!==true`），备用触发不会被一个新鲜但失败的 UNKNOWN 结果阻塞。状态文件缺失则在运营时段内允许原有监控器安全冷启动；文件格式不完整直接失败，绝不清空伪造历史。
6. **原本采集逻辑只保留一份**。新入口通过 GitHub 原生 `workflow_call` 调用原巡检，不复制采集代码、状态判定或历史保存，依赖同一个共享 `concurrency` 组串行化真实源采集。
7. 备用入口和原工作流的 `GITHUB_TOKEN` 权限仅 `contents:read/actions:read`；只透传可选的 `TCL_OPS_BASE_URL`，不使用 `secrets:inherit` 传递全部仓库 Secrets。
8. **7 天滚动状态唯一**：`r24-jd-main-state`，不启用 90 天归档，也不更改 GitHub Pages。

## 运行验收和边界

- GitHub PR/push：仅离线测试，真实采集必须由 `schedule` 或 `workflow_dispatch` 发起。
- PR 合并前运行 `node --test tests/*.test.mjs` 和原主工作流既有全量回归；测试 `bash -n`、时间窗、7 天状态隔离、真实性门禁。
- 合并后**必须出现真实备用 `schedule` 事件，且真正完成 `use-existing-readonly-monitor`、恢复 MAIN 历史并写入 7 天 Artifact**，才能宣布备用调度自身验收通过。
- 主备用同属 GitHub Actions 调度服务。双调度可以增加触发机会，但**不是独立于 GitHub 的高可用调度**，不能保证每天每个 5/15 分钟窗口触发成功。
- 仍只观察 7 个内部 JD 运营房间，目录为 `PARTIAL_WITH_INTEGRITY_WARNINGS`，独立京东 OFFLINE 与正式真人满播率仍无充足证据。
- 已经存在的历史 90 天旧 Artifact 不主动删除，但**不再生成**新的长期归档。
- 若真实备用调度仍无法达到频率，下一阶段需要额外可靠调度源或重新审核免费部署能力；不能冒充 GitHub cron 可以提供 SLA。
