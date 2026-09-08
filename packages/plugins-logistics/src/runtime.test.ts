import { describe, expect, test } from 'bun:test';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import type { TwinEntity } from '@twin-platform/scene-schema';
import { buildCenterScene, logisticsPlugin } from './index';

const STEP = 1 / 60;

/** 皮带的俯视矩形（世界坐标）。 */
interface BeltBox {
  id: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function beltBoxes(entities: TwinEntity[]): BeltBox[] {
  return entities
    .filter((entity) => entity.kind === 'transport')
    .map((entity) => {
      const [sx, , sz] = entity.visual?.size ?? [0, 0, 0];
      const [bx, , bz] = entity.transform.position;
      return { id: entity.id, x0: bx - sx / 2, x1: bx + sx / 2, z0: bz - sz / 2, z1: bz + sz / 2 };
    });
}

/** 物料是否落在某条皮带上方（留 5cm 容差吸收圆角与浮点）。 */
function onBelt(boxes: BeltBox[], position: readonly number[]): boolean {
  const [px, , pz] = position;
  return boxes.some(
    (box) => px >= box.x0 - 0.05 && px <= box.x1 + 0.05 && pz >= box.z0 - 0.05 && pz <= box.z1 + 0.05,
  );
}

/**
 * 把物流中心真跑起来。这类"跑起来才看得见"的问题（货物脱线、堆垛机不动）
 * 光靠静态路径校验是抓不到的，所以这里直接驱动世界。
 */
function runCenter(steps: number, sampleEvery = 30) {
  const scene = buildCenterScene({ parcels: 10, asrsParcels: 3, externalLanes: 4, aisles: 2 });
  const behaviors = (logisticsPlugin.activate().behaviors ?? []) as WorldBehavior[];
  const world = new TwinWorld(scene as never, { seed: 20240906, step: STEP, behaviors, maxStepsPerAdvance: 8 });

  const boxes = beltBoxes(scene.entities);
  const parcels = scene.entities.filter((entity) => entity.kind === 'parcel');
  const offBelt: string[] = [];
  let samples = 0;

  const stackers = scene.entities.filter((entity) => entity.kind === 'stacker');
  const carriages = scene.entities.filter((entity) => entity.kind === 'carriage');
  const forks = scene.entities.filter((entity) => entity.kind === 'fork');
  const seenZ = new Map(stackers.map((entity) => [entity.id, new Set<number>()]));
  const seenY = new Map(carriages.map((entity) => [entity.id, new Set<number>()]));
  const seenX = new Map(forks.map((entity) => [entity.id, new Set<number>()]));

  for (let i = 0; i < steps; i += 1) {
    world.step(STEP);
    if (i % sampleEvery !== 0) continue;

    for (const parcel of parcels) {
      const position = world.getEntity(parcel.id)?.transform.position;
      if (!position) continue;
      samples += 1;
      if (!onBelt(boxes, position)) {
        offBelt.push(`${parcel.id}@${position.map((n) => n.toFixed(2)).join(',')}`);
      }
    }

    const round = (n: number) => Math.round(n * 20) / 20;
    for (const entity of stackers) seenZ.get(entity.id)?.add(round(world.getEntity(entity.id)?.transform.position[2] ?? 0));
    for (const entity of carriages) seenY.get(entity.id)?.add(round(world.getEntity(entity.id)?.transform.position[1] ?? 0));
    for (const entity of forks) seenX.get(entity.id)?.add(round(world.getEntity(entity.id)?.transform.position[0] ?? 0));
  }

  return { world, boxes, parcels, offBelt, samples, seenZ, seenY, seenX, stackers, carriages, forks };
}

describe('智能物流中心 · 运行时', () => {
  test('物料全程贴着皮带走，不会脱线悬空', () => {
    const run = runCenter(2400); // 40 秒
    expect(run.parcels.length).toBeGreaterThan(0);
    expect(run.samples).toBeGreaterThan(0);
    // 关键回归：曾经物料路径是手写角点，很多段下面压根没皮带。
    expect(run.offBelt).toEqual([]);
  });

  test('堆垛机三轴都在动：门架走巷道、载货台升降、货叉伸缩', () => {
    const run = runCenter(2400);
    expect(run.stackers.length).toBe(2);
    for (const [id, values] of run.seenZ) expect(values.size, `门架 ${id} 未沿 Z 行走`).toBeGreaterThan(3);
    for (const [id, values] of run.seenY) expect(values.size, `载货台 ${id} 未沿 Y 升降`).toBeGreaterThan(3);
    for (const [id, values] of run.seenX) expect(values.size, `货叉 ${id} 未沿 X 伸缩`).toBeGreaterThan(2);
  });

  test('立库存取事件会发，且层号是给 HUD 用的整数层数', () => {
    const run = runCenter(3600); // 60 秒，跨过若干个完整循环
    const events = run.world.getEventLog();
    const stores = events.filter((event) => event.type === 'asrs:store');
    const retrieves = events.filter((event) => event.type === 'asrs:retrieve');
    expect(stores.length).toBeGreaterThan(0);
    expect(retrieves.length).toBeGreaterThan(0);

    for (const event of stores) {
      const payload = event.payload as { level?: number; height?: number; column?: number };
      expect(Number.isInteger(payload.level), 'level 必须是整数层数，不能是高度').toBe(true);
      expect(payload.level ?? 0).toBeGreaterThanOrEqual(1);
      expect(typeof payload.height).toBe('number');
    }
  });

  test('确定性：同种子跑两遍，堆垛机姿态与事件流一致', () => {
    const a = runCenter(1200);
    const b = runCenter(1200);
    const pose = (world: TwinWorld, ids: string[]) =>
      ids.map((id) => (world.getEntity(id)?.transform.position ?? []).map((n) => n.toFixed(4)).join(',')).join('|');
    expect(pose(a.world, a.stackers.map((e) => e.id))).toBe(pose(b.world, b.stackers.map((e) => e.id)));
    const signature = (world: TwinWorld) =>
      world
        .getEventLog()
        .map((event) => `${event.type}|${event.entityId ?? ''}|${event.occurredAt}`)
        .join(';');
    expect(signature(a.world)).toBe(signature(b.world));
  });
});
