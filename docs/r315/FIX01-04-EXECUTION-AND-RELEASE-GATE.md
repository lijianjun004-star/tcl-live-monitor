# TCL 直播监控 R3.15｜ChatGPT 直接修复与独立验收记录

日期：2026-11-12。依据用户上传 `Gemini-R315-PR73-独立复验结果包.zip` 中的七项 P1–P3 复现和 Codex Draft PR #73 源码，创建了独立堆叠 Draft PR #74。本记录以实际 Actions 证据为准，**不把离线测试当作真实直播业务成功**。

## 基线与生产保护

- Codex 原 PR：[#73](https://github.com/lijianjun004-star/tcl-live-monitor/pull/73)，原 head `5b483c95f9c091337cc4d7e25d601eec0bae2896`；本次独立修复以它为基础。
- 本次 PR：[#74](https://github.com/lijianjun004-star/tcl-live-monitor/pull/74)，base 为 #73 的实验分支，**Draft、未合并**。
- 提交初始 main：`68382b23f9acf8160c8d86ec154c0ef2ce35af32`；此分支不写 `main`、Pages、京东生产 cron 和历史数据。
- 单次来源测试只访问过去已明确提供的 TCL OPS 来源 HTTPS 候选的一个已知 GET 路由，不发送凭据、不开启页面爬取、不保存业务内容。

## FIX01｜Gemini 七项边界缺陷

| Gemini 编号 | 代码修改 | 验收 |
|---|---|---|
| P1-1 | 房间、店铺、心跳、每日数据：拒绝分页未尽/总数矛盾/容器冲突 | 单测 + 全仓 PASS |
| P1-2 | reader 校验器在任何请求前验证，创建时快照防止外部篡改 | 单测 + 全仓 PASS |
| P2-1 | 适配真实 Playwright Request 方法，阻断 iframe/redirect/非文档 | 单测 + Chrome 离线测试 |
| P2-2 | 跨平台同 ID 歧义阻断；一致 null 的店铺别名与残缺嵌套结构分开处理 | 单测 + 全仓 PASS |
| P2-3 | 旧状态候选检查 Artifact 数字 ID/固定名称/64 位 SHA-256，拒绝损坏与重复 runAttempt；始终须独立二次认证 | 单测 + 全仓 PASS |
| P3-1 | 无/UTF-8 JSON charset 接受，其余 charset 拒绝 | 单测 + 全仓 PASS |
| P3-2 | 全批准与撤销名单范围检查重复 profile URL | 单测 + 全仓 PASS |

真实 CI：[Actions #43206238774](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43206238774)，专项 **64/64 PASS**，原有根级 **151/151 PASS**，0 失败。
随后加入 RPA Chrome 和小时预检模块后：[Actions #43207217141](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43207217141)，专项 **71 通过、1 跳过、0 失败**（1 项 Chrome 只在专用 workflow 执行），原有根级 **151/151 PASS**。

## FIX02｜真实 HTTPS 来源接线

已执行已知 TCL 来源的 `https://` 单次无凭据、无 Cookie、禁止重定向只读 GET 测试：
[Actions #43206574214](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43206574214)。

真实安全摘要：`tlsStatus=HTTPS_UNAVAILABLE_OR_CERT_UNVERIFIED`、`httpStatus=null`、`sourceSchemaVerified=false`。**不能证明原始来源可被 R3.15 HTTPS-only reader 安全访问**。现有历史 HTTP 读取成功不等于 HTTPS 成功。没有为了让真实采集通过而关闭证书校验或改用伪造凭据。

因此：**京东与抖音 R3.15 的真实 HTTPS 业务单次采集仍为阻断，不宣称完成。** 仍需用户提供合法的 HTTPS 地址/代理（可信证书）及真实来源 Schema 授权证据；或者由用户明确审查并批准采用旧无凭据 HTTP 的实验采集方案，且不可当作完整可信链路。

## FIX03｜Playwright 与 RPA

新增 `probes/r315/rpa-playwright-context.mjs`，严格为**本地离线合成页面**设计，不允许外发任何 HTTP/HTTPS 请求。真实系统 Chrome 手机视口测试检查主 frame、子 frame、额外 fetch 拒绝及页面注入层的 WebRTC API 禁用。

[Actions #43207217219](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43207217219)：独立实际 Chrome 运行 **2/2 PASS**。

**不能推断**：该测试已证明真实抖音可访问、真实 LIVE/OFFLINE 判定准确、GitHub Runner 操作系统已经阻断所有 UDP/WebRTC 数据包。过去 Codex 的 UDP 漏包曾被指出，本次不主动运行真实平台 RPA 直到可验证的 OS 网络隔离和独立 egress 取证通过。

## FIX04｜小时主备调度

新增 `probes/r315/hourly-pilot-gate.mjs`，在独立纯函数中判断：
- JD 每小时主槽 :17，备用 :47；
- Douyin 主槽 :23，备用 :53；
- 只有受信任的状态收据、有效来源授权、外部平台互斥锁条件满足才允许产生候选；
- 55 分钟内已有真实可验收的成功采集，备份应跳过；
- `workflow_dispatch` 始终只是诊断，不能伪装 `schedule`；
- GitHub schedule 延迟超出允许窗口不允许补报为按时巡检。

新模块只返回 `ALLOW_CANDIDATE`，**没有独立获得云端锁，也没有真正执行网络调用、保存 Artifact 或启用 cron**。实际主备去重、跨运行持久化、严格每小时、24–48 小时运行均 **NOT VERIFIED**，不能宣称 FIX04 完成上线验收。

## 当前阻断与下一步

1. 可信 HTTPS 来源缺失：这是最优先的真实链路阻断。
2. 真实来源 schema 与完整目录需按来源证据独立审查；以往抖音 10 内部房间、京东 7 内部房间不能代表全公司全部账号。
3. 抖音内部 OPS 房间到公开账号的可信四层桥接仍为 0，不可用名字相似候选自动填补。
4. 未在真实抖音站点执行 R3.15 全通道隔离后 RPA；离线 Chrome PASS 不证明真实采集准确。
5. 没有新增自动 cron 或启动 24–48 小时正式试运行。GitHub schedule 只有默认分支触发，禁止在未批准前为测试合并 `main`。
6. 正式开播率、满播率、停播 ≥10 分钟中断次数均保持**未认证**；一小时采样无法可靠识别 10 分钟停播。

## 发布门禁

| 条件 | 结论 |
|---|---|
| Gemini 七项 P1–P3 代码修复 | PASS（离线/Chrome 合成） |
| 原仓回归 | PASS |
| HTTPS 真实单次 | BLOCKED |
| RPA 公开真实站点 + OS 网络隔离 | NOT EXECUTED |
| 小时主备分布式锁/持久化 | NOT IMPLEMENTED |
| 24–48 小时真实定时 | NOT STARTED |
| main / Pages / 京东原生产保护 | 保持不变 |
| 可合并正式上线 | **NO** |

该 Draft PR 仅是阶段性安全修复与试验代码。不应合并部署为正式监控。
