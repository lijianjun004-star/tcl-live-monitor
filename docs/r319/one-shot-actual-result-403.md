# R3.19 两账号抖音核心 CDN 一次性实测｜停止报告（真实 GitHub 证据）

**日期**：2026-11-13 北京时间；**用户批准的一次性只读实测**。  
**结论**：`STOPPED_ACCESS_LIMIT`，非成功直播身份验收。失败是预期的安全熔断结果；不得重新触发。

## 实际链接与 SHA
- R3.19 [Draft PR #80](https://github.com/lijianjun004-star/tcl-live-monitor/pull/80)，真实触发提交 `567acd2dea9f5ccb5ea4587c601077342a552f96`，从 R3.18 PR #79 的 `8db56cb7f4235882c0df2c1a0512c3c44f4b1779` 派生。
- [R3.19 本次唯一真实 RPA Actions #43392606431](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43392606431)：`failure`，退出码 `3`，停止原因 `HTTP_403_RESOURCE`，运行尝试次数 `1`。
- [R3.19 离线 CI #43392488289](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43392488289)：`success`，R3.16 44/44、R3.18 11/11、R3.19 10/10、全仓 376/377 通过（1 跳过），28 个工作流语法检查通过，现有隐私检查通过。
- [实测提交后离线 CI #43392612417](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43392612417)：`success`。
- 脱敏公开回执：GitHub Actions Artifact `r319-douyin-cdn-readonly-43392606431` / ID `14020754343`；下载 ZIP SHA-256 为 `cf710b743fea2d7716f8221fdfc4edfdd4292733e2cdb312cb95772eafbb0d53`。

## 具体观测
| 项目 | tcl-douyin-flagship | tcl-douyin-air-direct |
|---|---|---|
| 2026-11-13 UTC 时间 | 08:22:10.049 | 08:22:18.658 |
| 状态 | UNKNOWN | NOT_RUN |
| HTTP 顶层导航 | null（导航被截断） | 没有访问 |
| 页面身份交叉确认 | false | 未执行 |
| 直播间身份确认 | false | 未执行 |
| 触发停止的原因 | HTTP_403_RESOURCE | STOPPED_AFTER_ACCESS_LIMIT |

- 允许的静态请求计数：`lf-douyin-pc-web.douyinstatic.com:script=136`、`stylesheet=22`，合计 **158**。
- 第二个批准域名 `lf-douyin-pc-web-back.douyinstatic.com` 无获准通过请求记录。这**不等于**证明它不能访问。
- 其余被拦截请求计数共 **92**。按域名/资源类型聚合，无任何 URL、房间号或个人识别数据。
- 任意资源返回 403 后，浏览器页面被关闭，`stopped` 设置为 `HTTP_403_RESOURCE`，后续账号标记 `NOT_RUN`，工作流主动返回退出码 3。
- 403 具体来自哪个资源主机/URL 没有保留。**不能**断定是核心 CDN 本身、抖音的风控页面或特定 API。不能将本轮记为 2/2 实测成功。

## 正式系统与安全边界
- `main` 仍为 `68382b23f9acf8160c8d86ec154c0ef2ce35af32`；本 PR Draft 未合并，不修改 Pages。
- CDN 授权仅对本次 `experiment/r319-douyin-core-cdn-approved-once-20261113` 工作流中的环境变量生效；没有 scheduler，`github.run_attempt == 1`，不可手动重复。
- 未登录、未购买、未调用授权接口、未开正式考核；第 2 个账号没有继续访问。
- 未获得验证证据，`LIVE`/ `OFFLINE` 均不得赋值，正式开播率和完播率保持 `null`。

## 后续处理（仅离线准备；需另行授权实测）
1. 为错误访问事件准备**仅域名类别、HTTP 状态、资源类型**的脱敏诊断；同时避免输出完整 URL/私有路径，不在现有运行中回溯或尝试绕过 403。
2. 在**无真实请求**条件下继续完善主页 / 直播间身份双重核验和异常快停测试。
3. 如需任何第二轮真实访问，须取得新的明确许可，并仍遵守平台安全验证、停止规则。
4. 真实跨平台身份桥接及可信 OFFLINE 规则未验证，不能启动正式巡检 KPI。
