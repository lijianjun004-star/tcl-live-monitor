# R3.15 基线与已有 PR 依赖审计

核对时间：2026-11-12 17:31（北京时间）。仓库为公开仓库 `lijianjun004-star/tcl-live-monitor`。本文件只记录公开的分支、提交和设计边界，不包含内部房间或店铺 ID、来源响应、凭据或私有映射。

## 基线快照

使用 `git -c http.sslBackend=openssl ls-remote` 查询，`main` 为 `68382b23f9acf8160c8d86ec154c0ef2ce35af32`，与交付包所述基线一致。远程 R3.14 分支为 `d2eafaa788cf8b08cdda434f083c005b7e526507`。查询时未发现远程 R3.15 目标分支；本地 R3.15 分支当时以 `main` 基线检出。分支状态会随其他工作变化，操作前应重新核对。

GitHub PR 元数据查询显示下表所有 PR 均为 open、Draft、未合并。表中 SHA 是该次查询返回的 head 快照，并非今后不变的引用。图示见 [PR-DEPENDENCY-GRAPH.mmd](PR-DEPENDENCY-GRAPH.mmd)。

| PR | 主题 | base | head SHA（前 8 位） |
| --- | --- | --- | --- |
| [#59](https://github.com/lijianjun004-star/tcl-live-monitor/pull/59) | R3.6 参考站 REA | main | ac79d00f |
| [#60](https://github.com/lijianjun004-star/tcl-live-monitor/pull/60) | R3.6 来源 API / JS REA | main | a101bf10 |
| [#61](https://github.com/lijianjun004-star/tcl-live-monitor/pull/61) | R3.6 来源状态复刻 | main | f5983dfa |
| [#62](https://github.com/lijianjun004-star/tcl-live-monitor/pull/62) | 四层身份与场次证据门禁 | #61 head 分支 | b1ffdecc |
| [#63](https://github.com/lijianjun004-star/tcl-live-monitor/pull/63) | 只读浏览器 RPA | #62 head 分支 | d5757712 |
| [#64](https://github.com/lijianjun004-star/tcl-live-monitor/pull/64) | RPA 真实单次观测 | #63 head 分支 | 490149d7 |
| [#65](https://github.com/lijianjun004-star/tcl-live-monitor/pull/65) | DOM 信号诊断 | #64 head 分支 | a4d0998d |
| [#66](https://github.com/lijianjun004-star/tcl-live-monitor/pull/66) | 直播间身份差异诊断 | #65 head 分支 | 4bdb8457 |
| [#67](https://github.com/lijianjun004-star/tcl-live-monitor/pull/67) | 来源目录对账 | #66 head 分支 | 8d331b19 |
| [#68](https://github.com/lijianjun004-star/tcl-live-monitor/pull/68) | 内部房间加密导出 | #67 head 分支 | a26b8df3 |
| [#69](https://github.com/lijianjun004-star/tcl-live-monitor/pull/69) | 过期 LIVE 与来源类目修复 | #67 head 分支 | 26fe7511 |
| [#70](https://github.com/lijianjun004-star/tcl-live-monitor/pull/70) | 隐私门禁 | #69 head 分支 | be72b272 |
| [#71](https://github.com/lijianjun004-star/tcl-live-monitor/pull/71) | 私有身份审核工作台 | #70 head 分支 | bcd98c6e |
| [#72](https://github.com/lijianjun004-star/tcl-live-monitor/pull/72) | 店铺与账号候选排序 | #71 head 分支 | d2eafaa7 |

这是 PR 的 base 分支关系，不代表所有分支已合并或自动继承到 `main`。#59、#60 是从 `main` 出发的并行工作，#68 是 #67 的并行支线，不在 #69→#72 主链上。查询 #68 时 API 给出的 base SHA 为 `745523fa`，与当时 #67 head 的 `8d331b19` 不同；不要仅凭 base 分支名称假设它对应同一提交快照。

## 可复用代码与限制

- `probes/r33/jd-backup-freshness.mjs`：京东 MAIN 制品 freshness 判定；当前 4 分钟阈值依赖既有 schema 和 `source_evidence_accepted`，不能直接当作小时级跨平台通用 guard。
- `probes/r36/douyin-ops-parity.mjs`、`probes/r36/douyin-evidence-gate.mjs`：来源状态与证据门禁；来源目录及状态不等于跨系统身份或真实上下播真值。
- `probes/r37/rpa-safe-douyin.mjs`：公开访客浏览器检查，限制每次最多两个批准账号；访问挑战或 401/403/429 中止并保留 UNKNOWN。`probes/r38/run-public-rpa-once.mjs` 的两个目标目前硬编码，六批调度需另行实现并保持限制。
- `probes/r39/rpa-dom-signal-utils.mjs`、`probes/r310/room-identity-parity.mjs` 和 `probes/r311/douyin-catalog-reconcile.mjs`：DOM、房间身份和来源目录对账。
- `probes/r313/private-bridge-review.mjs`、`probes/r314/shop-account-candidates.mjs`：私有审核与候选排序；名称相似不构成身份验证。

上述抖音路径存在于已核对的 R3.14 head，不能假定它们已经存在于 `main`。复用前必须检查提交和依赖，避免意外引入公开仓库不应存放的私有数据。既有 PR 所述历史运行和测试不是本次运行证据，实际当前来源和浏览器结果须单独验证；未观察到的状态不能推断为 OFFLINE。

本机 Windows / Node 24.18 对基线执行 `node --test tests/*.test.mjs`：142 项，124 通过、18 失败。其中两个报告 `spawn Node ENOENT`，多项报告未找到指定 workflow step；具体原因尚未确认。不得将历史 CI 的结果写成本机本次全仓通过。

另在独立目录以同一基线 `68382b23f9acf8160c8d86ec154c0ef2ce35af32`、本地 `core.autocrlf=false` 检出后，用 Node 24.18 执行 `node --test tests/*.test.mjs`：默认 Windows PATH 下共 151 项，140 通过、11 失败；仅在当前进程将 Git Bash 置于 PATH 前端后重跑，共 **151 项、145 通过、6 失败**。其中 4 项依赖未安装的 `jq`；另 2 项本地 HTTP 测试使用 file URL 的 pathname 作为子进程工作目录，在 Windows 上出现 `spawn Node ENOENT`。这次对照说明至少 5 项失败与默认 `bash` 指向不可用的 WSL 有关，也消除了 CRLF 对换行敏感断言的影响；未能在该环境完成其余 6 项验证，不能视为全仓通过。此结果为独立基线的本地测试，不包括 R3.15 新增测试。

## 本轮后续复测

修复两项测试在 Windows 中使用 URL pathname 作为子进程工作目录的问题后，在独立 LF 基线检出中使用 Git Bash 与工作区内 jq 执行原有测试，151 项全部通过。jq 使用 [官方 1.8.2 发布](https://github.com/jqlang/jq/releases/tag/jq-1.8.2) 的 Windows amd64 文件，执行前比对其 SHA-256；它只存在于本次工作区测试目录。该结果是离线测试，不代表新 R3.15 代码已通过真实来源或定时运行验收。
