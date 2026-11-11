# R3.3 真实 Artifact 只读集成验收：字段契约热修复

日期：2026-11-11（北京时间）

## 发现方式（真实 GitHub Actions，不是合成测试）

独立只读 QA 分支 `qa/r33-main-backup-preflight-20261111` 的运行
[42999571924](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42999571924) 
成功从同仓库 MAIN 最近的 `r24-jd-main-state` 下载并解压状态和摘要，但验收断言发现摘要中没有 `source_accepted` 属性。

原因可由**正式固定采集器的真实源码**独立证明：

`267b6709a8563ef779cda6b11c97b9684c4e1c16:probes/r23/run-history.mjs`

真正写入的是：

`summary.source_evidence_accepted=source_accepted`

而 R3.3 备用判定程序错误读取 `priorSummary.source_accepted`，会把所有真实摘要误判为来源未核实，导致每次备用时机都可能重复源站采集，8 分钟防重复形同虚设。

## 本修复

- 改为读取 **`priorSummary.source_evidence_accepted`**。
- 必须是 `boolean`，旧错误字段和缺字段抛出 `INVALID_SOURCE_EVIDENCE_FLAG`，不能静默假装成功。
- true：按 8 分钟时效跳过或补检；false：允许备用重试，但**不转换任何 OFFLINE**。
- 添加真实持久字段的对抗性回归，拒绝旧 `source_accepted` 代替持久来源凭据。
- 不变更原 MAIN Cron、备用 Cron、JD 采集器 SHA、7 天历史、权限或 Pages。

## 验收要求

1. PR CI 中 `node --test tests/*.test.mjs` 全量通过。
2. 再从最新 MAIN Artifact 进行只读集成验收：
   - 下载 `r23-state.json`、`r23-summary.json`；
   - 核对真实 `source_evidence_accepted` 为布尔值；
   - 调用真正的 `probes/r33/jd-backup-freshness.mjs`；
   - 报告 `should_run`、`reason`，不要扫描 JD、不写任何 Artifact。
3. 备用 `event=schedule` 与 `use-existing-readonly-monitor` **仍需独立实测**。只读 QA 不代替真实备用 Cron 验收。
