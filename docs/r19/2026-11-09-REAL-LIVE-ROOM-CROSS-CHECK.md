# R1.9｜双账号正常浏览器直播页二次核验（2026-11-09）

## 结论

这是 **GitHub Actions 云端出口之外** 的另一组正常只读浏览器核验，不能用来宣称已通过 GitHub Actions 真实持续巡检。具体浏览器执行页面见下列记录。

| 对象 | 真实账号主页核验 | 直播页核验 | 动态场次参数来源 | 状态 |
|---|---|---|---|---|
| FFALCON雷鸟电视旗舰店（抖音号 83165143028） | PASS | PASS：播放器、实时观众及互动可见 | 原始点击链接含 `room_id=7705939961182636842`，落地页随后移除参数 | 该次直播页面 LIVE |
| TCL官方旗舰店（抖音号 79013748820） | PASS | PASS：直播页及主页均有直播标识，身份匹配 | 这次落地页没有独立重新提供动态 `room_id`，只能核实固定路由 `31878890513` | 该次直播页面 LIVE；动态场次未重新核实 |

**时间要求：** 两次正常浏览器返回的北京时间为无效格式或 DATE_ONLY。证据只能标 2026-11-09，不能计算准确开播时间、结束时间或累计直播时长。

### 真实证据

**FFALCON 雷鸟电视旗舰店**

- 账号主页：https://www.douyin.com/user/MS4wLjABAAAAHLgxNf9c59NqJuH9tm5U2L3E1B6bNBehePdI5rKsZ2s
- 直播固定路由：https://live.douyin.com/988541363148
- 点击时链接：https://live.douyin.com/988541363148?room_id=7705939961182636842
- 观察：真实视频播放器；实时在线观众 6 人；场次点赞、入场互动、礼物面板。
- 用户主页和直播页显示 FFALCON雷鸟电视旗舰店。
- 浏览器运行证据：https://agent.tinyfish.ai/runs/8dd55b79-a9b9-4ea2-acd0-3a069f42d24d
- 注意：某处页面标题写作 FALCON（少一个 F），但本次目标用户主页和直播间显示名为 FFALCON，与账号 secUid 一致；如果自动化只匹配标题文字，不应擅自容忍不同主体，必须人工或双字段确认。

**TCL 官方旗舰店**

- 账号主页：https://www.douyin.com/user/MS4wLjABAAAAVozXF9jRtNt6k62dH8TZXld0RGpvIK8aZxEh3oWcBfM
- 直播固定路由：https://live.douyin.com/31878890513
- 观察：直播页显示 TCL官方旗舰店，抖音号 79013748820，主页 secUid 与目标一致；本次有直播中标识。
- 浏览器运行证据：https://agent.tinyfish.ai/runs/335335fe-06e0-4c73-bdbe-0ae529fc5e4c
- **重要：工具输出把 `31878890513` 错误称作动态 room_id。该数字实际是固定 `live.douyin.com` 路由 ID。此前主页链接曾出现的动态 `7705907855488043785` 不能据此重新确认当前仍然有效。**

机器可读证据：`docs/r19/evidence/2026-11-09-two-live-room-browser-checks.json`。

## 已修复的技术问题

1. `corroborateDouyin` 原来要求落地 URL 必须保留 `room_id` 查询参数，但抖音真实直播页面可能在正常导航中清除此参数，导致真实直播误判 UNKNOWN。
2. 现在**仅在**当次正常导航的 `requested_url` 与主页新鲜“直播中”链接的路由及动态 ID 一致，且最终 URL 仍留在相同的 HTTPS `live.douyin.com/<route>` 时，允许去参数跳转。
3. 另外增加直播页视频播放器或“直播中”信号门禁；只有标题/描述吻合而无直播 UI 的页面依然 UNKNOWN。
4. 登录墙、验证码、明确结束文案、过期证据、跨房间跳转、不同直播 ID 都必须 UNKNOWN。
5. 来源动态 ID 明确标为 `FRESH_PROFILE_BADGE_LINK`，`current_room_payload_attested=false`，避免声称从直播间 payload 独立取得当前 liveId。

## 验收状态（截止本次）

| 指标 | 状态 |
|---|---|
| 14 个抖音账号已归档，12 个首期检查目标 | PASS（数据台账） |
| 两个不同 TCL/雷鸟直播账号实际页面身份 | PASS（正常浏览器） |
| 两个账号直播间可访问及页面直播状态 | PASS（正常浏览器日期级） |
| 可编程处理直播页 canonical redirect | PASS（离线单测） |
| 全部回归 329/329 | PASS（GitHub Actions 离线） |
| GitHub Actions 普通浏览器稳定直播二次验收 | BLOCKED（GitHub 云端出口限制） |
| 精确动态场次以及跨场次迁移 | PARTIAL（雷鸟链接有参数，TCL此次无实时确认） |
| 真实 OFFLINE 状态确认 | NOT_EXECUTED |
| 直播时长/完播率 | NOT_EXECUTED |
| 无人值守定时和跨运行持久化 | NOT_ENABLED |

## 不允许的推论

- 2026-11-09 的 LIVE 页面不能证明任何未来时间点仍在直播。
- 仅凭有“直播中”标识不能认定实际直播完整时长。
- 不能把固定直播路由 ID 当作动态场次 ID。
- 单账号身份匹配不等于总部直营运营归属通过，尤其代运营企业认证主体需要单独记录。
- GitHub Actions 工作流成功运行不代表平台实时监控通过。

## 对应 CI

- PR：[R1.9 #30](https://github.com/lijianjun004-star/tcl-live-monitor/pull/30)
- 329 项全回归完成：https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42580506794
- 三次 GitHub 真网页试点日志：https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42578287544 ，https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42578588148 ，https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/42578776368

本实验不合并 main、不部署正式 Pages、不启用生产 cron、不上传 Cookie。
