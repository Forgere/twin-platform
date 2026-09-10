import { TwinWorld } from '@twin-platform/world-kernel';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { buildCenterScene, logisticsPlugin } from './packages/plugins-logistics/src/index';

const STEP = 1 / 60;
const host = new PluginHost();
host.install(logisticsPlugin);
const scene = buildCenterScene();
const world = new TwinWorld(scene, { seed: 7, maxStepsPerAdvance: 600, behaviors: host.behaviors });

// 卡车实际占位：size [2.2,2.4,6]，绕 Y 转 rot 后的 AABB
const footprint = (cx: number, cz: number, rot: number) => {
  const w = 2.2 / 2;
  const d = 6 / 2;
  const c = Math.abs(Math.cos(rot));
  const s = Math.abs(Math.sin(rot));
  const hx = w * c + d * s;
  const hz = w * s + d * c;
  return { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz };
};
const overlap = (
  a: ReturnType<typeof footprint>,
  b: { x0: number; x1: number; z0: number; z1: number },
) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.01 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 0.01;

const solids = scene.entities
  .filter((e) => ['conveyor', 'transfer', 'rack', 'machine'].includes(e.kind))
  .map((e) => {
    const size = (e.visual as { size?: number[] } | undefined)?.size ?? [1, 1, 1];
    const [px, , pz] = e.transform.position;
    return {
      id: e.id,
      kind: e.kind,
      box: { x0: px - size[0] / 2, x1: px + size[0] / 2, z0: pz - size[2] / 2, z1: pz + size[2] / 2 },
    };
  });

for (let i = 0; i < 60 * 400; i += 1) world.step(STEP);

console.log('--- 卡车停靠位姿 ---');
for (const id of ['truck-a', 'truck-b']) {
  const t = world.getEntity(id);
  if (!t) continue;
  const [px, , pz] = t.transform.position as [number, number, number];
  const rot = Number((t.transform.rotation as number[] | undefined)?.[1] ?? 0);
  const fp = footprint(px, pz, rot);
  const deg = ((rot * 180) / Math.PI).toFixed(1);
  const heading = `(${(Math.sin(rot) * 100).toFixed(0)}%, ${(Math.cos(rot) * 100).toFixed(0)}%)`;
  const hits = solids.filter((s) => overlap(fp, s.box)).map((s) => `${s.id}[${s.kind}]`);
  console.log(
    `${id}: pos=[${px.toFixed(2)}, ${pz.toFixed(2)}] rotY=${deg}° 车头向量≈${heading}`,
  );
  console.log(
    `   占位 X[${fp.x0.toFixed(2)}, ${fp.x1.toFixed(2)}] Z[${fp.z0.toFixed(2)}, ${fp.z1.toFixed(2)}] ` +
      `state=${String(t.attrs.truckState)} load=${Number(t.attrs.load ?? 0)}`,
  );
  console.log(`   压占地面实体: ${hits.length ? hits.join(', ') : '✓ 无'}`);
}

const docks = scene.entities.filter((e) => e.id.startsWith('dock-'));
for (const d of docks) {
  const size = (d.visual as { size?: number[] })?.size ?? [0, 0, 0];
  const [px, , pz] = d.transform.position;
  console.log(
    `${d.id}: 中心=[${px.toFixed(2)}, ${pz.toFixed(2)}] 台面 X[${(px - size[0] / 2).toFixed(2)}, ${(px + size[0] / 2).toFixed(2)}] Z[${(pz - size[2] / 2).toFixed(2)}, ${(pz + size[2] / 2).toFixed(2)}]`,
  );
}

const events = world.getEventLog();
const loads = events.filter((e) => e.type === 'truck:departed').map((e) => Number((e.payload as { load?: number })?.load ?? 0));
console.log('--- 发车装载数 ---');
console.log('departed loads =', loads.join(', ') || '(none)', '| 平均 =', loads.length ? (loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(2) : '-');
