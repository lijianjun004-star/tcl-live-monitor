# 离线派发账本与本地持久化适配（不能启用生产派发）

`model.mjs` 保留原有纯状态转换模拟。`durable-store.mjs` 新增实际文件读写、跨进程互斥和 CAS；`feedback.mjs` 新增认证反馈协议。它们均不被 Worker 导入，不联网，不加载环境变量密钥，不产生派发。所有操作结果的 `dispatch` 始终为 `false`，成功写入也返回 `productionReady:false`。这里的 `accepted` 只表示离线状态操作被接受。

## 状态与权威文件

READY → PENDING → SOURCE_BACKOFF / REVIEW_REQUIRED；HTTP 接受仍是 PENDING，超时结果未知仍阻塞。来源失败使用显式传入的 `reviewDelayMs`，没有猜测生产退避时长。时间届满不自动恢复访问；必须另有绑定摘要的认证复核。

`snapshot.json` 是唯一权威文件，同一快照原子保存模型、revision、租约、目标、run 绑定、已用 nonce 和反馈审计；不存在两个独立 rename 拼成的跨文件事务。写入先创建 `writer.lock` 排他目录、写入并 fsync 所有权标识，再写随机新临时文件、fsync、rename、同步父目录，最后释放自己的锁。异常会保留锁，读取和后续写入均阻塞。

- `LocalRelayStore.create(directory,{now,reviewRef})` 仅能显式初始化一个不存在的新目录；`reviewRef` 仍只是离线初始化输入，不代表真人批准。
- `read()` 返回完整快照；缺失、损坏、悬而未决的锁不能初始化为 READY。
- `reserve({expectedRevision,attemptId,slotMs,now,target,leaseOwner,leaseUntil})` 在锁内核对 CAS。两个进程拿到相同 revision，只有一个可写入。历史 attemptId 与已用 run/attempt 不可重复使用。
- `recordTransport({expectedRevision,attemptId,now,leaseOwner,outcome})` 只接受有效租约所有者的 `ACCEPTED` 或 `UNCERTAIN`。租约过期不解锁、不重发、不覆盖原状态。认证的迟到来源结果仍可解除真正对应的待定记录。
- `applyFeedback(envelope,{keys,now,maxLifetimeMs})` 必须通过下述认证，不能直接把 `feedbackReviewed:true` 写入适配器。默认消息有效期上限 300000 毫秒，这是离线协议上限，不是采样或退避策略。

`writer.lock` 永不按 PID、年龄或租约期限自动清除。取消或进程崩溃后需保存整个目录并人工审查原快照、临时文件、锁及发送结果；本候选没有自动解锁 API。容量达到 1000 条审计或 2 MiB 时阻塞，不静默删除历史。

## 认证关联契约

每个消息使用 HMAC-SHA256，输入为 `tcl-relay-feedback-v1\n` 加 `canonical(payload)`；密钥至少 32 字节。`keys` 是调用者提供的受信密钥映射，每个值为 `{secret:Buffer,actions:[...]}`。来源反馈密钥仅有 `RUN_BOUND`/`SOURCE_RESULT` 权限，复核密钥仅有 `REVIEW_RELEASE` 权限；适配器不会安装或生成真实密钥。

所有 payload 必须精确包含：`schemaVersion=1`、`keyId`、唯一 `nonce`、`issuedAt`、`expiresAt`、`expectedRevision`、`action`、`attemptId`、`target={repository,workflow,ref,headSha}`、`run={runId,runAttempt}`。目标固定为本仓库、`jd-r33-backup.yml`、`main`，headSha 为明确 40 位小写 SHA；runId 为字符串。

1. `RUN_BOUND`：受信关联者必须先证明这一 attempt 与确切 run/attempt/head SHA 的关系。仅“最新成功”、时间邻近或 GitHub 接受 POST 均不够。
2. `SOURCE_RESULT`：额外字段为 `outcome`、`evidenceRef`、`reviewDelayMs`；成功时 delay 必须为 null，失败时必须为正整数。所有关联字段必须与当前绑定逐项相同。
3. `REVIEW_RELEASE`：额外字段为 `reviewRef`、`expectedStateHash`，绑定整个模型摘要且不得早于退避复核时间。需该 action 专用权限的密钥。

签名错误、未知字段、未知密钥、错权限、过期、未来时间、错 revision、重复 nonce、错目标或 run 均不更新状态。快照保留每条认证事件的目标、run/attempt、keyId、payload 摘要和前条摘要，跨轮仍可审计。普通 SHA 摘要只检测意外损坏，不是本地文件防篡改签名。

HMAC 证明消息来自所配置的密钥持有者，**不自行证明 GitHub 执行、平台来源或真人批准属实**。当前不存在已批准的可信关联服务、生产回调、签名密钥或云存储绑定，不能据此解除生产门禁。

## 文件系统边界

父目录必须是用户控制、无符号链接的本地私有目录，所有写者使用本适配器。适配器拒绝符号链接、硬链接快照；锁定时记录目录身份，在发布和解锁前复查，普通目录替换会失败并保留原锁。并发写入、真实子进程竞争及进程异常退出已经做故障注入。

这不是对恶意本机用户、可任意重命名父目录的攻击者、NFS、磁盘历史回滚或失陷签名者的安全隔离；路径检查不能取代操作系统沙箱或可信目录所有权。

Windows Node 无法同步目录项时明确返回 `FILE_SYNC_ONLY`，不能作为断电持久性验收；支持目录 fsync 的本地系统返回 `FILE_AND_DIRECTORY_SYNC`。本轮测试是进程退出与写失败注入，没有实际断电。生产接入需在获批存储上验证原子 CAS、持久预留、租约、提交可见性及故障恢复；不得把这个本地适配器当成 Cloudflare 的分布式存储。

## 回归

`node --test experiments/relay-ledger/*.test.mjs external/cloudflare-jd-clock/tests/*.test.mjs`

统一入口 `node scripts/test-offline-all.mjs` 自动包含本目录。测试使用固定合成密钥、本地文件与假 HTTP 响应，不读取任何真实凭据或来源。详见 `docs/defects-20261118/clock.md`；未新增依赖、云服务、账户、费用或生产配置。
