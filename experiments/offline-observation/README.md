# 平台无关观测契约：最小离线原型

本实现从用户指定的公开概念独立编写，不包含豹播代码、页面、扩展、Cookie 上传、私有接口或会话凭据。没有访问豹播或任何平台。它不是自动化接入，也不是采集器；没有网络、存储、调度或生产调用方。

## 已有代码与差异

基线 main `18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca` 已有 `probes/lib/tcl-ops.mjs` 的平台心跳判定和 `probes/lib/tcl-jd-all.mjs` 的京东解析。历史 PR #61/#62 有抖音身份/心跳与场次门禁，#41 有京东场次证据；#102 的来源可靠性候选和 #104 的未核实身份占位仍独立。本原型不复制或替换这些平台专用模块，不把草稿映射视为已验收身份。

新增差异是**独立、平台无关的输入/输出契约**：显式分离账号、店铺、实体房和直播场次，并分别呈现来源健康、登录异常、数据过期与心跳。没有改场次引擎、真实名单、保留期限、时钟候选或生产配置。与时钟 Draft #105 无文件重叠。

## 契约

调用 `evaluateObservations({bindings, observations, now, maxObservationAgeMs, maxHeartbeatAgeMs})`。阈值必须由调用者显式传入，测试数值仅为合成评价条件，不是建议改变生产频率。时间只接受严格 UTC ISO 毫秒格式，拒绝未来、非法日期、无时区或观察/心跳晚于接收时间。

- `bindings`: platform (`jd` / `tmall` / `douyin`)、accountId、shopId、entityRoomId、reviewed、reviewRef、reviewedAt、reviewExpiresAt。整合候选要求显式审定有效期；缺失、未来或过期不得因永久布尔值放行。没有名称匹配。所有 ID 都是所在字段的独立不透明标识，不能交换或互推；示例只用 synthetic 标识，不猜真实公开 ID。
- `observations`: 同一四层身份中的前三层及 platform；broadcastSessionId 可为空。它表示直播场次标识，**不是登录会话、Cookie 或 capture session key**。
- sourceHealth (`AVAILABLE` / `UNAVAILABLE` / `UNKNOWN`) 与 loginStatus (`OK` / `NOT_REQUIRED` / `REQUIRED` / `EXPIRED` / `UNKNOWN`) 独立。
- dataFreshness / heartbeat 分别为 `FRESH` / `STALE` / `MISSING` / `INVALID`；observedAt 为样本时间，receivedAt 为接收时间，heartbeatAt 为心跳时间，evaluatedAt 为本次评价时间。
- effectiveObservedAt 仅在全部门禁成立且存在显式状态证据时赋值；成功心跳、重复接收或本次评价不能刷新旧样本。缺样仍输出该登记账号的 UNKNOWN 行。
- 身份以 platform+accountId 分组；同平台重复绑定（即使相同）全部 CONFLICT；重复样本全部 UNKNOWN，不以顺序挑选。跨平台同字符串不合并。未登记样本只计数，不产生新身份。
- LIVE 需要当前来源可用、登录就绪、新鲜样本/心跳以及 reviewed evidenceRef；OFFLINE 还需显式 negativeEvidenceReviewed。失败、缺样和旧数据不构成负证据。

`reviewed`、`reviewRef`、`evidenceReviewed` 和 `negativeEvidenceReviewed` **只是输入契约中的调用者声明**，本原型不验证签名、批准人或事实。输出 identity=`REVIEWED_INPUT` 不等于现实身份已确认；不得将不可信 JSON 直接接入生产。真实适配器、证据验证器、经审计身份台账、可信时钟和持久化均未实现。UNKNOWN 不回退成 OFFLINE，也不计算开播率、准确起止时间或时长。

输出仅使用显式字段白名单；不转发名称、原始正文或未知 Cookie/token 字段。输入仅允许非敏感 ID/引用，白名单格式不是凭据检测器，调用者仍不得将凭据放入 ID 字段。超过 1000 条记录拒绝。函数不写日志、不访问网络、不修改输入。

## 复验与验收边界

```
node --test experiments/offline-observation/*.test.mjs
node --test tests/*.test.mjs tests/*/*.test.mjs
```

测试包含重复账号、跨平台 ID、无样本、重复观测、错误绑定、来源/登录异常、过期数据、新心跳配旧数据、未来/反序/非法时间、明确负证据、空场次、额外敏感字段过滤及无网络/副作用。全部合成输入。

提交仅新增本目录；30 个工作流触发器审计无匹配 push/PR 路径，无采集或部署触发。未安装扩展、访问来源、执行采集、启用考核或引入付费服务；未改变生产。Draft 仅供独立审查，正式合并部署须具体批准。Claude/Gemini 可按上述命令复验并审查布尔声明的信任边界；本次未声称它们已经复验。
