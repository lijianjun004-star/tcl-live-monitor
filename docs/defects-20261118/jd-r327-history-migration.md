# 京东 r327 旧快照离线暂存

现行恢复流程要求最近完成轮的产物。若最近失败轮没有产物，正常流程会保留阻塞。此工具供操作者在隔离目录把保全的旧成功轮快照整理为历史数据。它不会替换现行恢复输入或开启采集。

```text
node scripts/r327-legacy-migration.mjs stage EVIDENCE APPROVAL ARCHIVE OUTPUT_DIRECTORY
```

工具使用 Node 和 Python 3 标准库。输入应来自操作者控制的普通本地文件，输出应为现有的私有目录。工具不访问网络、不提取文件到外部路径、不创建审核记录。

| 输入 | 必要内容 |
|---|---|
| `EVIDENCE` | JSON 含 `schemaVersion:1`、UTC `observedAt`、`runs` 和 `artifactsByRun`。从同仓库、同工作流、`main` 的 GitHub 已完成运行列表，保持查询条款不变，收齐从原成功轮到观测时刻的选定区间全部分页。保留原 API `total_count` 及所有 `workflow_runs` 条目，若分页返回的总数变化则重取。对原成功轮和跨度内各失败轮提供 API Artifact 响应，键为 run ID。 |
| `APPROVAL` | 审查人提供的独立 JSON，含 `schemaVersion:1`、`purpose:R327_STAGE_HISTORICAL_CARRY_FORWARD`、`repository`、`workflow`、`approvalReference`、UTC `approvedAt` 和 `expiresAt`，以及 `sourceRun`、`blockedRun`（各含 `runId`、`runAttempt`、`headSha`）、`artifactId`、原始文件字节的 `evidenceSha256` 和 `archiveSha256`（64 位小写 hex）。从证据观测到审批到期不超过 24 小时。该记录属于本地信任输入，工具不会批准或核验审查人身份。 |
| `ARCHIVE` | 保全的原始 `jd-fullday-state` ZIP，须与 GitHub Artifact 元数据和审核摘要一致。仅支持原成功 run 的 attempt 1，因为 GitHub Artifact 元数据只能识别 run，无法把同一 run 经重跑产生的多个 ZIP 精确归属到各 attempt。ZIP 的唯一成员为 `state.json` 和 `report.json`。 |

工具核对证据中的最新失败轮和其前一个成功轮。若任何中间失败轮已有产物，须另行审查产物，不走无产物的旧历史暂存路径。暂存前核对旧报告时间、房间、日期和基础分钟与权威 state 一致。旧报告缺少同代标识，审计仍标记 `legacyGenerationVerified:false`。新报告从旧 state 投影重算并带新代际摘要。旧 writer 会把部分缺样补零，无来源时间戳的 0 分钟在暂存投影中标为无读数，原 ZIP 字节保留。

输出为 `r327-migration-<失败run ID>-<失败attempt>/historical-state.json` 和 `historical-report.json`。同一工作目录针对同一失败轮 attempt 只能创建一次；中断后不自动重建，不清理既有安全锁。输出保存原历史观测时间、失败区间 provenance 和审批引用。当前来源和直播状态为 `UNKNOWN`，不刷新最后有效来源时间，不产生正式考核结果。

这一步只暂存历史。普通恢复和采集入口会拒绝暂存标识，即便把文件改成常规产物名称。实际恢复需在审批后检查最新运行和 Artifact 是否发生变化，确认来源可访问，并通过另行审核的激活操作接入历史。保全的旧快照不能覆盖实际失败记录或成为最新成功观测。
