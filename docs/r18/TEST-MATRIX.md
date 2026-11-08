# R1.8 测试矩阵

执行日期：2026-11-08 UTC。以下自动化均是离线合成输入及本地临时文件测试，不能代表平台实际成功。

| 测试组 | 数量 | PASS | FAIL | 跳过 |
|---|---:|---:|---:|---:|
| 原有全回归 | 251 | 251 | 0 | 0 |
| R1.8 新增自动化 | 46 | 46 | 0 | 0 |
| 最终完整回归 | 297 | 297 | 0 | 0 |

证据：`evidence/tests/baseline.tap`、`evidence/tests/full.tap`。`r18.tap` 为新增测试单独运行记录；最终总数以 full.tap 为准。

| 必须覆盖项 | 状态 | 独立测试定位 |
|---|---|---|
| 同账号新 liveId | PASS | r18-core: new liveId replaces old session |
| 同 liveId 换 room | PASS | r18-core: same liveId room change |
| 账号不符 | PASS | r18-boundaries: account mismatch；r18-store: fixed tmall identity |
| 过期证据 | PASS | r18-boundaries: stale evidence / passive capture stale |
| throttle→UNKNOWN | PASS | r18-boundaries: throttle is UNKNOWN |
| captcha不能变OFFLINE | PASS | r18-boundaries: captcha never becomes OFFLINE |
| 两次有效OFFLINE | PASS | r18-core: two valid OFFLINE；r18-store: simultaneous duplicate OFFLINE |
| UNKNOWN中断OFFLINE链 | PASS | r18-core: UNKNOWN interrupts OFFLINE |
| 小时slot去重 | PASS | r18-core、r18-store、r18-integration 三层测试 |
| 手动重复及完全重复提交 | PASS | r18-core、r18-store、r18-integration 三层测试 |
| 崩溃恢复 | PASS | r18-store: orphan temp/dead writer，corrupt primary/explicit backup |
| 同时冲突证据 | PASS | r18-store: invalidate both states and sessions；browser conflict |
| 未核验来源 | PASS | r18-boundaries: invalid attestation / passive transport |
| 推荐流误报 | PASS | r18-boundaries: recommendations never prove target LIVE |
| 历史room非固定 | PASS | r18-boundaries: historical room is not a current-room gate |
| 时间精度标记 | PASS | r18-boundaries: synthetic source cannot claim exact timing |
| 来源冷却且不重试 | PASS | r18-store: persisted cooldown；source only once |
| 原子写 | PASS | r18-store: atomically commits three views，interrupted replacement |
| schema迁移 | PASS | r18-store: schema1 migrates and rebuilds |
| 无secret/Cookie文件 | PASS（扫描范围内） | r18-integration static scan；evidence/tests/security-scan.json |

额外覆盖：写锁/乐观版本冲突、整次来源访问并发互斥、异常原因保留、CLI无来源、JSON/HTML生成与HTML转义、报告当前/历史场次分离、Profile仓库内路径拒绝、审计URL脱敏。

## 真实环境验收

| 路径 | 状态 | 证据与限制 |
|---|---|---|
| 淘宝公开页面 | BLOCKED | `evidence/tmall/public-page-check.json`；一次GET在获得HTTP响应前NETWORK_ERROR，不证明平台风控 |
| 淘宝已登录持久会话 | NOT_EXECUTED | 未提供用户正常登录Profile，浏览器依赖不可用；未索取凭据 |
| 淘宝真实liveId | NOT_EXECUTED | 没有真实被动响应来源 |
| 淘宝真实新liveId/换场 | NOT_EXECUTED | 合成换场通过不能替代真实换场 |
| 淘宝回放 | NOT_EXECUTED | 未进行真实回放检查 |
| 京东状态 | BLOCKED | `evidence/jd-public-check.json`；HTTP200但跳转通用jd页面，无目标证据 |
| 抖音状态 | BLOCKED | `evidence/douyin-public-check.json`；HTTP200空响应，无目标证据 |
| 24h连续运行 | NOT_EXECUTED | 未启用生产cron，无持续运行证据 |
| 跨GitHub Actions长期持久化 | NOT_EXECUTED | 本地事务恢复已测；未建立跨run存储服务 |

真实测试以上9项：PASS 0 / FAIL 0 / BLOCKED 3 / NOT_EXECUTED 6。公开页面能返回HTTP200不算直播状态成功。

## 门禁结论

实验底座离线验收 PASS；真实平台状态验收尚未通过。因至少1个真实平台状态成功条件未满足，不能据此宣称无人值守监控就绪或建议合并部署。下一锁：在可交互的正常浏览器环境，用用户本人外置Profile人工登录后，仅观察一次固定淘宝账号页面自然产生的被动响应并核验身份、liveId及新鲜度；遇安全验证/频控即停。

## 复验

```sh
node --test tests/*.test.mjs
node --test tests/r18-*.test.mjs
node probes/r18/cli.mjs --out-dir r18-output
```

第三条命令无网络来源，必须输出 UNKNOWN，报告中 sessions 应为空。生产cron没有启用。
