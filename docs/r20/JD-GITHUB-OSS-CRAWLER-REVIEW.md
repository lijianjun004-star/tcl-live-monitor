# R2.0 京东开播爬虫 GitHub 开源研究与独立适配验收

研究日期：2026-11-10（北京时间）。任务范围：为 TCL 京东直播监控寻找开源的开播探测器，复用经过许可核实的设计思路。**当前仅实现离线状态适配和证据准入测试，并没有验证其可在京东真实平台持续工作。**

## 首选开源项目：streamget

| 项目 | 代码位置 | 许可证 | 研究结论 |
|---|---|---|---|
| [ihmily/streamget](https://github.com/ihmily/streamget) | [京东解析器](https://github.com/ihmily/streamget/blob/016a8d6fbef4f5f14c0ec986dc3528c5a22235ab/streamget/platforms/jd/live_stream.py) | MIT | **技术首选**；有独立 `JDLiveStream`，接受京东分享链接并识别主播、直播 ID 和状态字段 |
| [ihmily/StreamCap](https://github.com/ihmily/StreamCap) | [京东Handler](https://github.com/ihmily/StreamCap/blob/e1e8dbf1657df58f363e6de7a9ce739c340dba55/app/core/platforms/platform_handlers/handlers.py) | Apache-2.0 | 基于 StreamGet 的录制/监控GUI，架构参考，不直接搬整个桌面录制器 |
| [ihmily/DouyinLiveRecorder](https://github.com/ihmily/DouyinLiveRecorder) | [`get_jd_stream_url`](https://github.com/ihmily/DouyinLiveRecorder/blob/add187f8d8c7ff7d231fcbee45cbb4f1ed247d3a/src/spider.py#L3107-L3170) | MIT | 有相近的京东解析逻辑；依赖长驻录制流程、直播流/FFmpeg，偏重 |
| [kktbur/Live-stream-recording-Automatic-monitoring](https://github.com/kktbur/Live-stream-recording-Automatic-monitoring) | [resolver.py](https://github.com/kktbur/Live-stream-recording-Automatic-monitoring/blob/0637a7eca5dc41dabe0ac50dd2e17bf053f49641/src/reco_box/resolver.py) | MIT（根仓库，vendor 另核实） | 多平台适配复用上游 spider，较重 |
| [shixinmuhuo/onereocrd](https://github.com/shixinmuhuo/onereocrd) | README 声称支持京东 | MIT | 公开仓库无可直接审阅的京东爬虫实现，不作为首选 |

## streamget 京东源码实际工作链路

源码 `streamget/platforms/jd/live_stream.py` 的核心流程：

```text
给定京东分享 URL
  → 常规跳转解析作者 authorId，或从直播场次链接取 liveId
  → 如果有 authorId，尝试查询主播资料
  → 如资料中有 livingRoomJump，取当前场次 liveId
  → 查该场次详情，读取 data.status
  → 当 status == 1 时返回 is_live=True
  → 其他情形返回默认 is_live=False
```

这些是**源码行为**，不是本次实时京东平台通过的证明。源码将找不到 `authorId`、跳转异常或没有 `livingRoomJump` 等情况和真实不在播情形统一回落到 `is_live=False`。这种二态字段直接用于人员考核可能产生假停播。**必须三态归一：LIVE／OFFLINE／UNKNOWN**，其中当前没有真实验证过的 OFFLINE 证据，必须 UNKNOWN。

### 风险与使用边界

1. 主播主页 ID `authorId`、店铺商家 `venderId`、京东内部运营房间 `ops_room_id`、动态直播 `liveId` 是四层不同实体。不能合并或靠数字猜关系。
2. `streamget` 的 JD 解析器通过第三方未公开稳定性承诺的京东网页接口获取结果。**不能保证在 2026-11-10 的云端环境中匿名可用**；不得把源码中的 `is_live` 声明当真实网络验收。
3. 上游代码含移动端 User-Agent 设置，不能以此作为绕过平台人机验证、指纹或登录限制的许可；本项目不会复制冒充设备、签名伪造、验证码绕过或代理轮换代码。
4. 项目希望零新增费用、无需本地设备常驻。因此只引入**短时状态检测适配思路**，不引入长时间录制、视频流下载、FFmpeg、桌面应用 GUI。
5. 网络若返回登录页、403/429、超时、异常 JSON、账号不匹配或不确定的身份，写 `UNKNOWN` 和原因。不得将其计为未开播。
6. 即使某次 LIVE 可信，也只有实际观测时间，不证明真实上播起始时间；应按经审核的排班计算，另行验证 5 分钟准时规则。

## 本次已经落到 R2.0 的源码

- `probes/r20/jd-oss-status-adapter.mjs`：把开源爬虫响应转成内部状态，只在**真实来源 + 账号匹配 + 新鲜直播信息 + 明确 LIVE + 直播页证据**同时满足时返回 LIVE。
- `tests/r20-jd-oss-status-adapter.test.mjs`：13项离线安全检查，覆盖旧场次、假 OFFLINE、登录墙、时间过期、无主播身份、无 liveId、状态字段缺失、隐私泄漏与统计门禁。
- 原 `probes/r20/jd-opening-rate.mjs` 保持已核验排班/内部六房间身份对应的要求，不允许把一个直播状态直接变成百分比。

**声明：本次没有将 StreamGet 的整份源码复制进仓库；这是根据研究结果独立编写的状态归一模块，许可证保留原仓库引用。**

## 下一道真实验证门禁

- 先取得一个**已确认归属于 TCL 京东目标直播间**的稳定主播主页链接（京东 APP 分享）；现在六个内部房间公开身份仍为 PENDING。
- 在普通被允许访问的环境中，**一次性、低频、人工触发的只读**方式测试真实主播主页的可见直播入口与状态；不对历史 `45583477` 链接重复请求。
- 若上游接口属于平台受限/登录/风控范围，即停止该路径，不强行重放 API 签名或尝试规避。
- 实测记录至少保存：账号链接、来源页面、实际时间、已核验账号、动态 liveId、LIVE/UNKNOWN、限制类别、原始浏览器运行证据摘要（不得保存 Cookie）。
- 至少验证真实 LIVE 正例，以及具有明确证据的 OFFLINE 正例，才允许把 OFFLINE 规则和正式开播率投入试运行；还须通过 15分钟/关键时段5分钟巡检及多运行持久化验收。

## 本期结论

**GitHub 开源候选已找到，首选 `ihmily/streamget`，且确实有专门的 JD 解析器。**
但六个 TCL 京东内部房间未完成公开身份映射、京东网页接口匿名实际可用性未验证，因此正式开播率依旧为 `null`。所有新开发保持在草稿 PR #31；`main` 和现有正式站点不受影响。
