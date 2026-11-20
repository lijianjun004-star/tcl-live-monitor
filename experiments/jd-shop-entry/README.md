# 京东店铺 721631 入口离线核验

运行 `python3 -B src/jd_shop_entry.py <本地脱敏观测.json>` 可得到单次证据判定。`python3 -B experiments/jd-shop-entry/test_offline.py` 执行合成自测。`FICTIONAL-observation.json` 展示完整输入；其中的场次号、直播状态、栏目名称组合和时间用于测试，不构成实际发现。

店铺登记依据见[仓库 PR #112](https://github.com/lijianjun004-star/tcl-live-monitor/pull/112)。登记对象为 `721631`、TCL官方旗舰店。历史分享场次不能建立店铺归属。

| JSON 对象 | 脱敏输入来源和要求 |
|---|---|
| `store_page` | 店铺页最终公开地址与页面标题，主文档实际 HTTP 状态、可见访问门禁结果及 UTC 观察时间。仅接受 `mall.jd.com/index-721631.html` 或 `shop.m.jd.com/?shopId=721631` 的精确 HTTPS 地址。`visible_links` 录入该店直播区完整的可见候选链接，包括有歧义的候选。缺少链接可填 `[]`。 |
| `visible_links[].heading_path` | 在源页面实际可见的内外层区域标题，按自内向外顺序记录，逐字保留。`href` 是去掉跟踪信息后的完整公开链接，保留身份相关路径、店铺号与场次。店铺仅接受单一明确“店铺直播”或“本店直播”区域。推荐区、未标明归属区域以及混合/嵌套标题均无法提供归属证据。没有可核实的区域就填空，不将人工判断翻译成程序接受的标题。 |
| `room_page` | 另行观察候选场次页的最终 URL、HTTP 状态、门禁、UTC 时间及该页面的发布店铺区域。要求唯一归属店铺为 721631，店铺链接所在可见区域完整标题为“直播店铺”或“主播店铺”。页面若同时出现多个不同发布商店铺则归属未知。推荐店铺链接不能代替发布者链接。 |
| `strict_room_result` | 仅合成夹具可在该对象内填样例。对于 `offline_observation`，必须用 `--strict-result result.json --strict-result-sha256 <期望摘要>` 提供独立运行原始文件与交接清单中的对应摘要，内联对象不参与判定。校验器核查 `getImmediatePlayToM`、允许的原始请求方法/函数标识来源、HTTPS 官方端点、已准入的 JSON/JavaScript MIME、目标详情匹配计数及 `/api` 准入样本。房间号、最终主机、页面状态、fragment 匹配与门禁以及既有严格准入的 `live_status` 均需一致。没有取得该结果就省略该对象。 |

`gate="clear"` 需要实际观察，登录、验证和限制均不能填 clear。移动落到京东下载页可使用 `gate="app_download"`，或提供示例判定代码识别的精确最终下载页 URL。HTTP 状态未知时填 `null`。记录只含公开标识与固定结果，不应输入查询串、跟踪参数、Cookie、令牌、原始返回体或全页文本。输入文件上限 128 KiB。

现有区域标题白名单是离线实验假设。尚未核实店铺 721631 的实际 DOM 提供这些区域，任何其他布局保留 UNKNOWN。独立场次归属来源是房间页发布商链接，并非从 `getImmediatePlayToM` 虚构 shopId 字段。输入的 `heading_path`、门禁与预先准入的探测结果仍须由人工或另行审查的采集器对照原证据。该工具核对输入之间的一致性，不校验观测者身份、输入来源真实性或采集完整性。

`candidate_session_id` 来自明确店铺自有栏目。`corroborated_session_id` 另需场次页发布商同店链接、同场严格详情结果和时间接近（本实验采用五分钟窗口，任何未来时间拒绝）。`observed_status` 仅记录这些输入在观察时刻的状态。`current_state` 在离线程序中固定为 `UNKNOWN`。任何关键证据缺失都不会从旧场次或名称推断新场次，不会自动追踪或触发访问。

该摘要只将判定绑定到收到的独立文件字节。文件及校验清单的可信来源仍需按 GitHub 运行、提交和 Artifact 核对。
