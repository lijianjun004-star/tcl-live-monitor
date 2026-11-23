# 京东 TCL官方旗舰店（721631）当前场次寻路：2026-11-22 观测记录

目标：不登录、不用店铺账号，自动拿到该店"正在直播"那一场的观看链接。结论：本轮未找到可自动化的公开入口，改用"用户分享链接 + 自动核对"的半自动方式。

## 已核实

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 店铺短链 `3.cn/3cLNH-Qy` | 跳转到 `shop.m.jd.com/?shopId=721631` | 本会话直接读取 302 Location |
| 店铺 721631 身份 | PC 店铺页标题"TCL官方旗舰店 - 京东"；移动端 `whx_getMShopOutlineInfo` 返回 shopId 721631、venderId 726611 | [运行 44982130602](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44982130602) |
| 直播分享 `3.cn/3d-8eX2i` | 场次 49691143；北京时间 11:33 读取为 live | [运行 44981031481](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44981031481) |
| 回放分享 `3.cn/3d-8yk4T` | 场次 49675703；用户 App 截图（12:08）显示发布方"TCL官方旗舰店"、回放时长 15:59:41、底部按钮"主播正在直播中"可跳新场次 | 用户截图；[运行 44983600145](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44983600145) |

## 未找到线索的入口（匿名，GitHub Actions）

| 入口 | 观测 |
| --- | --- |
| PC 店铺页 `mall.jd.com/index-721631.html` | 无直播栏目、无 lives.jd.com 链接、无"直播"文字 |
| 移动店铺页 | 落到 App 引流；店铺数据仅有 `switchConfig.openWxappToLiveRoom: true`，无场次号 |
| 直播页 49691143（PC、移动） | 无预告、预约、抽奖字段或文字；`slide.pre/next` 是滑动推荐的其他直播间 |
| 回放页 49620440、49675703（PC、移动） | `getImmediatePlayToM` 只给 liveId 与视频地址，`livingLiveId` 为 null；`liveDetailToM`、`liveCartDetailToM` 有请求但无可读响应（单房间探测记录为 HTTP 403） |

关键对照：回放 49675703 在北京时间 12:07–12:08 的匿名读取中 `livingLiveId` 为 null，而同一分钟用户 App 显示"主播正在直播中"。App 按钮所依赖的数据未出现在匿名网页可读响应中。403 的原因（海外机房 IP、未登录或签名）未区分；需国内网络环境的匿名对照才能判断，本轮未进行。

## 当前做法

用户在京东 App 分享直播间链接 → 解析 `3.cn` 短链得到场次号 → 手动触发 `probe_jd_single.yml`（`room_url=https://lives.jd.com/#/<场次号>`）核对 live/replay。核对结果只代表读取那一刻；不核对店铺归属。

`explore.py` 为一次性观测脚本，触发工作流已删除，不会自动运行。
