import { writeFileSync } from 'node:fs';
import { buildCenterScene } from '@twin-platform/plugins-logistics';

/**
 * 工厂参考场景包的可复现生成入口：只改参数，不改内核。
 *
 * 默认参数（产出间隔 6s、在制 10、高水位 8）能在 300s 内把闭环跑通；
 * 想加速就把 `examples/logistics-center/fast.json` 里的参数传进来，
 * 并重跑 `scene run --update` 重生成黄金基线。
 */
const scene = buildCenterScene();
writeFileSync(new URL('./scene.json', import.meta.url), `${JSON.stringify(scene, null, 2)}\n`, 'utf-8');
