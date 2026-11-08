# Agent E｜调度、场次、冷却与持久化

任务：R18-20261108，执行者：Codex 子智能体 E；来源：用户 R1.8 接力包，基线 `b940f90ba2c901cdbb8aea334304c0183959f1b1`。本轮无外部模型/API费用、未调用 Gemini、未启用生产 cron。

## 实现结果

- `probes/r18/core/scheduler.mjs`：北京时间每小时整点（UTC整数小时等价）、planned/actual 分离；hourly 按平台账号/计划小时生成稳定SHA256幂等键；manual 默认UUID，每次独立，同 request_id 重交去重。
- `probes/r18/core/sessions.mjs`：同账号新liveId新建场次，旧场 `REPLACED_BY_NEW_LIVE_ID`；同liveId换room仍同场；两次不同观测时间的有效OFFLINE才 `CLOSED`；UNKNOWN中断证据链。开始仅记首次观测，结束仅记窗口，所有精确时间标记false。
- `probes/r18/core/monitor.mjs`：每次至多一个来源调用；冷却内包括手动请求均不访问来源；不自动重试；持久化 next_eligible_at。浏览器响应实际完成时间可以晚于启动时间，planned及幂等键仍固定。目标级文件锁覆盖整个异步来源访问，防止同目标并发请求放大。
- `probes/r18/store/index.mjs`：ObservationStore/SessionStore/EvidenceStore共享同一DurableStore事务；重读当前快照→核验身份和来源→相同时刻矛盾证据降UNKNOWN→按时间重建场次→写入安全证据摘要、幂等索引、冷却→递增revision→原子提交。提供 expected_revision 乐观冲突检测。
- 存储为单一JSON envelope及SHA256校验，文件权限0600，目录0700；临时文件fsync、rename、目录fsync。排他写锁、进程存活检查、死进程写锁回收；无法识别的锁阻断，不按经过时间偷锁。
- 支持v1规范化观测快照向v2索引/场次迁移。持久化备份有独立校验；损坏主文件默认抛错，不静默回滚。显式 `recoverBackup()` 才恢复备份，并将损坏文件隔离。孤儿事务临时文件不参与恢复，可在下一次正常写事务清理。
- runCheck可信层为每次记录生成 evidence_ref 和最小摘要；只保留时间、观测关联ID、HTTP状态、body SHA256、标准原因码，不保存URL、headers、正文、Cookie或会话。

## 已执行验证

状态：PASS（离线实现验证，非真实平台端到端）。

```sh
node --check probes/r18/core/monitor.mjs
node --check probes/r18/store/index.mjs
node --test tests/r18-core.test.mjs tests/r18-store.test.mjs tests/r18-integration.test.mjs
```

最后一次执行上述测试得到31通过、0失败。测试由独立Agent F维护；另独立运行临时目录smoke，验证新liveId替换/两次OFFLINE、并发来源只调用一次、冷却无重复访问、最小证据落盘。最终全量数量以主控测试矩阵为准。

## 边界及未执行

- 此Store是单主机本地文件系统实验底座。跨GitHub Actions长期持久化、24小时无人值守及真实平台场次发现：NOT_EXECUTED，不能据此声称上线。
- 来源代码层 source_attested 是受信适配器边界，不是对任意外部JSON的密码学认证；导入CLI不得把外部自报true当实测证据。
- `.source-*.lock` 在源访问进程崩溃后会保留，下一次请求保守拒绝，需管理员核对进程后移除；不会自动高频重试。`.write.lock` 有死进程回收机制。PID复用时可能保守阻断，不能冒险偷锁。
- 备份通常比主快照少一个事务；显式恢复可能丢失最近记录，恢复报告必须明确这一点。损坏主文件不会自动退回备份。
- 未加入第三方代码，使用Node内置API重新实现。未改变main、既有R1.7核心文件、生产工作流或其它仓库。

下一锁：由主控汇合真实公开页面证据后，仅解人工正常登录会话采集与身份交叉核验这一锁；没有有效来源时保持UNKNOWN。
