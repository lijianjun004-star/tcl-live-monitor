# Agent F｜测试、故障注入与独立复验

日期：2026-11-08 UTC。职责范围：仅新增 `tests/r18-*.test.mjs`、本报告、测试矩阵和测试证据，未修改业务实现、未提交、未切分支。

## 结果

旧回归251/251 PASS；新增46/46 PASS；最终完整回归297/297 PASS，0 FAIL、0 skipped、0 cancelled。完整原始输出 `../evidence/tests/full.tap`；矩阵 `../TEST-MATRIX.md`。

实际执行了 Node 测试、真实本地文件事务与临时目录CLI子进程。故障注入包括：原子替换前抛错、死进程锁与未提交临时文件、破损主文件、显式备份恢复、并发锁占用、旧revision、同时相反状态、同时间重复OFFLINE、来源访问异步并发。未把这些本地测试算作真实平台端到端验收。

覆盖固定身份/过期/attestation/推荐误报/动态room/liveId/UNKNOWN与OFFLINE证据链/小时与manual去重/失败冷却/迁移/安全字段过滤/HTML转义/浏览器Profile隔离，逐项详见矩阵。

## 发现与反馈

发现 schema 允许 `options.expectedAccountId` 覆盖固定淘宝账号2050532947，且Store传入check账号后可能绕过固定目标。已向D及主控报告，由D修复为淘宝始终固定账号。新增 `fixed tmall identity cannot be overridden by check metadata` 回归已通过。QA未自行修改业务代码。

主控发现并由D修复的失败原因覆盖问题已新增 `UNKNOWN fault reasons survive schema normalization` 回归。E补充整次来源访问互斥与同时间OFFLINE防重复后，新增并发来源只调用一次和重复OFFLINE不能确认停播回归，均通过。

## 安全复核

`git diff --check` PASS。高置信私钥/GitHub/OpenAI token格式扫描，以及Cookie/storage-state凭据文件名检查：扫描范围内无发现，见 `../evidence/tests/security-scan.json`。运行产物未包含截图或原始浏览器Profile；EvidenceStore拒绝原始body/cookie/url，仅白名单摘要字段。已有工作流不被修改；新增R18工作流仅离线测试与无来源CLI，不含schedule或写权限。`.gitignore`增加运行数据保护。

安全扫描是已执行格式与目录范围内的检查，不声称识别一切secret格式。真实平台证据仅摘要与哈希，不保存Cookie/Token/响应原文。

## 未通过/未执行边界

公开淘宝/JD/抖音各一次正常访问均未取得可核验直播状态（BLOCKED）；真实已登录淘宝会话、liveId及换场、回放、24小时连续运行、跨Actions长期持久化未执行。上述限制由各来源Agent证据及测试矩阵记录，不能以297个离线测试代替真实平台成功。

下一锁建议：有可交互正常浏览器及用户本人外置Profile时，人工登录后只执行一次固定账号页面被动响应核验；未满足真实平台门禁前保留草稿、不部署。
