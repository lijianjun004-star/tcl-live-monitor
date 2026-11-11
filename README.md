# TCL 多平台直播监控系统｜京东自动巡检运行核验

独立于 TCL 智能练播房项目；**不混库、不混部署，不修改练播房现有 GitHub Pages**。

## 京东：已有真实自动运行

截至北京时间 2026-11-11 16:37 的 GitHub Actions 实证：

- [首次确认 `schedule` 自动触发 #42911739547](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42911739547)：北京时间 06:08，在运营窗口外按规则不采集。
- [自动京东采集 #42942292027](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42942292027)：北京时间 09:54，读取 7 个内部房间，6 LIVE / 1 UNKNOWN；恢复前次 MAIN 状态并上传新的历史 Artifact。
- [自动京东采集 #42988446429](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42988446429)：北京时间 16:37，读取 7 个内部房间，7 LIVE / 0 UNKNOWN；从 `42942292027.1` 恢复历史，检查记录从 28 增至 35，并上传 7 天 Artifact `13841115332`。

**真实已通过：** GitHub 默认分支自动调度，京东内部来源只读采集，状态校验、跨运行恢复和 7 天滚动 Artifact。

**尚未通过：** 5/15 分钟完整采样频率。两次有效自动采集间隔约 6 小时 42 分钟，不能宣称整时段连续驻守或可靠满播率。GitHub `schedule` 是尽力触发，不保证每个 cron 机会准时执行。

## 现有边界

- 目前只观察到 **7 个京东内部运营房间**，且来源目录标记 `PARTIAL_WITH_INTEGRITY_WARNINGS`，未证明覆盖全部 TCL 京东账号/店铺。
- 此源为 TCL OPS 内部运营监控信号，不等同于独立核验京东公开直播页面。
- 单个采样结果的 `LIVE` 是被观察到的状态，**不是整段持续真人直播证明**。
- 京东 `OFFLINE` 尚无平台独立可信负例；`UNKNOWN` 不算停播、不扣满播率。
- 准确开始/下播时间、真人/数字人时长、正式开播率/满播率仍未达到考核验收标准。
- 用户已取消 90 天长期归档，**只保留 7 天滚动检查状态**；停止新建 90 天归档，不自动删除历史已有的 Artifact。

## 运行入口与证据

- [正式京东巡检工作流](https://github.com/lijianjun004-star/tcl-live-monitor/actions/workflows/jd-r23-scheduled.yml)
- 运行计划：北京时间 06:30 至次日 02:00，cron 机会 `2,7,12,17,32,47,57 * * * *`（GitHub UTC，延迟或缺样必须按实际日志统计）
- 可信状态文件：`r24-jd-main-state`，仅恢复同仓库 `main` 且未过期的 Artifact。
- R3.2 在 Actions Job Summary 增加「上次成功扫描距今分钟数」与「北京时间运营窗口中预定 cron 机会数」；缺少多次采样会显示警告，绝不把缺样当 OFFLINE。

此 README 描述已核验结果，不代表未来每次自动运行保证成功。下一阶段优先改善巡检频率与京东房间身份映射、真实停播负例。
