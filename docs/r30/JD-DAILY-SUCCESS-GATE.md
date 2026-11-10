# 京东 R3.0｜90 天日归档“成功源站”准入补丁

日期：2026-11-11（北京时间）

## 真实基线

- `main` 合并 R2.9：`aa9da6d7502e380d2d6ed06aab0f65d9310ac4c0`
- 真正 main 云端运行 #42859806872 已完成：京东只读扫描、历史恢复、7 天滚动 Artifact、每日 90 天归档均成功。
- 首份 90 天归档 `r27-jd-daily-2026-11-11`，ID 13784423047，到期 2027-02-08 16:57 UTC。
- GitHub `schedule` 事件截至本轮查询仍为0；尚未完成真正自动触发验收。

## 修复的问题

原 R2.9 每日归档门禁只要求 `steps.state.outcome == success`。但 R2.3 设计允许源站失败后保守写入 UNKNOWN，且 source / accepted 作为 `continue-on-error:true` 继续执行，以保证历史状态不丢失。这种情况下 dailycheck 仍可能上传当天第一份日档，接着最终失败门禁标红；之后当日真实源站恢复时，因归档同名且已存在，反而无法保存当天首份成功观察的日档。

## 精确修复

每日检查点必须同时满足：
- 北京时间有效工作窗口；
- `state.outcome == success`；
- `source.outcome == success`；
- `accepted.outcome == success`；
- `github.ref == refs/heads/main`。

失败扫描仍保守保留 UNKNOWN 至滚动历史，但不能消耗一次/天的唯一成功归档。90天归档仍是时点快照，不代表当天逐分钟日志完整。

## 安全边界

无源站新增请求、无调度频率变化、无凭据读取方式变化、无 Pages 操作、无新增付费服务。
所有测试须由 GitHub Actions 实际运行证明；不以文件存在代替 CI。
