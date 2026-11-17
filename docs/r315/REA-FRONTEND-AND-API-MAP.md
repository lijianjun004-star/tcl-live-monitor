# R3.15 参考前端和 API 静态图（部分，未经运行验证）

## 取证边界

2026-11-12 09:55–09:56 UTC，在既有授权目标上，对首页已载入脚本中明确列出的 8 个页面 JS 分片及其共同 API 分片做无凭据 GET。9 个分片均返回 HTTP 200，Content-Type 为 `application/javascript`；没有 401/403/429、重定向或 HTML 挑战响应。未读取任何动态业务数据，原始 JS 和 REA 证据仅保留在本地工作目录。HTTP 200 只证明资源响应，不证明身份、接口权限或运行状态。

REA 已对 7 个页面分片进行静态分析，父 Evidence `ev_7dc51b576772f9869706fe9e5e1d0f5736bfa99864dc6f8e204fd8fe69ef91cc`；API 分片父 Evidence `ev_351488ebd110e65be09342e7c85cf01607a6617be686375e750a79b1d7bc78c1`。两项分析均 partial，前者选取 7 个页面、排除直播画面大分片，后者仅选 API 文件且语义图达到保留上限。对直播画面分片的下述发现来自独立的定点字符串上下文核对，**不是 REA 对其完整 AST 的分析结果**。源码未执行。下文 offset 为基于解码后 JS 字符串的零起始 UTF-16 码元偏移，不是网络报文字节偏移。

## 前端路径：INFERRED

此前主入口 REA 路由投影识别到 19 个低置信候选；在主入口源码中可以定位 `/live-screen`、`/`、`/realtime-schedules`、`/review`、`/shops`、`/watch-rooms`、`/shops/:id` 的路径与延迟 import。导航标签可定位“实时画面”“店铺管理”“直播间管理”等。源码存在路由配置不等于用户实际可访问或已导航到这些页面；其余路径和权限状态未知。

店铺详情分片含构造跳转到排班页面以及概览页面的静态代码，URL 参数带内部 `live_room_id` 和/或 `shop_id`；它体现页面间引用，**不证明**与公开抖音账号或直播间的身份关联。参见 `ShopDetailView-Qsj2F8Uw.js` 偏移 3496、3598。

## 读取调用：OBSERVED IN SOURCE

| 包装器 | 源码中的相对路径 | 可见请求参数 / 限制 |
|---|---|---|
| `listShops` | `/api/shops` | 包装器未显式设置方法，交由 fetch 默认 GET；未验证返回结构。 |
| `listCaptureRooms` | `/api/capture/rooms` | 同上；不可将内部房间 ID 作为公开房间 ID。 |
| `assistantActiveRooms` | `/api/assistant/active-rooms` | 同上；不证明心跳新鲜或身份匹配。 |
| `getCaptureOverviewDaily` | `/api/capture/room-overview/daily` | 构造 `start_date`、`end_date`，可添加 `platform`、`live_room_id`、`shop_id`、`anchor_name`；此处仅证实前端构造，不证明服务端接受。 |
| `dashboardFilters` / `dashboardSummary` / `dashboardEvents` | `/api/dashboard/filters`、`/api/dashboard/summary`、`/api/dashboard/events` | 后两者使用筛选对象构造查询参数；本轮未访问。 |

API 分片的共同包装器调用 `fetch`、设置 `cache: no-store`，默认解析 JSON。源码还出现 POST/PATCH/PUT/DELETE 等写操作；它们**不在本次执行范围**，没有被调用。不要据此猜测未观察路径或扩充只读 allowlist。API 实现和类型、响应完整性以及实时可访问性均为 NOT_VERIFIED。

## 索引与哈希

以下散列针对本轮直接下载的静态资源字节；对应请求均为 2026-11-12 UTC。

| 本地文件 | 时间 UTC | 字节 | SHA-256 |
|---|---|---:|---|
| `LiveScreenView-DkS6rYs2.js` | 09:55:01 | 870514 | `91d2020bd582ff68b68e5350925f391be918762f92f1b9c87b8f7f03c3a16e56` |
| `DashboardView-B1MQYxie.js` | 09:55:02 | 177229 | `184d7d9f432f407f309ff0cc91596a8b8879c2535adb781bfe0bbcb5b47f5cad` |
| `RealtimeSchedulesView-GADLj4BK.js` | 09:55:03 | 16163 | `c9bb63ffe63de7099f180c5c2157dfed35eb32a3f63860118f233363680749ac` |
| `LiveAssistantView-CeIGhVrj.js` | 09:55:03 | 6911 | `37d1efe2adf219778a34677a4ce432eb2736d7ca902e4c75a16db9a58037d76c` |
| `AnchorReviewView-B-uvGI8H.js` | 09:55:03 | 21966 | `4e2423e090ba962a0d3c805edde47046d2385530ad99531e736575686b2d88d7` |
| `ShopsView-B5hqBmd0.js` | 09:55:03 | 3543 | `6cd9881c92365f64ebe3a5f4ffa6b2f7570f1fb592d6c9d0b7af28c407af1a5a` |
| `WatchRoomsView-DKK2VFhK.js` | 09:55:04 | 7885 | `7fd205f483487255f7bd4e748d0774b0bad706559273763742f632b79c37c41a` |
| `ShopDetailView-Qsj2F8Uw.js` | 09:55:04 | 13603 | `03dcbf1fa935d2cb6c18d3c835c27b93f09b4aa8a7b17a5ee91b68c9b70eec26` |
| `api-V-AvWykF.js` | 09:56:14 | 124711 | `3723ab43c42d1b08d988bb6a544bfde299a7dfa5293e71ccbc763c63b12caaf6` |