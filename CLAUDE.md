# 项目说明（给 AI 协作者）

权威上下文：[`docs/AI_CONTEXT.md`](docs/AI_CONTEXT.md)、[`docs/可行性审计-2026-11-04.md`](docs/可行性审计-2026-11-04.md)。

- 本仓库只做 TCL 京东/天猫/抖音直播监控与满播率考核，不是练播房项目。
- `UNKNOWN` 永远不等于 `OFFLINE`；没有证据的 OFFLINE 一律降级为 UNKNOWN。
- 只有 `status === 'FINAL'` 的场次才能扣分；`config/platform-sources.json` 中未验证的平台不能产生 FINAL。
- 禁止：登录绕过、验证码绕过、签名仿造、索要账号密码/Cookie/Token；不得新增 cron 或付费资源，除非用户明确同意。
- 测试：`npm test`（Node 22，无依赖）。
