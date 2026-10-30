# Plugin Conformance Kit

阶段 5 的第一块：插件的自检清单。它不认识物流、钓鱼或任何领域，只回答
“这个插件能不能进公共验证链”。

## 检查项

| id | 检查 |
| --- | --- |
| `conformance.manifest` | manifest 字段合法 |
| `conformance.activate` | 插件可同步激活（异步激活会让插件锁与回放失效） |
| `conformance.capabilities` | 实际贡献都在 manifest 声明的能力里 |
| `conformance.determinism` | 同场景 + 同种子两次运行，事件指纹与世界指纹逐位一致 |
| `conformance.source-hygiene` | 源码不出现 `Math.random` / `Date.now` / `new Date` / `performance.now` / 定时器 |

## 用法

```ts
import { runConformance } from '@twin-platform/plugin-conformance';

const report = runConformance({
  plugin: myPlugin,
  scene: myScene,
  steps: 240,
  sources: [{ path: 'src/behavior.ts', text: readFileSync('src/behavior.ts', 'utf-8') }],
});

if (!report.passed) console.error(report.checks.filter((check) => check.status !== 'pass'));
```

`scene` 由插件或宿主提供：只需要一个能体现插件行为的最小场景。
不提供 `sources` 时，源码检查会跳过并写进 `warnings`，**不会假装检查过**。

## 纪律

- 随机只能来自注入的 `ctx.rng`；
- 不读挂钟，不用真实定时器；
- 激活必须同步；
- 声明的能力与实际贡献必须一致。

本包只依赖 `plugin-sdk / world-kernel / replay-core / scene-schema / scene-spec`，不依赖任何领域插件。
