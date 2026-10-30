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
  const out: BeltBox[] = [];
  for (const entity of entities) {
    if (entity.kind !== 'transport' && entity.kind !== 'transfer') continue;
    const size = entity.visual?.size ?? [1, 1, 1];
    const px = entity.transform.position[0];
    const pz = entity.transform.position[2];
    const path = entity.config?.beltPath;
    // 折线皮带（conveyorPolyline）要按段拆开，否则只认锚点那一格会把
    // 整条线上的货全判成"脱线"。
    if (Array.isArray(path) && path.length >= 2) {
      const w = typeof entity.config?.beltWidth === 'number' ? (entity.config.beltWidth as number) : size[0];
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = path[i] as [number, number];
        const b = path[i + 1] as [number, number];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        const ax = px + a[0];
        const az = pz + a[1];
        const bx = px + b[0];
        const bz = pz + b[1];
        const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
        const padX = alongX ? 0 : w / 2;
        const padZ = alongX ? w / 2 : 0;
        out.push({ id: `${entity.id}#${i}`, x0: Math.min(ax, bx) - padX, x1: Math.max(ax, bx) + padX, z0: Math.min(az, bz) - padZ, z1: Math.max(az, bz) + padZ });
      }
    } else {
      out.push({ id: entity.id, x0: px - size[0] / 2, x1: px + size[0] / 2, z0: pz - size[2] / 2, z1: pz + size[2] / 2 });
    }
  }
  return out;
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
  // 小货物由发生器动态产出，所以间隔压到 2s，跑一小会儿线上就有货了。
  const scene = buildCenterScene({ maxWip: 10, produceInterval: 2, highWater: 6, externalLanes: 4, aisles: 2 });
  const behaviors = (logisticsPlugin.activate().behaviors ?? []) as WorldBehavior[];
  const world = new TwinWorld(scene as never, { seed: 20240906, step: STEP, behaviors, maxStepsPerAdvance: 8 });

  const boxes = beltBoxes(scene.entities);
  const offBelt: string[] = [];
  let samples = 0;
  let parcelCount = 0;

  const stackers = scene.entities.filter((entity) => entity.kind === 'stacker');
  const carriages = scene.entities.filter((entity) => entity.kind === 'carriage');
  const forks = scene.entities.filter((entity) => entity.kind === 'fork');
  const seenZ = new Map(stackers.map((entity) => [entity.id, new Set<number>()]));
  const seenY = new Map(carriages.map((entity) => [entity.id, new Set<number>()]));
  const seenX = new Map(forks.map((entity) => [entity.id, new Set<number>()]));

  for (let i = 0; i < steps; i += 1) {
    world.step(STEP);
    if (i % sampleEvery !== 0) continue;

    // 小货物是运行时生成的：每步从世界状态里捞，而不是查场景声明表。
    for (const parcel of world.listEntities()) {
      if (parcel.kind !== 'parcel') continue;
      parcelCount += 1;
      samples += 1;
      if (!onBelt(boxes, parcel.transform.position)) {
        offBelt.push(`${parcel.id}@${parcel.transform.position.map((n) => n.toFixed(2)).join(',')}`);
      }
    }

    const round = (n: number) => Math.round(n * 20) / 20;
    for (const entity of stackers) seenZ.get(entity.id)?.add(round(world.getEntity(entity.id)?.transform.position[2] ?? 0));
    for (const entity of carriages) seenY.get(entity.id)?.add(round(world.getEntity(entity.id)?.transform.position[1] ?? 0));
    for (const entity of forks) seenX.get(entity.id)?.add(round(world.getEntity(entity.id)?.transform.position[0] ?? 0));
  }

  return { world, boxes, parcelCount, offBelt, samples, seenZ, seenY, seenX, stackers, carriages, forks };
}

describe('智能物流中心 · 运行时', () => {
  test('物料全程贴着皮带走，不会脱线悬空', () => {
    const run = runCenter(2400); // 40 秒
    expect(run.parcelCount).toBeGreaterThan(0);
    expect(run.samples).toBeGreaterThan(0);
    // 关键回归：曾经物料路径是手写角点，很多段下面压根没皮带。
    expect(run.offBelt).toEqual([]);
  });

  test('堆垛机三轴都在动：门架走巷道、载货台升降、货叉伸缩', () => {
    // 90 秒：足够"发生器产出 → 打包 → 托盘走到队列 → 堆垛机取货入库"走一轮。
    const run = runCenter(60 * 90);
    expect(run.stackers.length).toBe(2);
    for (const [id, values] of run.seenZ) expect(values.size, `门架 ${id} 未沿 Z 行走`).toBeGreaterThan(3);
    for (const [id, values] of run.seenY) expect(values.size, `载货台 ${id} 未沿 Y 升降`).toBeGreaterThan(3);
    for (const [id, values] of run.seenX) expect(values.size, `货叉 ${id} 未沿 X 伸缩`).toBeGreaterThan(2);
  });

  test('立库存取事件会发，且层号是给 HUD 用的整数层数', () => {
    // 240 秒：先由打包站攒出托盘、入库，库存到高水位后开始出库。
    const run = runCenter(60 * 240);
    const events = run.world.getEventLog();
    const stores = events.filter((event) => event.type === 'asrs:store');
    const retrieves = events.filter((event) => event.type === 'asrs:retrieve');
    expect(stores.length).toBeGreaterThan(0);
    expect(retrieves.length).toBeGreaterThan(0);

    for (const event of stores) {
      const payload = event.payload as { level?: number; height?: number; column?: number; pallet?: string };
      expect(Number.isInteger(payload.level), 'level 必须是整数层数，不能是高度').toBe(true);
      expect(payload.level ?? 0).toBeGreaterThanOrEqual(1);
      expect(typeof payload.height).toBe('number');
      expect(typeof payload.pallet).toBe('string');
    }
  });

  test('托盘被搬进货架：位置落在货架占地内、且坐在声明的层高上', () => {
    const run = runCenter(60 * 240);
    const pallets = run.world.listEntities().filter((entity) => entity.kind === 'pallet');
    const racks = run.world.scene.entities.filter((entity) => entity.kind === 'asrs');
    let stored = 0;
    for (const pallet of pallets) {
      const state = run.world.getEntity(pallet.id);
      if (state?.attrs.state !== 'stored') continue;
      stored += 1;
      const [px, py, pz] = state.transform.position;
      // 货位 X 必须落在某排货架的占地内（托盘不能悬在巷道里）
      const inRack = racks.some((rack) => {
        const size = rack.visual?.size ?? [0, 0, 0];
        const rx = rack.transform.position[0];
        const rz = rack.transform.position[2];
        return Math.abs(px - rx) <= size[0] / 2 + 0.2 && Math.abs(pz - rz) <= size[2] / 2 + 0.2;
      });
      expect(inRack, `${pallet.id} 没落在货架里（x=${px.toFixed(2)}, z=${pz.toFixed(2)}）`).toBe(true);
      // 层高 = 声明值 + 托盘半高，说明它坐在横梁上而不是浮空
      const levelYs = (racks[0]?.config?.levelHeights as number[]) ?? [];
      expect(levelYs.some((levelY) => Math.abs(py - (levelY + 0.3)) < 1e-6), `${pallet.id} 的 Y=${py} 不在层高上`).toBe(true);
    }
    expect(stored).toBeGreaterThan(0);
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
