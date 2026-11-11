# TCL 抖音 R3.11｜回归原始 OPS 数据源 + 10 房间目录复验

日期：2026-11-11（北京时间）｜独立 Draft，不合并 `main`，不启用 Cron、不改动京东/Pages/既有历史。

## 已执行的真实只读接口复验

- 历史来源基线：2026-11-11 [GitHub Actions #43015295953](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015295953)，`roomsFound=10`、`shopsFound=10`、`linkedRooms=10`、`boundRooms=1`。
- 本轮新一轮真实采集：[GitHub Actions #43040627714](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43040627714)，`completed/success`；2026-11-11T14:39:58.830Z（北京时间22:39:58）。
- 真实结果：`observedSourceRoomsThisRun=10`，`inventoryRows=10`，`sourceShopJoined=10`，`sourceCaptureBound=1`。
- 正常目录只读来源：现有四种 GET API `/api/capture/rooms`、`/api/shops`、`/api/assistant/active-rooms`、`/api/capture/room-overview/daily`；没有登录、验证码、浏览器访问、重试、原始响应存储或写入。
- 该来源没有提供完整目录总数证明：`sourceCatalogComplete=false`，10 指本次 API 应答中已经观察的内部房间，**不能直接推广为全平台恰好只有 10 间**。
- 10 个房间状态均为 `UNKNOWN`；因仅 1 间有采集绑定，其他不得视为停播。**10 条真实内部房间记录 ≠ 10 个已经证实在播**。
- 公开批准账号共 12 个；R3.9 两个 RPA 检查仅是另一条来源的样本，本轮没有重新执行 RPA，因此本轮的 `rpaSampledPublicAccounts=0` 是“本轮未采样”，不是“之前 2 个消失”。
- 10 内部房间 ↔ 12 公共账号的真实独立 bridge 仍 0，不能依品牌名、账号序号或同类目猜测。
- 正式开播率、满播率、精确上下播时间均为 `null`。

## 本轮代码和业务修复

- `probes/r311/douyin-catalog-reconcile.mjs`：
  - `reconcileDouyinCatalog`：以实际 OPS 房间清单为主表；12 公开账号另表；RPA 最多两个抽样不会删减 OPS 10 房；
  - 只接受已授权的同平台原始内部房间，按房间 ID 去重；与 JD 同数字 ID 冲突必须拒绝；
  - 当来源失败或部分返回时，可依据**先前真的留存过的房间行**保留缺失行，均降级 UNKNOWN，不得虚构缺失 ID；
  - 10 的历史数字只是保底警戒线；无法凭一个汇总数字反推出没有保存过的明细；
  - 店铺映射变更标冲突，不自动接入；
  - 内部 OPS 与公开抖音 secUid / 直播间的关联必须满足 R3.6 的三证据 + 人工审核；
  - LIVE 的公开双验只可以附加到经核验的指定 OPS 房间，且不得擅自计算正式 KPI。
- `publicDouyinCatalogReceipt`：公开输出只有合计与 10 条**单次运行本地序号**；不保存内部房间 ID、店铺 ID、店名、session_key、Cookie、原始响应；这些序号不能跨次当作稳定房间身份。
- `tests/r311-douyin-catalog-reconcile.test.mjs`：20 项验收，专门防止把“10 OPS / 12 approved / 2 RPA”混成同一统计。
- `probes/r311/source-inventory-one-shot.mjs` 和 `.github/workflows/r311-source-catalog-one-shot.yml`：一次性且手工设置触发门禁的公网只读来源核对；**不启用计划任务**。

## 发布与保留门禁

这是公共 GitHub 仓库：不会将完整原始 OPS 房间/店铺 ID 及商家业务数据放入公开 GitHub PR、Action 日志或 artifacts。此次生成的匿名行 `runLocalOrdinal` 只用于对账条数，不能证明跨次逐房间 identity。
如果未来需要逐条保存内部房间 ID、店铺 ID、店名，必须采用单独受控的私有存储或端到端加密导出，禁止将内部明细直接写进公开仓库。

下一阶段必须明确真实可审查的 OPS ↔ 公开账号桥接证据，并用已知 LIVE/OFFLINE 真值样本校准状态；不会简单把 RPA 两条 UNKNOWN 当成 10 间真实直播间的变化。

## 证据和验收
- [原始来源 10 房间](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015295953)
- [R3.11 真实重采 10 房间与测试](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43040627714)
- 原始 10 房间与本轮 10 房间**数量一致**，但没有对外保存前次完整 IDs，因此不能由数量相同进一步推出“每一条 ID 都与历史完全一致”。
- 失败时会报警且退出非零码；不把接口访问失败解释为零房间或 OFFLINE。
