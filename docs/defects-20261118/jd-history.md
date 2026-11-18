# 京东来源、历史与文件事务修复记录（2026-11-18）

基线：PR109 `b4837f0aac8ef6b79789bb6fb3282ac895b68809`。所有变更为独立分支候选；**未合并、未部署，r23 生产 pin 未改，真实来源恢复未验证**。修复提交 SHA 以根交付报告的最终提交为准。

## 缺陷台账

| 编号 | 出处 / 复现与影响 | 根因 / 本轮处理 | 回归证据 | 生产状态 |
|---|---|---|---|---|
| JD-01 | 任务书京东来源、#102：部分请求失败应保留成功行、非零退出且不泄漏错误 URL/Token | 复验已有 r21/r23 候选：安全错误分类、失败房间不刷新观测时间、总失败保留旧历史并变为 UNKNOWN；Windows CLI 测试改用 `pathToFileURL` | `jd-source-reliability`、`r23-jd-unattended`、`post107-reliability` | 已修候选，本轮复验；固定生产 pin 未激活 |
| JD-02 | 任务书文件事务、#108：summary 目标是目录时，旧 CLI 已覆盖 state 后才失败 | 写前验证输出布局和类型；同目录排他锁覆盖读取、比较、计算和发布；单一权威 state 内嵌对应 summary、generation 和摘要；summary 为可验证视图 | 新回归 9 项基线 0 PASS / 9 FAIL，修复后 9 PASS；`jd-history-files` 11 PASS | 本轮修复候选 |
| JD-03 | 两个不同 state 路径共用 summary 可绕开单一 state 锁；被替换锁未验证所有权会继续写/删除别轮锁 | 目录级排他锁覆盖输出别名；旧 previous 不可覆盖新 state；每个 checkpoint、rename 前及释放前检查两锁 inode、普通文件身份及有界读取的唯一 id | `jd-lock-alias-before.log` 1 FAIL → PASS；`jd-lock-ownership-before.log` 9 FAIL → 对应项全 PASS；真实两个 Node 进程 | 本轮修复候选 |
| JD-04 | `docs/jd102-activation-and-retention-review-20261117.md`：r327 catalog 抛错不保存失败轮，逐房异常被吞且退出 0 | 独立有界扫描函数，catalog/逐房错误转固定码；保留成功行和旧历史；失败/部分失败保存后退出 2；新增最后尝试、响应观测、最后有效来源时间 | 新回归 catalog/partial CLI 同输入 FAIL → PASS；纯函数测试时间分离与总失败连续性 | 本轮修复候选；r327 与 r23 为独立链 |
| JD-05 | r327 显式 previous 缺失会初始化；保留快照时间坏值、逆序运行未拒绝 | 读前校验且在任何来源请求前失败；只有 `--previous -` 明确允许空基线；null/数组不可伪装空基线；验证房间、日期、读数和时间顺序 | 缺文件、坏时间、倒退时钟、null/数组文件回归 | 本轮修复候选 |
| JD-06 | r327 成功响应缺某日会制造 0 分钟；null/空串/布尔被转成 0；旧观测缺少来源状态说明 | 缺日保留 UNKNOWN、显式 0 才是 0；空响应不刷新有效来源时间；输出历史观测时间、来源轴、`currentState=UNKNOWN`、`formalAttendanceReady=false`、`formalRatePercent=null` | 新回归缺日/强制转换/报告语义 FAIL → PASS；空响应和历史失效测试 | 本轮修复候选；原有百分比仅历史采集覆盖估算 |
| JD-07 | r327 latest-success 恢复跳过失败/取消轮，损坏或下载失败后可静默空初始化 | 只选择最近 completed main 本仓库同 workflow 运行；较新失败/取消不能回退旧成功；缺件、坏摘要、混代、lock/block 均持续阻塞；保存失败状态后最终 gate 检查来源及上传结果 | 策略测试；真实 Bash + fake gh 3 PASS：失败轮正确恢复、缺件与中断均保存阻塞标记 | 本轮 workflow 正文候选；未执行线上工作流 |

## 文件事务及恢复契约

`probes/lib/history-files.mjs` 被 r23 与 r327 CLI 共用。state 是唯一权威快照，包含 `_historyCommit`（generation、原始 state 摘要、summary 摘要及 summary 本体）；summary 文件带相同 generation。这不是两次 rename 的原子事务。独立 summary 可能在进程死亡后滞后，读取双方时必须通过 `verifyHistoryPair`；r33 备份门禁内置等价验证，保留其单文件 sparse-checkout 能力。旧 schema 没有这些字段时兼容读取，但不声称旧双文件具有 generation 完整性证明。

本地 `.jd-history.lock` 与 `<state>.lock` 用排他创建获得，锁覆盖读改写；陈旧 previous 不能覆盖新一代。写前检查目标同目录、非符号链接/硬链接、可读类型和尺寸，输入有界读取，临时文件排他创建并 flush。父目录身份在发布前后复核。正常提交后清理锁；发布前可处理的失败清理临时文件；发布中断、进程被杀或目录身份改变后不自动解锁或重试。

真实子进程 `SIGKILL` 已覆盖临时文件准备后及 state 发布后两个窗口；恢复只能读到先前完整状态或可校验的新权威状态，不会以旧 summary 配对放行。中断锁必须保留供人工审查。需要恢复时，应先保全原目录，在新的受控目录验证权威 state 内嵌摘要及 summary，并核对原运行/来源；本候选没有自动清锁命令或伪造解除批准。

**明确限制**：契约要求可信本地独立工作目录，不用于恶意同机用户可修改的父目录、网络文件系统或分布式锁。Node 无法在所有平台提供基于目录句柄的无竞态操作，本轮检测目录交换但不声称抵御所有 TOCTOU。POSIX 请求文件及目录 fsync；Windows 请求文件 fsync，Node 的 Windows 路径不提供等价目录 fsync。实际断电、磁盘缓存丢失、存储硬件保证未测（NOT RUN），进程终止测试不能替代这些验收。12 MiB 输入/输出上限会在发布前拒绝过大快照，不能据 100,000 条上限声称实际容量无限。

## 本轮命令和证据

运行环境：Windows、Node v24.18.0；测试使用虚构输入、Node 离线 TCP/DNS/UDP 护栏。Bash 测试使用 Git Bash、fake `gh`，HTTP/HTTPS/ALL_PROXY 指向 `127.0.0.1:9`，不访问真实来源。文件系统测试 TEMP/TMP 指向工作目录中的 `work/test-tmp`。

实际命令（在仓库根）：

```text
node --test tests/jd-defects-20261118.test.mjs
node --test --test-name-pattern="different state paths" tests/jd-history-files.test.mjs
node --test tests/jd-history-files.test.mjs
node --test tests/r327/restore-shell.test.mjs
node --test tests/jd-source-reliability.test.mjs tests/r23-jd-unattended.test.mjs tests/post107-reliability.test.mjs tests/jd-defects-20261118.test.mjs tests/jd-history-files.test.mjs tests/r33-jd-backup-freshness.test.mjs tests/r34-jd-backup-atomic-recheck.test.mjs tests/r327/*.test.mjs
```

日志由根交付包一并收录，工作副本在 `work/evidence/`：

- `jd-new-baseline.log`：9 项，0 PASS / 9 FAIL / 0 SKIP，退出 1。原候选实际失败，非旧 PR 引述。
- `jd-new-after.log`：同 9 项，9 PASS / 0 FAIL / 0 SKIP，退出 0。
- `jd-lock-alias-before.log`：共享 summary 的异名 state 并发缺口实际 1 FAIL，退出 1。
- `jd-transactions.log`：11 PASS / 0 FAIL / 0 SKIP，退出 0，含修复后的异名并发测试。
- `jd-restore-shell.log`：3 PASS / 0 FAIL / 0 SKIP，退出 0。
- `jd-lock-ownership-before.log`：8 种锁替换窗口加目录锁恢复共 9 FAIL，退出 1；`jd-lock-ownership-after.log` 对应修复及相关 36 项 PASS，退出 0（含新增目录锁实际 Bash 恢复）。r327 artifact 显式保存两个锁，限定文件列表启用 hidden files；恢复时验证仓库 full_name、run_attempt 和 conclusion 白名单。
- `jd-complete-node24.log`：阶段性 99 PASS / 0 FAIL / 0 SKIP，退出 0；随后增加异名并发第 100 项并单独验证，最终全部版本和完整统计以根回归日志为准。
- `jd-final-node24.log`：最终京东相关 109 PASS / 0 FAIL / 0 SKIP，退出 0。包含锁所有权、目录锁 Artifact 恢复、收窄 GH_TOKEN 至 restore 步骤后的代码。

Node22 及全仓库回归由集成阶段执行，本文件不提前声称通过。真实 GitHub artifact 恢复、真实来源请求、真实七房身份、物理断电及外部模型复核均 NOT RUN。

## 待批准的生产激活及回退

1. r23 两处 checkout 仍为 `267b6709a8563ef779cda6b11c97b9684c4e1c16`，普通源码合并不会激活。未来发布须选定最终不可变 SHA，分别审查 pin 与相关固定 SHA 校验。首次无 artifact 需要明确初始化路径，不能把缺失的显式 `--previous` 当作允许丢弃历史。
2. r23 未来还须把 `<state>.lock` 纳入失败恢复/保存契约，并确保所有配对消费者验证同一 generation。不能只更新 pin 后宣称文件持久化已完整接入。此次未改 r23 workflow。
3. r327 本次改动仅恢复、失败持久化、公开状态说明和最终 gate 的 workflow 正文；GH_TOKEN 从 job 环境收窄到唯一需要 gh 的 restore 步骤。cron、触发器、权限、并发组、保留期限不变。其来源请求仍一次 GET 遍历、不重试；未执行 workflow dispatch。
4. 获批发布后如异常，停止对应候选运行，保全新旧 state、summary、lock、block 和 run provenance，回退代码/pin 到经批准的前一版本；不得删除阻塞标记、混配 state/summary 或回退 latest-success 伪装连续性。旧消费者无法理解新快照时需审查数据迁移后再运行。

checks 7 天、events 90 天（均有条数上限）、Artifact 7 天、r327 截断 35 天且边界包含最多 36 个日期键的口径保持不变。这里没有可靠采样频率或正式满播率验收；七房公开身份、来源授权和可用性仍需真实材料。
