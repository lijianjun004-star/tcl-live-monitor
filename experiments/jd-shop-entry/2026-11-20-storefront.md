# 京东店铺 721631 的访客入口观测

2026-11-20 约 09:12 UTC（北京时间 17:12），从仓库登记的 PC、移动两个店铺入口分别打开一次。起点只包含店铺号，未把已知场次号作为发现输入。[店铺登记依据](https://github.com/lijianjun004-star/tcl-live-monitor/pull/112)

| 起点 | 浏览器中实际可见的结果 | 从店铺取得的候选场次 |
| --- | --- | --- |
| [PC 店铺](https://mall.jd.com/index-721631.html) | 最终 URL 与起点相同，标题为「TCL官方旗舰店 - 京东」。可见导航含首页、全部分类、TCL电视等。浏览器的可访问性快照中未检出「直播」「在播」或 lives.jd.com 链接。 | 无 |
| [移动店铺](https://shop.m.jd.com/?shopId=721631) | 经过 shop.m.jd.com/shop/home?shopId=721631，最终落在 wqs.jd.com/downloadApp/download.html。页面显示「打开京东APP」和 Android 下载入口。记录仅保留最终主机与路径。 | 无 |

没有候选可做发布店铺归属和开播状态的独立核验。此次观测结果为 UNKNOWN。界面观察未取得主文档 HTTP 状态码，也未取得 App 内页面、登录后的店铺内容或确切的 DOM 栏目结构。单次访客快照只能说明这一轮两个入口的表现。

## 上一实验的终止依据

已核对 GitHub Actions 原始 ZIP 中两份 JSON 对应的 SHA256SUMS.txt。result.json 中 49620440 为 replay，generated_at 为 09:02:45 UTC。run_summary.json 的对照记录中 49654695 为 live，时间为 09:03:18 UTC。同日相隔 33 秒，二者 living_live_id 都是 null。旧场在这次对照中未指向在播新场，停止将该字段作为发现入口。该对照不能证明固定店铺页在本次观测时存在某个特定场次。[原始运行](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44707272079)

## 下一次能验证什么

若京东原生店铺的公开「直播」入口可分享，保留从 721631 店铺进入的可见栏目和当时的时间，再记录该入口实际展示的公开链接。提供截图时仅保留店铺标识、栏目、场次及时间，移除个人信息。孤立的房间分享链接不能证明它由该店铺入口返回。发现候选后，另核对候选场次的发布店铺及同一观测窗口的场次状态。资料缺一时保持 UNKNOWN。

T2 的来源运行仍为 [44689694821](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/44689694821)。本次店铺访问及离线代码没有写入该链，也没有启动 T2。
