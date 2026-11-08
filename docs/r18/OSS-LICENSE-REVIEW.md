# R1.8 开源许可证与安全能力研究

核验时间：2026-11-08 UTC。方法：实时 GitHub 元数据、README、LICENSE、固定提交架构模块的只读静态检查。全部原始文档及请求 URL、README/LICENSE blob SHA、仓库提交、静态读取哈希保存在 `evidence/oss/*.json`。本轮不引入这些项目作为依赖，不复制它们的业务源码；以下是独立实现的设计参考。

| 仓库 | 实时许可证证据 | 本轮结论 |
|---|---|---|
| lengzhanbao/taobao_scraper | LICENSE 是 MIT；README 429—438 同时限定学习研究、禁止商业目的 | 仅研究思想；生产复用需另行解决条款冲突，不直接宣称可商用 |
| floomhq/openbrowser | LICENSE 是 MIT | 研究 Profile 隔离、人机接管、审计；不采用身份代理轮换 |
| kktbur/Live-stream-recording-Automatic-monitoring | 自有 LICENSE 是 MIT；THIRD_PARTY_NOTICES 单列依赖 | 研究监控调度与统一接口；不可把仓库 MIT 外推为所有 vendor 代码 MIT |
| chenfan0/fideo-live-record | LICENSE 是 AGPL-3.0；README 另有个人学习研究用途措辞 | 只看结构和接口，不复制源码、MTop 签名或 token 请求逻辑 |
| hotdogarea/chrome-taobao-live-crx | GitHub license=null，独立 LICENSE endpoint 404；README 74—76 写 MIT License，但无完整授权文本 | 明确授权仍未确认；本轮不复制源码 |

## 具体设计参考与边界

### taobao_scraper

README 345 给出默认两小时冷却；`src/crawler/retry_state.py` 实际提供 `eligible`、`failed`、`succeeded` 与持久化冷却状态，头部说明损坏状态应 fail closed。可以独立实现目标级 `next_eligible_at`、失败计数、跨运行保留冷却、成功后恢复及损坏状态拒绝继续。默认巡检 60 分钟与风控冷却时长应分别配置。README 的反封禁、人性化模拟、Cookie 导入等能力不引入；不识别数字人，也不把其标题推断当平台事实。

### OpenBrowser

README 45—55 明确 named persistent profiles、人机认证接管、清洗遥测与审计；216—253 解释同 Profile 多进程锁冲突；287—291 表明工具不返回原始凭据，验证码破解不在范围。已静态读取 `profiles.py` 的 snapshot/seed/profile_status 和 `audit.py` 的会话日志检查结构。R1.8 可采用本地同一正常 Profile、独占锁、人工浏览器登录后恢复、仅安全摘要。并行 Profile 复制、代理身份路由不进入本轮实现。

### Reco Box

README 5 列出手动立即检查、批量监控、历史记录与日志；33 明确淘宝暂不启用，原因是锁定版解析器需要登录会话，本项目不绕过登录或导入 Cookie。静态读取 `monitor.py` 确认 MonitoringCoordinator、check_now、schedule_retry、_tick、_resolved、_failed 的监控职责划分；适配器返回归一化观察，调度器处理时隙/重试，存储独立。README 126 和 THIRD_PARTY_NOTICES 指明上游解析器等各自保留许可证，不能笼统复制 vendor 树。

### fideo-live-record

仅静态查看淘宝插件接口 `getRoomIdByUrl`、直播 URL/房间信息插件职责。其代码存在 Cookie-required/expired 分支及主动 token/签名路径，本轮不采用。研究结果不能作为匿名淘宝可用的证明，不运行该插件，不拷贝实现。

### Chrome 淘宝直播插件

只读取 README 与目录元数据。README 确有 MIT 字样，这是相对接力包“未确认明确许可证”的补充事实；单行名称不足以确认完整版权主体、许可范围和条款，因此保留不复制结论。

## 固定版本和复查入口

- `chenfan0/fideo-live-record`：[`640ab1b6e2aa3c4853c54edc09bbb60daef73e5b`](https://github.com/chenfan0/fideo-live-record/tree/640ab1b6e2aa3c4853c54edc09bbb60daef73e5b)；[README](https://github.com/chenfan0/fideo-live-record/blob/640ab1b6e2aa3c4853c54edc09bbb60daef73e5b/README.md)；证据 `evidence/oss/chenfan0--fideo-live-record.json`。
- `kktbur/Live-stream-recording-Automatic-monitoring`：[`0637a7eca5dc41dabe0ac50dd2e17bf053f49641`](https://github.com/kktbur/Live-stream-recording-Automatic-monitoring/tree/0637a7eca5dc41dabe0ac50dd2e17bf053f49641)；[README](https://github.com/kktbur/Live-stream-recording-Automatic-monitoring/blob/0637a7eca5dc41dabe0ac50dd2e17bf053f49641/README.md)；证据 `evidence/oss/kktbur--Live-stream-recording-Automatic-monitoring.json`。
- `floomhq/openbrowser`：[`5680ac6fbe1334a20d87a02d1087c95fc3e20a9c`](https://github.com/floomhq/openbrowser/tree/5680ac6fbe1334a20d87a02d1087c95fc3e20a9c)；[README](https://github.com/floomhq/openbrowser/blob/5680ac6fbe1334a20d87a02d1087c95fc3e20a9c/README.md)；证据 `evidence/oss/floomhq--openbrowser.json`。
- `hotdogarea/chrome-taobao-live-crx`：[`033275d41a50a0315be953e0d197dd495159b6f0`](https://github.com/hotdogarea/chrome-taobao-live-crx/tree/033275d41a50a0315be953e0d197dd495159b6f0)；[README](https://github.com/hotdogarea/chrome-taobao-live-crx/blob/033275d41a50a0315be953e0d197dd495159b6f0/README.md)；证据 `evidence/oss/hotdogarea--chrome-taobao-live-crx.json`。
- `lengzhanbao/taobao_scraper`：[`37ef7f032da53be897a9e6feeb8f975676bf75b8`](https://github.com/lengzhanbao/taobao_scraper/tree/37ef7f032da53be897a9e6feeb8f975676bf75b8)；[README](https://github.com/lengzhanbao/taobao_scraper/blob/37ef7f032da53be897a9e6feeb8f975676bf75b8/README.md)；证据 `evidence/oss/lengzhanbao--taobao_scraper.json`。

## 实施与验收限制

- 本审阅是静态研究；没有运行第三方采集、登录、录屏或测试套件，没有证明任何真实平台已接通。
- AGPL 与未确认授权项目的业务源码均未归入 TCL 代码；文档证据不作为可执行依赖。
- 本轮原则是从业务需求独立实现安全机制。如未来实际复制 MIT 代码，应附带对应版权和许可全文，并复核依赖许可证与额外条款。
- 仓库 README 的用途限制和平台服务条款不是由 SPDX 标签消除的；商业生产复用仍待明确决策。
- secrets / Cookie / Profile / 日志的最终扫描应针对主控整合后 diff 执行；本 Agent 的许可证研究不替代它。
