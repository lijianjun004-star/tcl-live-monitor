# 京东三入口离线回放

用三个固定入口的模拟页面和接口响应测试场次识别。所有输出都带有 `offline_fixture` 标识。模拟数据中的场次和耗时均为虚构，不能用于店铺考核。

在仓库根目录运行：

```sh
python -m pip install -r requirements-dev.txt
PYTHONPATH=src python -m experiments.jd_cookie_live.run --out /tmp/jd-offline
python -m pytest tests/v2 -ra
```

`jd_cookie_experiment_result.json` 和 `summary.md` 记录每个入口的匹配、候选场次、判活依据和逐条 HTTP 错误。页面本身未得到有效观测、已观察页面里没找到入口、候选场次确认为回放，是三个不同结果。遇到登录、人机验证或主请求访问受限即终止后续入口和候选检查。推荐接口单独返回 403 只记录该接口错误。

`fixtures.py` 包含可修改的模拟观测。`fixture_session.py` 只接受内置测试值；不读取真实账户或环境变量，不产生浏览器会话。模拟页面停留在入口域只能证明入口匹配。房间身份必须由入口候选、房间链接及判活接口返回的同一场次 ID 共同确认。

实验工作流模板只支持该分支手动运行。新工作流在默认分支登记前，可使用上面的本地命令，或在已登记的 V2 工作流中选择实验分支和 `engine=fake` 做全套离线回归。两种离线运行均无需新增 Secret。

## 手动核对三入口

在 GitHub Actions 选择已有的 **TCL V2 monitor → Run workflow**，分支选 `experiment/jd-cookie-live-discovery`，`engine` 选 `jd-storefront`。这个模式独立运行，先做离线回归。成功后只有京东入口观测步骤得到仓库 Secret `JD_COOKIES_JSON`。缺失或格式错误时任务返回失败，并生成固定错误码。

支持 Playwright 导出的 Cookie 数组，以及 iPhone 复制的一行 HTTP Cookie。数组按原域名、路径和到期时间匹配。原始字符串缺少作用域，需要在 `jd_raw_origin` 选择复制它的实际主机，商品页为 `item.m.jd.com`，店铺页为 `shop.m.jd.com`。每条凭据仅可发送至其作用域内的固定入口。若一个导出数组覆盖两个主机，一次运行就能对三个入口做同源观测。

每个入口先读取公开 HTML。确认是目标商品或店铺、正文可读后，才向同一固定地址发一次携带凭据的 GET。重定向和访问门禁会终止本次实验。遇到仅含脚本的页面，报告会标明正文未确认。这个模式不执行带登录态的页面脚本，也不向子资源、推荐接口或直播间发送账号凭据。报告中的登录信号只说明页面观测情况。

出现公开房间链接时，另用匿名 V2 浏览器核验。相同场次只核验一次，整次最多核验六个不同候选，其余记入 `unattempted_candidate_ids`。产物 `JD_Storefront_<run_id>_a<attempt>` 包含逐入口 JSON、中文摘要和两份报告的 SHA-256 清单。一次未发现候选、页面无法判断和已确认回放应分别解读。
