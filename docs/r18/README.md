# R1.8 可复验安全实验

基于 R1.7 head 的独立实验，Node.js 22+，离线底座无需 npm 依赖。

```bash
node --test tests/*.test.mjs
# 默认不访问任何平台；生成 UNKNOWN 观测与移动端报告。
node probes/r18/cli.mjs --out-dir r18-output
# 同一 request-id 重试幂等；不同 request-id 为独立手动观测。
node probes/r18/cli.mjs --out-dir r18-output --request-id manual-001
# 模拟计划整点；这是一次执行，不启动 cron。
node probes/r18/cli.mjs --out-dir r18-output --mode hourly --planned-at 2026-11-08T20:00:00+08:00
# 明确的一次普通公开 GET，无重试，适用于完成冷却后的正常检查。
node probes/r18/cli.mjs --out-dir r18-output --public-page
# 仅在用户已经正常登录自己的外置 Profile 后显式运行。
# 需自行可用的 Playwright/Chromium 和显示环境；默认不自动安装或登录。
node probes/r18/cli.mjs --out-dir r18-output --browser-session --profile-dir /absolute/path/outside-repository
```

打开 `r18-output/report.html` 或读取 `report.json`。本地单机持久化为 `r18-output/store/`，共享一次原子事务，包含观测、场次、证据摘要、幂等键及冷却。默认失败冷却 60 分钟，手动也不能绕过。同目录备份恢复必须显式调用 `recoverBackup()`，损坏数据不会静默清空。

库接口：`schema.mjs`、`core/monitor.mjs`、`core/scheduler.mjs`、`store/index.mjs`。JD/Douyin adapter 接受公开 capture/snapshot 注入；CLI 首店固定淘宝，不接受外来 JSON 把 source_attested 自行声明成实时证据。来源证明是可信采集代码边界，并非加密平台证明。

会话 Profile 外置，不把 Cookie、登录凭据或原始响应上传。正常登录/人工验证码必须由用户自己在受信浏览器完成；本实验不自动操作登录。浏览器仅收集正常页面已触发的响应，暂未验证迟到异步响应覆盖率。

范围限制：没有正式监控、24h 服务、跨 GitHub Actions 持续数据存储、合并或部署。离线 CI 的 artifact 只是证据文件，不是长期监控数据库。上下播时间均为观测窗口。真实验收以 TEST-MATRIX.md 为准。
