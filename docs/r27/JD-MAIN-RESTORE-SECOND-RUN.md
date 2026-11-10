# R2.7｜京东 main 跨运行状态恢复二次实测

## 基线（2026-11-11 北京时间）

- 正式 main SHA：`b5cc0fd3653b9ce90e019ff8dbb45a21b56aa978`。
- 正式 main 一轮真实只读巡检：Actions run `42854763283`，LIVE 6、UNKNOWN 1、OFFLINE 0，状态上报完整，来源目录仍 PARTIAL。
- 已真实上传 `r24-jd-main-state`，Artifact ID `13782840738`，包含7次房间检查。
- 暂无 `event=schedule` 运行，不能声称自动 cron 通过。

## 本次变更

本次只改已有 main 工作流、其质量测试与本报告，且不修改 Pages。

在第二次 **受控 main 合并冒烟** 中，合并提交同时含有 `[jd-main-smoke]` 和 `[jd-main-smoke-2]` 时：
1. 先从同仓库 main 专属 Artifact 恢复上次保存的 JSON；
2. 校验 schema=23、平台=jd、房间≥7、checks≥7、存在上次 run_id 和合法时间；
3. **未恢复则报错终止，绝不静默重置成一个全新历史**；
4. 否则照原只读链路扫描一次，记录上一轮/当前 checks 计数；
5. 从 GitHub run log 验证两个连续 main run 的证据，而不是只看测试通过。

正常 `schedule` 与 `workflow_dispatch` 无须存在历史文件，第一次运行仍能安全建立初始状态；之前 7 天 Artifact 隔离口径保持不变。

## 不涉及

不新增京东源访问权限，不抓取凭证，不回避验证码，不购买，不覆盖 GitHub Pages，不新增真人/数字人自动识别，不把 UNKNOWN 算作 OFFLINE。

## 成功门槛

必须同时有：
- PR 离线质量测试通过、扫描源 SHA 不变；
- 第二个 main `push` 扫描执行成功，日志中含 `R27_MAIN_CONTINUITY_RESTORED`，既有 run_id 和 7 以上原始检查；
- 新的 main Artifact 成功上传，检查行数大于上一轮且有最新的现场结果；
- **真正 GitHub `schedule` 事件仍需独立实测**。

## 90 天留存方向

当前链路使用 7 天滚动状态包；每个状态包内部只保留 7 天检查记录，90 天状态变化事件只是逻辑窗口，不是 90 天外部持久保存。不得把现有方案叫做 90 天持久审计。

下一阶段优先用每日脱敏摘要（固定低频、保留90天）与短期滚动状态拆离。上线前核查 GitHub 账户储存配额与组织/仓库限制，防止每5分钟保存完整90天快照造成免费的额度耗尽；且需要真实 `schedule` 触发才能逐日积累。
