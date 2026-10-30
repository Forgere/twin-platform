# 可验证场景示例

本目录给 `scene` CLI 提供可直接跑的样例：一个最小黄金基线，一套加速参数。

| 路径 | 用途 |
| --- | --- |
| `hello/scene.json` | 静态最小场景（无随机、无渲染），跨平台逐字节一致 |
| `hello/expected/trace.json` | 它的黄金基线（`--seconds 2` 生成） |
| `logistics-center/fast.json` | 物流中心模板的加速参数（产出间隔 1s、在制 8、高水位 6） |

## 常用命令

```bash
# 重新生成黄金基线
bun run scene -- replay --scene examples/hello/scene.json --seconds 2 --baseline examples/hello/expected/trace.json --update

# 门禁：与基线比对，分歧即退出 1
bun run scene -- replay --scene examples/hello/scene.json --seconds 2 --baseline examples/hello/expected/trace.json --junit .scene-ci/hello/junit.xml

# 参考插件审计：钓场运行时不变量
bun run scene -- audit --template fishing.pond --seconds 30 --out .scene-ci/fishing

# 参考插件审计：物流闭环（全链路 + 物料守恒）
bun run scene -- audit --template logistics.center --template-params examples/logistics-center/fast.json --seconds 300 --out .scene-ci/center
```

产物：`<out>/trace.json`、`report.json`、`report.html`，以及 `--junit` 指定的 JUnit XML。
报告与 JUnit 都不写挂钟时间，所以同输入的产物逐字节一致，可以直接做 diff 门禁。
