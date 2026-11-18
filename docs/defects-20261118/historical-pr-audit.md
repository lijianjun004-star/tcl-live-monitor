# 历史 Draft 相关性复核

本轮读取 `remote-prs-verified.json` 中 53 个开放 PR 的元数据，并对 #41、#69、#74、#77、#78、#81、#82、#83、#94 的提交树／相关实现与当前候选做只读对比。交接包原开放 PR 快照仅 30 条；本复核不是全部历史 issue、已关闭 PR 或每个实验模块的穷尽审计。PR 描述中的旧 CI、真实访问和外部模型结果均只作为历史主张，没有冒充本轮验证。

| PR／核对的 head | 分类 | 当前候选的相关性与处理 |
|---|---|---|
| #94 `33aea117` | 文档与协作规则，未合入 | 相对其 merge-base 只有 `AGENTS.md`、协作安全说明、PR 模板三项。没有运行时缺陷修复，不需要为完成本次任务合并。正式合并／发布待用户确认是本次用户直接约束；不会从旧草稿额外引入不适用的审批流程 |
| #41 `953a61de` | 不同实验链，不合入 | `probes/r25/jd-session-evidence.mjs` 实现两次独立负例和观测起止区间，当前树没有该模块。其依赖真实可信 OFFLINE 负例的条件尚未满足；`source_attested` 也只是输入声明。当前 r23、r327 与通用观测模型保持 UNKNOWN／不计算精确时长和正式满播率，不把实验功能缺失伪报成已验收停播识别 |
| #69 `26fe7511` | 原实验不合入；同类过期 LIVE 风险已覆盖 | 修复位于旧 `r311/douyin-catalog-reconcile.mjs` 与 `r36/douyin-ops-parity.mjs`，二者不在当前树。当前 `offline-observation/model.mjs` 独立限制观测／心跳／审定时效，r23 当前状态要求来源成功且逐房观测新鲜。旧“家电类目白名单”属于不存在的目录适配链，不能将其整条实验代码并入生产 |
| #74 `c6110a79` | 不同 R3.15 实验链，不合入 | `probes/r315` 的 reader、aggregate、state-store、RPA batching 等不在当前树。分页完整性、schema-before-request、Artifact 候选不等于权威状态等风险与本任务相关，已用当前来源、恢复 provenance、摘要及故障注入门禁处理；不连带引入小时试验调度或旧状态格式 |
| #77 `aa87b23a` | 不同加密状态／one-shot 实验链，不合入 | `r316/state-cipher.mjs`、`state-cli.mjs`、`one-shot-runner.mjs`、`source-extract-once.mjs` 不在当前树，不能为了历史 AES-GCM 基线而新增 secret 或运行控制分支。当前 Douyin 公共探针保留显式目标集、首跳网络限制；来源真实性、十房基线／身份桥接仍未验收 |
| #78 `fe8c1f2c` | 一项当前同类缺陷已交主任务修复；其余不合入 | 旧 deliveryKey、bridge 冲突与加密控制链属于上行实验。其“GH_TOKEN 不应 job-wide”在当前 Douyin／Tmall 日常工作流中仍成立，本轮发现后将令牌收窄至实际执行 gh 的恢复步骤，采集器不再继承该 job 环境变量。没有新增 token 或访问来源。WebSocket 显式封闭和固定账号目标已存在于当前公共探针 |
| #81 `1ff11c71` | 代码层已涵盖；浏览器验收单独记录 | 当前 `network-guard.mjs` 保留 `route.fetch({maxRedirects:0,maxRetries:0})`、首跳错误停机与禁止绕行通道；当前身份逻辑拒绝推荐房间和旁栏结束文字。旧 `tests/r320/browser-redirect.test.mjs` 不在本包候选树，不能只凭历史 CI 声称本轮真实浏览器路径通过；最终是否补测见总报告 |
| #82 `7c825a54` | 代码层已涵盖 | 当前 `disableUnroutedChannels` 含 `WebSocketStream`、`WebTransport`、`mozRTCPeerConnection`；当前 `douyin.mjs` 含 `LIVE_BADGE_BUT_MAIN_PLAYER_ENDED`，不再使用宽泛 `main header` 身份选择器。未放宽域名或子资源限制，未复用旧一次性实测授权 |
| #83 `e94a569b` | 核心修复已涵盖，不重复合入 | 与 PR109 对比，`probes/lib/douyin.mjs`、`probes/r320/network-guard.mjs`、`probes/r322/import-receipt.mjs` 没有差异；原探针只增加后来已批准的 monitor target sets，账本／视图主要差异是 06:00 广播日。精确 legacy reason 映射、长身份路径、NOT_RUN 独立计数、采样最长间隔、导入锁与 fsync 均已保留 |

#107 已整合 #101–#106，#108、#109 是后续堆叠。本修复直接基于 #109，没有再次 merge/cherry-pick 上述 PR，也没有合入本表中的实验分支。

本轮未将真实 OFFLINE、平台／账号身份、获准来源、生产持久存储、历史内部标识的全 Git 历史清理或真实 5／15 分钟覆盖率宣称为完成。`probes/r322/import-receipt.mjs` 的 state/html 仍各自 rename；本轮采样 wrapper 在整个采样／导入期间保留阻塞，导入失败不能宣告本轮成功，但这不等于跨文件物理原子事务。可信私有目录、实际部署与运行环境验收仍是独立边界。
