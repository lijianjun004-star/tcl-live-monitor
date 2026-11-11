# TCL 抖音监控 R3.6｜参考站公开证据、REA 和已批准账号复刻实验

日期：2026-11-11（北京时间）

## 目标

用户提供 `http://101.96.215.251/?start=2026-10-21&end=2026-10-21&platform=jd&category=全品类&shop_id=17`，
要求理解参考网站的抖音巡检与店铺管理逻辑，结合已有 GitHub 项目复刻。

**原始 URL 的平台参数确实是 `jd`，不是 Douyin。不得把参考站内部 shop_id=17 当成抖音 secUid、抖音号或直播间 roomId。**

## 已有真实证据（不是猜测）

| 检查 | 真实结论 | 证据 |
|---|---|---|
| 从外部直接 GET 参考站 | Python 连接被拒绝、第三方渲染读取返回 403 | 2026-11-11 当前测试 |
| 从 GitHub 云端访问参考站 | GET HTML 成功，页面引用 1 个可读 JS 文件 | Actions 43015670761 |
| REA 分析真实来源 JS | 已运行官方 `rea-agents`，对 106391 字节目标 JS 完成静态图生成 | Actions 43015670761 |
| 前端真实 JS 字符串 | 检测到 Douyin 和 Shops 相关字面量；`/api/capture/room-overview/daily` 字面量未检出 | Actions 43015670761 |
| 参考站既有只读业务 API | 来源房间目录含 `jd=7`、`douyin=10`；抖音 10 房，10 店，10 个 shop_id 关联，采集会话绑定 1 房 | Actions 43015295953、43015679900 |
| 抖音每日数据 | 4 个实际房间抽样的每日返回均符合 `days[]` 结构 | 同上 |
| 参考站目录完整性 | 来源未声明目录完全覆盖（`API_RESPONSE_NOT_PROVEN_EXHAUSTIVE`） | 同上 |
| 抖音主页公开只读采样 | 两个已批准账号主页身份和直播入口出现，但直播间页面未能交叉证明同一个身份；均 UNKNOWN | Actions 43015156078 |

**注意**：来源 REA 静态分析的原始 JS 与结果已在临时 runner 安全删除；不能仅据这些字面量推断全部网络请求协议或底层监控算法。

## 独立实验代码（不合并 MAIN）

- `probes/r36/douyin-reference-contract.mjs`：严格解析用户原 URL、建立现有已批准 Douyin 账号目录、区分参考系统内部 shop_id 与抖音真实账号标识、显式标记身份冲突。
- `probes/r36/douyin-guest-smoke.mjs`：仅对最多两个已批准账户作一轮公开主页与直播间只读检查；验证码/登录/403 即停止，无代理绕过；输出最小身份状态，不含私有报表。
- `tests/r36-douyin-reference-contract.test.mjs`：16 项参考站数据契约/UNKNOWN 防误判/房间切换/时段证据检查。
- `.github/workflows/r36-douyin-reference-qa.yml`：隔离 GitHub CI 与公开只读采样，无 cron、无生产落库、无 Pages 发布。
- `.github/workflows/r36-rea-code-audit.yml`：用官方 REA 分析我们自己编写的 JS 源码（不是目标站点）。
- 参考站真实 JS 的 REA 与 OPS 数据源只读探索由独立任务实验分支完成，交叉验证记录在上方 run 证据中。

## 来自源代码的既有已知规则

现有主仓库 `probes/lib/douyin.mjs` 已实现：
1. 先用认证账户的公开主页标题+抖音号确认账号身份；
2. 从主页“直播中”入口读取实际 `live.douyin.com/<roomId>`；下次房间 ID 变化需再核对，不能假装同一个场次；
3. 若房间页标题和公开描述与账号不一致，不能判 LIVE；
4. 没有直播徽标、加载失败、登录墙、验证码均是 UNKNOWN，不是停播；
5. `直播已结束` 加被动 status=4 仍是未经校准的停播候选；不能直接升格 OFFLINE；
6. 未取得连续真实样本与平台会话边界前，开播/下播精确时间、真人分钟数、满播率都不能计算。

以上是**项目现有逻辑**，不是声称参考站内部使用了同样的规则。

## 尚缺的“完美复刻”验收条件

- 参考站 Douyin 平台完整 UI 或用户导出的 HTML/HAR（敏感字段已去除）、导航、真实表格列与网络请求字段对照；
- 参考站 10 个内部 Douyin room_id 与 12 个公开 Douyin 账号 secUid、抖音号之间的业务映射，排班及直播间 owner 的审定；
- 来源业务 API `minute_count`、`latest.status`、`session_count`、采集心跳在已知真人开播与下播两个真实样本中的负例测试；
- 当前仅 1 个房间显示绑定采集会话的原因与影响，不能把未绑定房间一律判停播；
- 一天完整时段的 5/15 分钟有效样本覆盖和异常追溯。

**无法访问的部分不允许靠逆向猜测或伪造补全。目标是行为等价的可验证实现，而不是模仿未经确认的接口。**

## 安全边界

- 所有实验只读；不绕过 403、验证码、登录、风控；
- 不收集 Cookie、Token、登录凭据，不将内部原始业务响应上传到公开仓库；
- 仅在独立实验分支运行，任何自动抓取不能直接写入 main、正式评分或京东 7 天历史；
- 不影响既有京东 R3.5、Pages、其他三个平台；不恢复 90 天归档。

## 官方 REA

官方源：`https://github.com/morluto/rea`，命令 `npx rea-agents@latest analyze-javascript-application /absolute/path/to/js --json`。
