# R2.2｜京东只读巡检独立安全加固与复验

**来源：** Claude R2.1 合并版的独立审计（2026-11-10）；修复完成在独立分支 `fix/r22-jd-independent-trust-audit`，目标 `experiment/r20-jd-opening-rate-readiness`。不触及 `main`、Pages、原站与真实源定时任务。

## 本期修复项目

| ID | 原缺陷 | 本次交付行为 | 独立验收 |
|---|---|---|---|
| QA-01 / P2 | 用户可导入自报 LIVE 的任意 JSON，伪造房间 777，被当成可信观测 | 严格校验输入类型、日期、房间唯一性、房间数及 summary、采集端/分钟级 LIVE 证据；**所有本地导入无论自称何种来源，永久处于“未经来源签名验证”隔离预览**。LIVE KPI 为“—”，房间标“文件声称 LIVE · 未核验”，CSV 的 `current_state=UNKNOWN`，`provenance=UNVERIFIED_LOCAL_FILE` | `tests/r22-jd-import-trust.test.mjs` 及 Chromium 390×844 浏览器实际导入对抗用例 |
| QA-02 / P2 | `roomCatalogComplete=false` 却返回 `OBSERVED` | 上游明确不完整时返回 `PARTIAL`，`catalog_complete_attested=false`，新增 `ROOM_CATALOG_INCOMPLETE_SOURCE` 警告 | 反向矛盾输入回归 |
| QA-03 / P3 | 源站真实检查或验收失败，GitHub Actions 仍可能绿色 | 保留 `upload-artifact if:always()`，**在上传之后**追加失败门禁；任何一个步骤失败使整条运行结果为红色 | 工作流结构测试；未故意对真实源制造失败 |
| QA-04 / UX | 过期历史 LIVE 卡片仍绿色 | 历史 LIVE 角标转中性颜色，并标“历史 LIVE · 非当前” | 390×844 浏览器及静态测试 |

## 新增关键真实性边界

**JSON 架构自检不是数据真实性证明。** 即使用户复制 GitHub Actions 的 `source` 字段、时间、SHA-256 哈希或 7 条真实房间结构，离线 HTML 也无法判断文件是否出自可信的云端运行；没有签名密钥/平台鉴权就不能安全恢复实时状态认证。因此 R2.2 不允许任意本地文件升级为已核实 LIVE。真正的“可信当前状态”需要以后另加：服务端可信数据接口或可核验的数字签名、固定公钥、可信来源及跨运行时间链。

**本期仍不具备京东正式开播率：** 七个 TCL 内部房间的京东公开主播账户关系 0/7 已核实；正式排班未确认；OFFLINE 真实可靠负例未建立；长期连续运行及数据持久化未验收。开播率保持 `null`。

## 安全执行说明

- 不重复抓取京东或 TCL 真实源，不绕过登录、验证码和风控。
- R2.1 历史七房间真实观测只证明 2026-11-10 20:23 左右的情况，并非此时直播中。
- 不合并 `main`，不修改其他项目，不覆盖 Pages。
- QA-03 的失效作业只做结构审计；故障注入针对真实源本期未执行。
- iOS Safari 真机仍需单独验收；Chromium 移动视口不等于 iPhone 真机。

## 复验

```bash
node --test tests/*.test.mjs
node --test tests/r22-jd-import-trust.test.mjs
```

R2.2 核心新增：`tests/r22-jd-import-trust.test.mjs`，并保留完整 R2.0/R2.1 回归；历史源的实际回放可用 2026-11-10 GitHub Actions `#42815377261` 的去敏 JSON，传入**原始观测时间**，禁止用旧文件证明实时。
