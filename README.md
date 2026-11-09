# TCL 多平台直播监控系统

TCL 京东 / 淘宝天猫 / 抖音直播间状态监控与满播率考核。**与 TCL 智能练播房项目无关，不混库、不混部署。**

当前状态（实验分支）：已完成 R1.9 抖音账号台账、固定查找路径及有限的真实浏览器核验；没有正式部署、无持续运行的生产巡检，也没有启用满播率考核。

核心口径：`LIVE` / 有证据的 `OFFLINE` / `UNKNOWN` 三态；`UNKNOWN` 不等于停播，不扣分。

## 抖音 TCL / FFALCON 固定账号查找与直播核验（R1.9）

抖音已知账号不再全网反复搜索，统一从本地账号台账的稳定 `secUid` 进入主页，核对本次“直播中”入口，再打开**当次**直播间二次核验。

- **操作手册：** [抖音账号优先固定操作路径](docs/r19/DOUYIN-FIXED-OPERATION-PATH.md)
- **程序与测试：** `probes/r19/operation-path.mjs`、`probes/r19/path-cli.mjs`、`tests/r19-operation-path.test.mjs`
- **账号：** `config/r19-douyin-tcl-ffalcon-registry.json`（14 个独立账号；12 个首期主目标）
- **历史证据：** [2026-11-09 两账号直播页二次核验](docs/r19/2026-11-09-REAL-LIVE-ROOM-CROSS-CHECK.md)
- **代理工作说明：** [AGENTS.md](AGENTS.md)
- **交付状态：** [R1.9 草稿 PR #30](https://github.com/lijianjun004-star/tcl-live-monitor/pull/30)

快速查号（不访问抖音）：

```bash
node probes/r19/path-cli.mjs --list
node probes/r19/path-cli.mjs --key tcl-douyin-flagship
node probes/r19/path-cli.mjs --search 雷鸟
```

该路径不把历史 LIVE 视为当前状态，不把固定直播路由当动态场次 ID。访问受限即 UNKNOWN；不得据此计算精准上下播时刻。
