# 抖音／天猫恢复与证据加密：本轮修复记录

基线为 PR109 `b4837f0aac8ef6b79789bb6fb3282ac895b68809`。本文件记录 2026-11-18 离线修复；所有输入、账号标识、密钥和停止场景均为合成夹具。没有真实采集、恢复受限访问、修改生产配置或创建恢复批准。

## 缺陷、复现与修复

| 编号 | 出处与影响 | 本轮复现／根因 | 候选修复与回归 |
|---|---|---|---|
| REC-01 | 任务书天猫本地标记保护／`tmall-ledger-recovery.mjs begin` | 已有 `SOURCE_STOP_REVIEW_REQUIRED` 时 begin 仍退出 0，并覆盖为 `SAMPLE_INCOMPLETE`；后续 finish 可消除原限制 | begin 在独占锁内拒绝任何已有阻塞，独占创建绑定 runId、runAttempt、startedAt 的采样标记；同输入失败→通过 |
| REC-02 | 任务书并发／崩溃／`finishSample` | run200 可删除 run99 的同名采样标记，只检查 reason，没有所有权和本次导入时效 | finish 核对运行／重试次数／开始时间及本次 receipt 已落账；异轮标记保留；同输入失败→通过 |
| REC-03 | 任务书文件事务／恢复写失败 | 账本原子 rename 抛错被 JSON 解析的宽泛 catch 吞掉；有效恢复链仍能返回 skip=false，且直接调用没有预先写阻塞 | 恢复在第一笔数据写入前持久化阻塞；只捕获解析错误，写失败向上传播；所有数据及审计落盘后才能去除阻塞；注入 rename 错误失败→通过 |
| REC-04 | 任务书抖音失败轮恢复／来源可信性 | 旧恢复脚本只信任 run-list 元数据，无仓库、分支、workflow、事件或重试次数核验；可覆盖较新本地停止证据，接受 synthetic／过旧／异平台账本 | 下载前验证完整 GitHub run provenance；恢复拒绝已有本地状态；仅接受最近 7 天、非未来、Douyin、schema-real 账本；坏冷却链持续不可复核放行 |
| REC-05 | 任务书停止先持久化／抖音工作流 | 抖音旧 pass 函数在写 cooldown 之前导入 receipt；导入器失败或取消会跳过停止记录 | 将原四组采样流程抽到 `douyin-sample-once.sh`；开始即写持久标记，停止信息先写再导入，首轮失败不再采后续组；成功仅清本轮标记 |
| REC-06 | 任务书加密往返／实际 Windows OpenSSL 路径 | 实测 OpenSSL `rand -hex` 在 Windows 输出 CRLF；严格 HMAC 密钥解析拒绝它，真实 RSA/CBC/HMAC 夹具退出 1 | 仅移除 CR，保留 64 hex 和换行、256 bit 随机性；相同 RSA 解包／完整性／CBC 往返测试失败→通过 |
| REC-07 | 任务书原子发布／多进程 | 固定临时文件名可跨进程竞争；加密流程会移除另一个执行者的旧密文或尚未处理的私有目录 | 恢复操作用本地 mkdir 独占锁、随机 wx 临时文件、文件 fsync 和 rename；加密锁覆盖读取、发布和清理全流程；竞争者只失败，不删除已有证据 |
| REC-08 | 任务书恢复批准绑定／迁移不解锁 | 抖音恢复批准只绑 runId，不区分 GitHub rerun attempt，日期解析过宽 | 新候选要求 runAttempt 和规范 UTC 日期；旧不完整批准不放行。未生成任何批准材料 |
| REC-09 | 本轮交叉审查／文件增长与锁替换 | stat 后直接 readFileSync 可被并发增长突破读取上限；仅检查父目录未绑定锁目录／所有者 | 分块读取总量严格不超过 12MiB+1 并核对读后元数据；锁绑定 inode 和随机 owner，发布／删除安全标记／释放前核验，换锁不发布且不删除他人锁；故障注入已测 |

REC-01～03 的原始失败日志为交付证据中的 `recovery-regression-before.log`：3 tests / 0 pass / 3 fail / 0 skip，退出码 1。修复后同一用例见 `recovery-regression-after.log`：3 / 3 / 0 / 0，退出码 0。辅助直接复现为 `recovery-before.jsonl`。

REC-06 的原始失败位于 `recovery-host-iteration.log`：36 tests / 35 pass / 1 fail / 0 skip，失败点为完整加密脚本，退出码 1。随后 `recovery-host-after.log` 为 40 / 40 / 0 / 0，退出码 0；后续新增覆盖的最终结果以总报告和 `recovery-final-node24.log` 为准。

包含 REC-09 交叉审查修复后的最终恢复专项：`recovery-final-node24.log`，48 tests / 48 PASS / 0 FAIL / 0 SKIP，退出码 0。五个相关 Bash 脚本语法检查退出码 0。此前沙箱内符号链接测试因 EPERM 失败，本机获准环境中的同一用例已实测通过，没有改成跳过。

## 实际验证与边界

本轮本机 Node `v24.18.0`；使用真实本地 Git Bash 和 OpenSSL，但只处理合成夹具。命令：

```text
node --require ./scripts/offline-test-guard.cjs --test tests/recovery.test.mjs tests/tmall-ledger-recovery.test.mjs tests/recovery-race-regression.test.mjs tests/r326/scheduled-workflow.test.mjs
bash -n scripts/restore-douyin-ledger.sh scripts/douyin-sample-once.sh scripts/encrypt-douyin-evidence.sh scripts/restore-tmall-ledger.sh scripts/tmall-sample-once.sh
```

Windows 沙箱不能创建 Git Bash 所需 NT 对象，实际 Bash 回归在获准的本机执行环境运行；将 `Git/usr/bin` 放在 `Git/bin` 前，确保测试 gh/sleep 替身优先。TEMP/TMP 指向工作区临时目录。Node 继承离线网络护栏，HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 指向 `http://127.0.0.1:9`，只豁免回环地址；不调用真实 gh API、平台或任何模型。

覆盖 NUL／二进制换行口令原缺陷机制、64hex 往返、篡改密文／密钥／HMAC、错误密钥、无输入清理、原子发布、竞争加密不删除证据、失败／取消来源恢复、缺失或损坏账本／冷却、旧成功不可覆盖本地较新停止、来源 provenance、审核时效和重试次数、先停止后导入、四组采样顺序保持、独立进程争用、进程强制终止后锁不被自动夺取、链接父目录拒绝。

本地文件协议是可信私有目录中合作进程的互斥和失败闭锁机制；不声称两个 rename 构成跨文件原子事务。天猫 manifest 摘要可检出混合或丢失快照；不完整恢复或采样保留阻塞。恢复锁不自动过期，崩溃后需人工核查，不能以删除安全标记恢复访问。目录身份在锁内检查，仍要求父目录由操作者控制，不承诺恶意同机用户更换父目录时的内核级隔离。

进程强制终止注入已经测试；真实物理断电／磁盘控制器缓存丢失为 NOT RUN。Linux 代码会 fsync 父目录；Windows 不提供同等目录 fsync 保证，不能据本轮 Windows 结果承诺断电持久性。SIGKILL 或主机崩溃不会执行私有证据清理，残留只在不上传的临时路径，仍依赖 runner 销毁；不是安全擦除。

Node22、Linux 生产 runner、真实 GitHub 下载恢复、生产公私钥兼容性、真实身份／来源、实际访问恢复以及外部模型复验，均须以总报告独立记录的实测为准；本子任务没有执行这些外部验收。代码均为候选，尚未生产生效。

工作流仅把原采样 run 正文替换为脚本；schedule、workflow_dispatch、main-only、只读权限、并发组、四组既有目标、组间 5 秒、保留期和 Artifact 输入边界不变。不得把本报告理解为批准合并、部署或解除冷却。
