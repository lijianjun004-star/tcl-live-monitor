# TCL 抖音 R3.8｜一次性真实云端 RPA 观测与验收（2026-11-11）

## 1. 已发生的真实运行

- GitHub Actions：[run 43028187403](https://github.com/lijianjun004-star/tcl-live-monitor/actions/runs/43028187403)，`completed/success`，2026-11-11 13:20:51 UTC（21:20 北京时间）。
- 独立分支 `experiment/r38-rpa-real-oneshot-20261111`；头提交 `6ba61dabd060b615a75636550564a4fbd8e80f9e`。
- 真实 GitHub Runner、真实 Chromium 与真实公开抖音主页：**不是 Mock 浏览器**。
- 独立 CI 基础安全测试 43/43 PASS。
- 输出已上传到 GitHub Actions：`r38-public-rpa-minimized-observation`（artifact ID 13861095042），只保留脱敏 JSON 摘要，保留 2 天。
- 没有触发 `schedule`、没有账号登录、没有访问 TCL OPS 私有 API、没有截图/网页全文/Cookie/Token、没有改动正式 main/Pages/京东历史数据。

## 2. 真实结果（两账号）

| 已批准账号 key | 主页 HTTP | 主页身份 | 直播间 HTTP | 房间身份 | 状态 |
|---|---:|---|---|---|---|
| `tcl-douyin-flagship` | 200 | VERIFIED | 未访问 | 未验证 | UNKNOWN |
| `tcl-douyin-tv-official-live` | 200 | VERIFIED | 未访问 | 未验证 | UNKNOWN |

- 抖音公开账号主页身份双验：2/2。
- 已取得符合既有规则的主页「直播中」有效房间链接：0/2。
- 直播间页面身份交叉验证：0/2。
- 可信公开 LIVE：0/2；**并非 0/2 个在播，更不能据此推断两个已下播**。
- `stoppedForChallenge=false`，未观察到触发停止门禁的 403/429/验证码。
- 内部 OPS 十房与公共十二账号的真实 bridge：0；正式开播率、满播率、精确开/下播时间均保持 `null`。

原始最小化机器输出（不含业务私密响应）：
```json
{
  "schemaVersion": 38,
  "sourceAccess": "PUBLIC_READ_COMPLETE",
  "expectedAccounts": 2,
  "attemptedAccounts": 2,
  "stoppedForChallenge": false,
  "publicIdentityDoubleVerifiedCount": 0,
  "opsBridgeVerifiedCount": 0,
  "formalOpeningRatePercent": null,
  "formalFullDurationRatePercent": null,
  "observations": [
    {
      "accountKey": "tcl-douyin-flagship",
      "state": "UNKNOWN",
      "reason": "PROFILE_NO_VERIFIED_LIVE_ANCHOR",
      "profileHttp": 200,
      "roomHttp": null,
      "profileIdentityVerified": true,
      "roomIdentityVerified": false
    },
    {
      "accountKey": "tcl-douyin-tv-official-live",
      "state": "UNKNOWN",
      "reason": "PROFILE_NO_VERIFIED_LIVE_ANCHOR",
      "profileHttp": 200,
      "roomHttp": null,
      "profileIdentityVerified": true,
      "roomIdentityVerified": false
    }
  ]
}
```

## 3. 解释与不可夸大范围

页面返回 HTTP 200、主页身份成功，仅证明**真实云端 RPA 能访问已批准的公开主页并读取足以核验的身份信息**。
这一次没有检测到符合当前选择器规则的 live anchor，可能是当时没有公开直播入口、页面动态表现变化或当前判定规则过严。**没有足够证据区分原因**。
不能把 `UNKNOWN` 升为 `OFFLINE`，也不能用本次 2 样本衡量真实状态识别准确率。

## 4. 推荐继续验证

1. 下一轮先研究**匿名化的 DOM 结构统计**：页面中「直播中」可见文本/直播链接数量/候选链接形式和状态；不要保存完整 HTML、私人数据、账号凭据。
2. 选取**已有人为确认正在直播**的公开账号与时间点，做一次云端 RPA 对照测试；再选真实已下播样本评估负例误判。
3. OPS 房间 ↔ 公开账户的跨来源身份桥接必须有可审定证据，未核实不得自动 join 或入考核。
4. 无需本地设备常开的定时巡检需要随后独立验证 GitHub schedule 的实触发频率和失败率。
5. 保留三平台边界：京东/天猫/抖音；不修改旧仓库/正式 Pages/京东运行数据。

## 5. 技术执行限制

`.github/workflows/r38-public-rpa-one-shot.yml` 只有受限 **push** 触发，路径限定为该工作流文件本身；没有 `workflow_dispatch` 或 `schedule`。因此工作流不会在默认分支创建/自动启用持续巡检。

代码运行前设置固定守卫 `R38_SINGLE_SHOT=TWO_APPROVED_PUBLIC_ACCOUNTS`，目标 keys 在源码中限定为两个已批准公开账号。浏览器按 R3.7 只读规则运行，禁止非 GET/HEAD、跨站导航、登录与下载。

完整代码以 GitHub Draft PR 为准，任何后续发布或定时任务需单独审定。
