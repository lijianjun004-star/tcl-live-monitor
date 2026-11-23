# 源码出处与离线检查

`project/` 包含 26 个列入 `SOURCE_MAP.tsv` 的文件。路径以 project 为根。该表给出每个文件的字节数、SHA-256 和来源，可用来复原本次交接的版本。

| 来源 | 文件数 | 说明 |
|---|---:|---|
| 2026-11-23 12:41:44 六店实测原包内的源码 ZIP | 6 | monitor_local.py、search_page.py、cards.js、verified_scan.py、verified_shops.json、wall.py 已按字节比对。wall.py 随程序交付，本轮未启用视频墙 |
| 同一工作区的 once_liveids 配套源码 | 19 | 依赖清单、全页用的 20 店名单、云函数、手机看板、文档和测试；未据此认定已部署 |
| 较早的 Chrome Codespaces 配置原包 | 1 | .devcontainer/devcontainer.json 供新工作区参考。复用原工作区无需重新构建 |

## 复核记录

- 历史实测：原始 ZIP 的 SHA-256 为 `5adc862c93c642892c330e5968ec0f513f81350948675bdcc40b39cab18e67dc`。完整终端日志为 1,054 字节，SHA-256 为 `c83d9022ec20f41a404257d9df390b3bdc12827c9e3dbe5e2494669df9dae9b5`。本次打包核对了两层原包的内部校验清单。
- 本次离线 Python 检查：24 项中 22 项通过，2 项依赖真实 Chrome 的本地 DOM 测试跳过。Node.js 离线检查 3 项通过，使用内存数据库替身。完整输出附于 checks/。本轮没有新直播观测或云端写入。
- 手机或助手只能读取一份文件时，先看 START_HERE_CLAUDE.md，其中含六店结果、命令和下一项工作。需要逐店核对文本时直接打开 evidence/terminal.txt，无需解压内层历史包。
- project/README.md 和 project/CLOUD.md 是原工程文档。其安装、部署命令用于另行获准后的工作。将来若迁移采集主机，需要在目标环境重新检验 Chrome 的运行和登录态。
