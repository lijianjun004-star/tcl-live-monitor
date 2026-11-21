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
