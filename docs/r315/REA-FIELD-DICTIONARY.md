# R3.15 参考前端字段字典（静态发现，非服务端 schema）

字段均仅从本轮取得的前端 JS 语法中观察到；不得据此断言必填性、真实数据类型、取值全集、隐私级别或服务器响应结构。证据身份和 hash 见 [REA 前端图](REA-FRONTEND-AND-API-MAP.md)。偏移为源文件 UTF-16 字符串中的零起始码元位置。

| 字段 | 静态用途 | 来源与边界 |
|---|---|---|
| `start_date`、`end_date` | 每日概览和页面筛选的日期参数 | `api-V-AvWykF.js` 约 120100–120600；未验证服务端日期含义。 |
| `platform` | 查询筛选及页面平台属性 | `api-V-AvWykF.js` 约 120100；排班模块中出现标签“抖音”对应 `douyin`、“京东”对应 `jd`。这只是所见 UI 选择项，不说明来源别名等价。 |
| `shop_id` | 每日概览、筛选、店铺详情导航中的内部店铺参数 | `api-V-AvWykF.js` 约 120100；`ShopDetailView-Qsj2F8Uw.js` 约 3598。不等于公开账号 ID。 |
| `live_room_id` | 每日概览和排班查询中的内部房间参数 | 同上及 `RealtimeSchedulesView-GADLj4BK.js` 约 1491。不等于公开直播房间 ID。 |
| `category` | 看板筛选、页面表单和房间展示字段 | `DashboardView-B1MQYxie.js` 约 131300；`WatchRoomsView-DKK2VFhK.js` 约 1466。映射全集未知。 |
| `anchor_name` | 日概览可选查询与页面筛选字段 | API 分片约 120100；不要采集或公开值。 |
| `minute_count` | 页面渲染中的分钟计数输入 | `DashboardView-B1MQYxie.js` 约 162962。源码存在该展示不证明精确直播时长。 |
| `status`、`liveId`、`streamUrl`、`coverUrl` | 直播画面组件局部状态对象所用属性 | `LiveScreenView-DkS6rYs2.js` 约 865192，属于人工定点静态检查，语义/来源尚未完整确认。 |
| `total`、`limit`、`events` | 看板事件视图代码使用的响应属性 | `DashboardView-B1MQYxie.js` 约 131283。不能据此证明完整分页。 |

**未核验**：`checkedAt`、`sourceUpdatedAt`、`dataDate`、`ageMinutes` 是否由参考服务直接提供；公开账号与内部店铺/房间的连接；JD/抖音 source 的数据刷新时间、完整目录和任何业务状态真值。字段名相似不能作为这些结论的证据。