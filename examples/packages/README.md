# Scene package 目录约定

一个包 = **一次可验证运行所需的全部输入** + 黄金基线。目录形状：

```text
<package>/
  scene.json            必填：版本化场景（可迁移 + 校验）
  plugins.lock.json     必填：[{ id, version, configHash? }]
  seed.json             必填：{ seed?, step?, seconds | steps, observation? }
  actions.json          可选：外部输入 / 动作脚本
  invariants.json       可选：这个包该验什么（登记项）
  metrics.json          可选：指标口径
  expected/trace.json   可选：黄金基线（sceneId 要对得上）
```

## 校验

```bash
bun run scene package examples/packages/hello --junit .scene-ci/package/junit.xml
```

`package` 命令不跑仿真，只做契约校验；报告检查是：

- `package.layout`：必填文件齐全且都是合法 JSON；
- `package.scene`：`scene.json` 可迁移并通过校验；
- `package.plugin-lock`：每条插件锁都有 `id` 与 `version`；
- `package.seed`：时间网格能落到整数固定步；
- `package.baseline`：有基线时，`sceneId` 一致，且 `eventHash / stateHash` 由本端按 `scene-spec` 重算（不自报自证）。

## 生成基线

```bash
bun run scene run --scene examples/packages/hello/scene.json \
  --seed 1 --step 0.016666666666666666 --seconds 2 \
  --out examples/packages/hello/expected
```

`--out` 会写 `trace.json`、`report.json` 与 `report.html`；作为包基线只需要里面的 `trace.json`。
