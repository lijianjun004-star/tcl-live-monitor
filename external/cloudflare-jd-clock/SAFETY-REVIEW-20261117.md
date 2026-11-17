# 独立时钟离线安全评估（2026-11-17）

基线 main 18581b22c9907c4ef3a16e0e98d4a00b57b4d6ca。只修改未启用候选，不改变工作流、wrangler 配置、生产频率、权限或来源。未部署、未访问平台、未派发工作流。免费额度、实际账单、CPU 时间和生产可用性均未实测；历史 README 的额度估算不是保证。

## 已实施

单次低层 GitHub POST 默认 10 秒上限，AbortController 加 Promise.race 防止不响应中止的传输无限等待；所有结束路径清理计时器。redirect=manual，拒绝 3xx、opaque redirect、已跟随重定向或异常最终 URL。不读取响应体、响应头或原始异常；日志无令牌。无自动重试。超时/传输失败不能证明服务端未接受请求。

200/204 仅表示接受，workflowRunId=null、sourceOutcome=UNVERIFIED。机会标识来自预定时间，可对重复机会进行离线关联，但不是已持久化尝试记录或 GitHub run ID，不证明执行成功。

定时入口 runScheduled/Worker 均默认阻塞：PERSISTENCE_AND_SOURCE_FEEDBACK_UNCONFIGURED。没有进程内“冷却”伪装为跨运行状态，没有令牌或环境开关可以绕过。dispatchBackup 仅是可单独测试的低层原语，定时入口不调用它。

## 未实施的跨轮退避与派发追踪

当前候选没有持久存储绑定，也没有可信的来源结果回传。既有备份新鲜度判断把 source_verified=false 当作可补采，不能把它当作故障退避。此 PR 不改变既有主备采集，因此不会替那些路径减少请求；它只阻止此候选新增请求。

未来若获具体批准，需先设计并独立审查：

1. 持久、原子、串行的机会预留记录，写成功后才允许单次 POST；记录缺失、损坏、不可用、非法时间、写失败均阻塞。
2. POST 超时/未知结果保留 pending，禁止下一轮重试；即使记录回写失败也不得释放预留。不能用 isolate 内存或最终一致 KV 假定互斥。
3. 明确派发关联协议：固定仓库/工作流/ref、可信 run ID、head SHA 和结果来源；只看“最新成功”或按时间猜测不能解除 pending。当前 workflow_dispatch 没有该协议，本次不新增输入或生产回调。
4. 经可信反馈确认 SOURCE_UNAVAILABLE 后持久记录失败次数和复核时间；退避时长需另行批准，不能借此改变生产频率。时间届满不自动恢复受限访问；UNKNOWN、过期或缺失反馈保持阻塞。
5. 人工解除必须引用具体阻塞记录摘要、证据、批准人和单次授权范围；在原子操作中留审计轨迹。没有这样的批准或状态不一致时不能清空阻塞。

本次跨轮模拟证明的是缺少依赖时始终零请求，包括重复事件、后续机会和模块冷启动；**不声称实现了生产持久化、自动退避、跨服务 exactly-once 或真实派发追踪**。

## 独立复验

运行 `node --test external/cloudflare-jd-clock/tests/*.test.mjs`，以及根目录 `node --test tests/*.test.mjs tests/*/*.test.mjs`。所有请求测试使用合成令牌和注入传输，不运行 wrangler/npm install/deploy 或任何采集脚本。测试覆盖超时、中止、同步/异步异常脱敏、重定向、非法响应、无响应体读取、计时器清理、跨轮默认阻塞、冷启动与 Worker 入口。

审查者可核对 git diff 仅含候选源码、测试和文档；wrangler 与全部 .github/workflows 保持基线。Draft PR 不代表批准上线或恢复访问。未邀请或声称 Claude/Gemini 已复验。
