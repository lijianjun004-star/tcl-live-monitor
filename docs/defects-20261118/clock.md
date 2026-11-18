# 时钟、持久化与认证反馈修复报告

日期：北京时间 2026-11-18。基于 PR109 `b4837f0aac8ef6b79789bb6fb3282ac895b68809`。本报告描述离线候选，未正式合并、部署、触发工作流或改变生产配置；修复提交 SHA 由总交付报告记录。

## 缺陷台账

| 编号 | 出处与复现 | 根因和影响 | 修复与回归 | 状态 |
|---|---|---|---|---|
| CLK-01 | 任务书“跨轮账本、原子 CAS/租约”；integration README 时钟阻塞。相同 revision 的两个 READY 副本分别执行 attempt-a/attempt-b，旧纯模型两次 accepted=true | 原实现只提供可序列化内存模型，没有实际存储；若误接入发送路径，无法互斥。旧 Worker 已阻塞，未证明生产重复派发 | 新增 LocalRelayStore 排他目录锁、版本 CAS、租约与完整快照；相同场景只有一次 accepted。两个真实子进程同轮竞争也只有一次写入，重新实例化仍见 PENDING | 已修并离线实测；候选未生产生效 |
| CLK-02 | 任务书“认证反馈”；旧模型仅填 feedbackReviewed=true、runId、evidenceRef 即可将 PENDING 改 READY | reviewed 是调用者声明，没有认证，也未精确绑定 repository/workflow/ref/head SHA/runAttempt | 新适配器拒绝同一未签名 SOURCE_RESULT；HMAC 与 action 权限验证，先 RUN_BOUND 后逐字段匹配；nonce、revision、身份回收和时间反序均拒绝。复核使用独立 action 权限和确切状态摘要 | 已修并离线实测；真实签名者及关联证据外部阻塞 |
| CLK-03 | 任务书“文件事务、断电、坏文件、多进程、目录竞态” | 若分别存模型与重放记录，会留下状态已释放但 nonce 未落盘的窗口；异常清锁可能放行不确定结果 | 模型、绑定、nonce、认证审计同一权威快照。5 个发布阶段真实子进程 exit(73) 后保留锁；旧或完整新快照均不可继续预留。写失败、坏 JSON、目录替换、废弃锁都阻塞；所有权与目录身份在发布/释放前复查 | 已修并离线实测；Windows symlink 测试 NOT RUN，真实断电 NOT RUN |
| CLK-04 | #105 / external/cloudflare-jd-clock/SAFETY-REVIEW-20261117.md 超时、重定向、失败退避与默认零派发 | 旧候选已实现传输安全门禁，但仍需本轮复验，HTTP 接受不能当来源成功 | 本轮复验超时/中止/不合作传输/无重试/重定向拒绝/错误脱敏。接受保持 PENDING；未知保持 REVIEW_REQUIRED；过期租约和退避不自行释放。Worker 和定时入口仍零请求 | 原候选本轮复验通过；生产接入未启用 |

## 证据与命令

- `../evidence/clock-baseline-gaps.log`：原内存模型两个同版 READY 都接受预留，未认证声明可释放；该定向缺口脚本按预期返回 1。它证明原模型能力缺口，不代表旧 Worker 曾派发或模拟结果就是平台事实。
- `../evidence/clock-first-node24.log`：新增适配器首轮测试失败，发现对整个快照按键排序会破坏原模型基于插入顺序的摘要。修复为保留模型 JSON 顺序，仅外层快照摘要采用 canonical。保留该失败日志，不用最终通过掩盖迭代。
- `../evidence/clock-node24.log`：实际 Node `v24.18.0`，Windows。命令：`node --test experiments/relay-ledger/*.test.mjs external/cloudflare-jd-clock/tests/*.test.mjs`。退出码 **0**；**43 tests，42 PASS，0 FAIL，1 SKIP**。其中新增 17 项持久化/认证测试。
- 测试设置 `TEMP`、`TMP` 为仓库同级 `test-tmp`，`NODE_OPTIONS=--require=<仓库绝对路径>/scripts/offline-test-guard.cjs`。只运行离线文件操作、合成密钥、假 HTTP 响应；子进程继承网络护栏。
- 唯一 SKIP：Windows 权限拒绝创建合成符号链接。代码路径有测试，当前环境 **NOT RUN**，不能计作通过。

## 尚未验收与唯一所缺材料

1. **真实存储接入阻塞**：需明确已有获批存储后端、权限与预算。当前仅完成本地文件适配及协议，未创建服务、账户、绑定或费用。不能用文件锁声称跨云分布式 exactly-once。
2. **真实反馈认证阻塞**：需获批的可信关联服务/签名者，提供 attempt→仓库/工作流/ref/run/attempt/head SHA 的独立可验证证据，以及密钥托管与轮换配置。测试中的合成密钥、reviewRef、evidenceRef 不代表任何真实批准。
3. **真实断电 NOT RUN**：Windows 返回 `FILE_SYNC_ONLY`，只能据已运行测试说明进程退出和文件错误会阻塞；Node 目录 fsync 不可用，不能承诺突然断电后的持久顺序。需在最终获批存储环境单独验证掉电与回滚恢复。
4. **文件系统威胁边界**：可信私有目录和配合协议的进程。拒绝已存在符号链接/文件硬链接，检查目录身份变化；不声称抵抗拥有父目录改名权限的恶意本机用户、NFS/历史快照回滚或失陷签名者。废弃锁不按时间或 PID 自动删除。
5. Node22、Linux 目录同步、真实 Cloudflare/GitHub 工作流链路与生产频率可靠性，均以总交付实际执行结果为准；本子项没有进行这些真实环境验收。未访问平台、调用模型 API、改 cron/pin/权限或执行部署。

接口与认证消息精确字段见 `experiments/relay-ledger/README.md`。旧纯模型仍明确标记为 SIMULATION，不能绕过新增适配器直接作为生产决策依据。
