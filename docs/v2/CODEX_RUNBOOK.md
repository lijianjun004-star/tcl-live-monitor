# TCL V2 试运行与生产接入

用户批准 PR 并合入后，从手机浏览器打开仓库 **Actions → TCL V2 monitor → Run workflow**，选择 `main`。V2 生产采样由 `workflow_dispatch` 手动启动。[工作流](../../.github/workflows/v2-monitor.yml)

## 1. 离线验收

选择 `engine=fake`，运行默认示例。核对离线探针自检、完整 pytest（0 失败、0 跳过）、示例产物及校验清单。H 轮签核基线为 265 项测试。离线运行的产物名称以 `TCL_V2_DryRun_` 开头。

## 2. 填写测试目标与接入参数

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 中逐项填写，已有条目使用 **Update**。

| 用途 | Secret | 设置 |
|---|---|---|
| 目标 | `V2_TARGETS_JSON` | 首次用已确认的少量公开入口，其中至少一个近期有真实状态变化。按 [目标格式](../../schemas/targets.schema.json) 填写。 |
| 群推送 | `WEBHOOK_URL`、`WEBHOOK_KIND` | 指向测试群。类型可填 `feishu`、`dingtalk`、`wecom` 或 `bark`。钉钉或飞书启用签名时另填 `WEBHOOK_SECRET`。 |
| Drive | `GDRIVE_CLIENT_ID`、`GDRIVE_CLIENT_SECRET`、`GDRIVE_REFRESH_TOKEN` | 使用项目 OAuth 客户端，在目标 Drive 账号取得仅含 `https://www.googleapis.com/auth/drive.file` 的离线授权。 |
| Drive 测试目录 | `GDRIVE_FOLDER_ID` | 填 OAuth 应用可写的隔离文件夹 ID。留空时应用会查找或创建自己的 `tcl-live-monitor-v2` 文件夹。 |

## 3. 两次手动运行验证群推送和 Drive

1. **首次运行**选择 `main`、`engine=live`，将 `restore_state_run_id` 留空。若名单使用严格京东阳性对照，需先确认该场次当前在播。仅验收推送和 Drive 时可关闭 `fail_on_canary`，房间原始判定仍留在证据中。
2. **核对送达。** 首次运行与空快照比较，新在播、首次风控等真实事件可产生测试群消息。打开该批 `TCL_V2_Evidence_…` 工件，核对 `run_summary.json` 的 `notification.status=sent` 和群内相同批次号。如果显示 `no_changes`，本次没有待发送的新事件，送达仍待有事件时验证。
3. **核对 Drive。** 在 GitHub 原件中查 `drive_status.json` 的 `status=synced` 与 `report_file_id`。从指定目录打开对应批次的报告 ZIP，核对快照和校验清单。清单中的 `thumbs/*.jpg` 对应同批独立上传的 JPEG。同步只清理该目录下由应用标记且超过 24 小时的独立缩略图，报告 ZIP 保留。
4. **第二次运行**沿用首次配置，`restore_state_run_id` 填首次成功的同分支 live 运行编号（运行页网址末尾的数字）。这会恢复 `v2-state` 中的快照与已推送记录。没有新事件时核对 `notification.status=no_changes`、`fresh_events=0` 且群中无重复消息。如果两次之间确有新事件，按新事件核对送达，保留真实观测。

GitHub 工件 `v2-state` 保留 7 天。推送失败后，若作业成功且 `state_snapshot_advanced=false`，修正配置并在下一轮恢复该次运行，系统会从上次有效基线重试仍可观测到的变化。首次失败时允许恢复发现缓存和空发送账本。对于旧版本中推送失败但 `state_snapshot_advanced=true` 的运行，改选失败前最近一次通知状态为 `sent` 或 `no_changes` 的有效基线；若为首次运行，则留空恢复编号。

## 4. 扩到 20 路真实目标

- 将用户确认的目标写入 `V2_TARGETS_JSON`。每个入口使用唯一 `key`，记录店名、平台和公开标识。天猫/淘宝优先使用固定主播 `account_id`（分享页的 `userId`），每组最多 7 个。
- 京东使用已核实的公开店铺或直播分享入口，按 [配置示例](../../config/targets.example.json) 选择 `shop_discover` 或 `direct`。店铺寻路得到的候选由房间详情核验。游客 SKU H5 不作为生产寻路来源。
- 手动运行后，将 `run_summary.json.targets_total`、`by_platform` 与批准的清单对账，逐项核对 `resolved_rooms.json` 和 `monitor_snapshot.json`。把 `unknown`、登录、风控及同组跳过单列，保留请求和身份匹配证据。
