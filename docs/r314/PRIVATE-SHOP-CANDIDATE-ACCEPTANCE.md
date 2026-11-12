# TCL 直播监控 R3.14｜真实 OPS 店铺名称与公开账号候选对照

2026-11-12。仅独立 Draft，未合并 `main`，不更改京东、天猫、抖音正式运行程序、Pages 或历史数据。

## 新证据：不是新发现的直播间总数

- 已批准原来源 GET 两接口：`/api/capture/rooms`、`/api/shops`。
- 本次真实 [GitHub Actions #43177695290](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43177695290)：SUCCESS，来源抖音内部房间 **10**，店铺 **10**，内部关联 **10/10**，未提供可独立认证的公开抖音 `secUid` 和公开账号 ID。
- 公开记录仅包含 **10、10、10** 等统计，原始商家名/房间 ID/店铺 ID 采用 RSA-OAEP-SHA256 + AES-256-GCM 在 Runner 内存中加密后保存。私钥从未提交到仓库或 CI。
- 与之前的私有 R3.13 工作表比较，该 10 房间来源仍是**同一内部房间维度**，而不是 RPA 2 个公开账号抽样。
- 已批准的 12 个公开抖音账号来自现有 `config/probe-targets.json`；未经审批的账号不进入候选。

## 此次新增可执行代码

- `probes/r314/shop-account-candidates.mjs`：仅在**私有环境**中根据店铺名称与现有批准账号名称生成**最多 3 条名称相似线索**。内部房间和店铺 ID 独立维持，不会当成公开房间 ID。
- 生成理由包括完全相同、独特片段、弱名称相似或类目冲突。分数是便于人审的**排序信号**，不是可信概率、身份证明或可直接加入正式监控的条件。
- 任何候选都必须保持 `identityStatus=UNVERIFIED`、`reviewApproved=false`、`observedRoomId=null`、`liveStatus=UNKNOWN`、`verifiedFourLayerBridges=0`。
- `safePublicCandidateCounts`：公开 CI 日志、文档只允许输出合计数，不含内部 ID、店铺名称、公开 secUid 或逐行候选。
- `tests/r314-shop-account-candidates.test.mjs`：包括重复房间/店铺 ID、非抖音、未批准账号、网址校验、品牌相同但真实身份不同、类别冲突、零自动关联及隐私泄漏防止测试。
- 原 R3.13 私有审核台仍保留。候选需要与店铺详情页中的**原始外部绑定证据**交叉核对，并由已授权审核人员审查；不得写入 R3.6 四层可信桥接表作为 VERIFIED。

## 上线与成本边界

- 当前 OPS 来源的店铺名称是来源系统声明的商家文字标签，**并不是抖音账号 secUid**。相似名称只缩小人工审核范围。
- 本次没有获得可验证的十条 OPS 房间→公开账号关联，更没有得到 10 条真人已确认 LIVE/OFFLINE 同时段数据。
- 未接入正式 5/15 分钟自动巡检，未将候选用于正式开播率或满播率，两个指标持续 null。
- 没有新增付费服务或持续云端浏览器。
- 代码只在独立 Draft 分支，所有有业务身份的数据仅保存在用户私有交付文件。
