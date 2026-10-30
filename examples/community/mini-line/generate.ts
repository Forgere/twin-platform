import { writeFileSync } from 'node:fs';
import { buildLineScene } from '@twin-platform/plugins-logistics';

/** 社区示例场景的可复现生成入口：外部贡献者只改参数，不改内核。 */
const scene = buildLineScene({ parcels: 2, length: 16, baseSpeed: 1.4 });
scene.id = 'community-mini-line';
scene.name = '社区示例：迷你输送线（外部贡献场景包）';
writeFileSync(new URL('./scene.json', import.meta.url), `${JSON.stringify(scene, null, 2)}\n`, 'utf-8');
