# R3.6｜抖音四层身份关联与采样场次门禁（独立增量）

日期：2026-11-11。基线：PR #61 `f5983dfa457efbc2c5c381532e271eae27d6abb8`。本分支为独立测试，禁止合并主分支或自动考核。

## 三条真实证据链及边界

- PR #60 [运行 43015295953](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015295953)：只读 OPS 来源列出 10 抖音房间、10 店、10/10 内部房店关联、1 房有采集绑定；未证明目录完整、LIVE 真值或房间与公共账号关联。4 份抽查 `days[]` 只是历史结构。
- PR #60 [运行 43015670761](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015670761)、[运行 43016108653](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43016108653)：成功取得 106391 字节真实 JS、完成 REA 静态分析；但原站抖音完整 UI、真实请求图、业务算法尚未确认。
- PR #59 [运行 43015156078](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43015156078)：两个公开账号仅主页可核验，房间页身份未交叉证实，`UNKNOWN=2`、`VERIFIED_LIVE=0`。
- PR #61 [运行 43021390001](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43021390001)：31/31 专项及 169/169 回归通过。只是离线测试，不代表实时正确率。

内部 10 房和配置 12 个公开账户尚未形成经过验证的一一映射。本增量**不预填任何真实 bridge**，不把 `shop_id=17` 或内部 `live_room_id` 当成 secUid。

## 新增模块

- `probes/r36/douyin-evidence-gate.mjs`：纯函数，无网络和落库。
- `reconcileDouyinFourLayers({opsRooms,accounts,evidenceRows})`：先确认 OPS 房间及店铺，再确认已批准公开账号 secUid 和公共直播间 ID。只有明确三类独立证据引用 `OPS_ROOM_SHOP` / `PUBLIC_ACCOUNT_ROOM` / `CROSS_SYSTEM_BRIDGE`，对应审核确认且无 ID 冲突，才准许结构化关联。
- **重要：字段齐全和引用格式合法不等于事实真实性。** `reviewApproved=true` 必须在可信工作人员核对来源与原始材料之后才填入，绝不能虚构三条证据占位。未经人工真实审定全部维持 `UNVERIFIED`。
- `buildDouyinSessionEvents({observations,identityReport})`：只对公开主页与房间双向身份通过、bridge 在 7 天有效期内的公开 LIVE 生成 `FIRST_SEEN_LIVE`；中断记录 `UNKNOWN_GAP`，陈旧分钟信息只生成 `OFFLINE_CANDIDATE`；只有另有独立证据确认新场次边界才生成 `NEXT_SESSION_DETECTED`。房间号变更本身不等于新场次。
- 所有事件保存采样时刻，不生成精确开播或下播时间；`formalOpeningRatePercent=null`、`formalFullDurationRatePercent=null`。不输出 Cookie、Token、会话密钥或原始私有接口 JSON。

## 门禁

| 检查 | 本阶段结果 |
|---|---|
| 四层身份映射程序与事件安全性 | 离线测试可验收 |
| 10 个内部房间 ↔ 12 个公网账号真实关联 | BLOCKED，尚无逐条可信桥接证据 |
| 公开抖音 LIVE 真值 | BLOCKED，已抽查 2 个 UNKNOWN |
| OFFLINE 负例、下一场真值 | BLOCKED，未采到可信真实负例 |
| 原站抖音 UI 1:1 与请求图 | BLOCKED，REA 证据不完整 |
| 计入正式满播率 | NOT_EXECUTED，禁止虚报 |
| 修改 JD MAIN、Pages、7 天历史 | 未执行，也不允许 |

## 离线测试

```sh
node --test tests/r36-douyin-evidence-gate.test.mjs
node --test tests/*.test.mjs
```

本 PR 以 #61 为 base 的**堆叠草稿**，#59/#60 保持独立且未合并。不运行新 Cron，不访问受控目标站点，不更改生产网页或监控数据。