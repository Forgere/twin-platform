import { describe, expect, test } from 'bun:test';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import type { TwinEntity } from '@twin-platform/scene-schema';
import { buildCenterScene, logisticsPlugin } from './index';

/**
 * 闭环产线端到端测试（`logistics-center` 场景本身）：
 * **小货物产出 → 输送 → 2 合 1 打包 → 入库 → 出库 → 卡车运走**。
 *
 * 这条链路跨了五个行为、两种实体生命周期（生成/销毁）和一次快照恢复，
 * 所以不测"某台设备动没动"，而是测**守恒与次序**：
 * 产出的小货物 = 被消耗的 + 还在线上的；打包出的托盘 = 已运走的 + 还在系统里的。
 * 守恒一旦破，说明有实体凭空多出来或凭空消失——这类 bug 靠看画面是发现不了的。
 */

const STEP = 1 / 60;
/** 加速用的参数：产出间隔 1s、在制品 8、库存高水位 6，5 分钟就能跑出完整闭环。 */
const FAST = { produceInterval: 1, maxWip: 8, highWater: 6, aisles: 2 } as const;

function makeWorld(steps = 0, seed = 20240906) {
  const scene = buildCenterScene(FAST);
  const behaviors = (logisticsPlugin.activate().behaviors ?? []) as WorldBehavior[];
  const world = new TwinWorld(scene, { seed, step: STEP, behaviors, maxStepsPerAdvance: 8 });
  for (let i = 0; i < steps; i += 1) world.step(STEP);
  return { scene, world };
}

/** 皮带 / 货架的俯视占地，用来验证"货物没有飘在空中"。 */
function surfaces(entities: readonly TwinEntity[]): { x0: number; x1: number; z0: number; z1: number }[] {
  const out: { x0: number; x1: number; z0: number; z1: number }[] = [];
  for (const entity of entities) {
    if (entity.kind !== 'transport' && entity.kind !== 'transfer' && entity.kind !== 'asrs') continue;
    const size = entity.visual?.size ?? [1, 1, 1];
    const px = entity.transform.position[0];
    const pz = entity.transform.position[2];
    const path = entity.config?.beltPath;
    if (Array.isArray(path) && path.length >= 2) {
      const width = typeof entity.config?.beltWidth === 'number' ? (entity.config.beltWidth as number) : size[0];
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = path[i] as [number, number];
        const b = path[i + 1] as [number, number];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        const ax = px + a[0];
        const az = pz + a[1];
        const bx = px + b[0];
        const bz = pz + b[1];
        const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
        const padX = alongX ? 0 : width / 2;
        const padZ = alongX ? width / 2 : 0;
        out.push({
          x0: Math.min(ax, bx) - padX,
          x1: Math.max(ax, bx) + padX,
          z0: Math.min(az, bz) - padZ,
          z1: Math.max(az, bz) + padZ,
        });
      }
      continue;
    }
    out.push({ x0: px - size[0] / 2, x1: px + size[0] / 2, z0: pz - size[2] / 2, z1: pz + size[2] / 2 });
  }
  return out;
}

const onSurface = (boxes: readonly { x0: number; x1: number; z0: number; z1: number }[], position: readonly number[]): boolean => {
  const [px, , pz] = position;
  // 容差吸收圆角、托盘半宽与货叉伸出量
  return boxes.some((b) => px >= b.x0 - 0.9 && px <= b.x1 + 0.9 && pz >= b.z0 - 0.9 && pz <= b.z1 + 0.9);
};

const countByType = (world: TwinWorld): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const event of world.getEventLog()) out[event.type] = (out[event.type] ?? 0) + 1;
  return out;
};

describe('智能物流中心 · 闭环产线', () => {
  test('四个环节都在场景声明里：发生器 / 打包站 / 立库 / 卡车', () => {
    const { scene } = makeWorld();
    const byKind = (kind: string): TwinEntity[] => scene.entities.filter((entity) => entity.kind === kind);
    expect(byKind('source').length).toBe(1);
    expect(byKind('pack').length).toBe(2);
    expect(byKind('stacker').length).toBe(2);
    expect(byKind('asrs').length).toBe(4);
    expect(byKind('truck').length).toBe(2);

    // 打包站声明了"几个小货物合一个"和托盘去向
    for (const pack of byKind('pack')) {
      expect(pack.config?.batch).toBe(2);
      expect(typeof pack.config?.carrier).toBe('string');
      expect(Array.isArray(pack.config?.palletPath)).toBe(true);
    }
    // 卡车声明了装车货位、容量和路线
    for (const truck of byKind('truck')) {
      expect(truck.config?.capacity).toBe(4);
      expect((truck.config?.route as unknown[]).length).toBeGreaterThan(1);
    }
    // 托盘不再预置：全部由打包站产出
    expect(byKind('pallet').length).toBe(0);
  });

  test('整条线跑通：产出 → 打包 → 入库 → 出库 → 卡车运走', () => {
    const { world } = makeWorld(60 * 300); // 5 分钟
    const counts = countByType(world);
    expect(counts['goods:produced'] ?? 0).toBeGreaterThan(0);
    expect(counts['goods:packed'] ?? 0).toBeGreaterThan(0);
    expect(counts['asrs:store'] ?? 0).toBeGreaterThan(0);
    expect(counts['asrs:retrieve'] ?? 0).toBeGreaterThan(0);
    expect(counts['goods:shipped'] ?? 0).toBeGreaterThan(0);
    expect(counts['truck:departed'] ?? 0).toBeGreaterThan(0);
  });

  test('打包是严格的 2 合 1：每次消耗 2 个小货物、产 1 个托盘', () => {
    const { world } = makeWorld(60 * 240);
    const packed = world.getEventLog().filter((event) => event.type === 'goods:packed');
    const producedIds = new Set(
      world.getEventLog().filter((event) => event.type === 'goods:produced').map((event) => event.entityId as string),
    );
    const consumed = new Set<string>();

    for (const event of packed) {
      const payload = event.payload as { inputs?: string; count?: number; pallet?: string };
      const inputs = String(payload.inputs ?? '').split(',').filter(Boolean);
      expect(inputs.length).toBe(2);
      expect(payload.count).toBe(2);
      for (const id of inputs) {
        expect(producedIds.has(id), `${id} 不是发生器产出的`).toBe(true);
        expect(consumed.has(id), `${id} 被重复消耗`).toBe(false);
        expect(world.getEntity(id), `${id} 打包后应该已经从世界里消失`).toBeUndefined();
        consumed.add(id);
      }
      expect(inputs).not.toContain(payload.pallet);
    }
    expect(packed.length).toBeGreaterThan(0);
  });

  test('物料守恒：小货物 = 2×打包数 + 在制；托盘 = 已运走 + 在系统里', () => {
    const { world } = makeWorld(60 * 300);
    const counts = countByType(world);
    const produced = counts['goods:produced'] ?? 0;
    const packed = counts['goods:packed'] ?? 0;
    const shipped = counts['goods:shipped'] ?? 0;

    const liveGoods = world.listEntities().filter((entity) => entity.kind === 'parcel' && String(entity.config?.source ?? '') !== '').length;
    const livePallets = world.listEntities().filter((entity) => entity.kind === 'pallet').length;

    // 产出的小货物：一半被吃进打包站，一半还跑在线上
    expect(produced).toBe(packed * 2 + liveGoods);
    // 打包出的托盘：要么已经被卡车拉走，要么还在线上（队列/货架/缓存台）
    expect(packed).toBe(shipped + livePallets);
  });

  test('背压：在制小货物不超过发生器声明的 maxWip', () => {
    const { scene, world } = makeWorld();
    const maxWip = Number(scene.entities.find((entity) => entity.kind === 'source')?.config?.maxWip ?? 0);
    expect(maxWip).toBeGreaterThan(0);
    let peak = 0;
    for (let i = 0; i < 60 * 240; i += 1) {
      world.step(STEP);
      // 只数发生器自己产出的货（分流支线的 divert-cargo-1 不算在制品）
      const mine = world
        .listEntities()
        .filter((entity) => entity.kind === 'parcel' && String(entity.config?.source ?? '') !== '').length;
      peak = Math.max(peak, mine);
    }
    expect(peak).toBeLessThanOrEqual(maxWip);
  });

  test('卡车按容量装车：每趟至少 1 件、不超过容量，且装走的托盘真的消失了', () => {
    const { world } = makeWorld(60 * 300);
    const events = world.getEventLog();
    const capacity = 4;
    const departures = events.filter((event) => event.type === 'truck:departed');
    const shipments = events.filter((event) => event.type === 'goods:shipped');
    expect(departures.length).toBeGreaterThan(0);

    let total = 0;
    for (const event of departures) {
      const load = Number((event.payload as { load?: number }).load ?? 0);
      // 攒批发车：装一件就走是 bug（发货窗口没在每次装货后重置，等第一件货的
      // 时间被算进了等待窗口）。正常应该攒满 capacity 才发车，这里退一步要求
      // 至少 2 件，容忍场景末尾断流导致的半车发车。
      expect(load, `单趟只装了 ${load} 件就发车（装一件就走）`).toBeGreaterThanOrEqual(2);
      expect(load).toBeLessThanOrEqual(capacity);
      total += load;
    }
    // 最后一趟可能还没发车：车上现载的也要算进来，账才对得上。
    const onboard = ['truck-a', 'truck-b'].reduce((sum, id) => sum + Number(world.getEntity(id)?.attrs.load ?? 0), 0);
    expect(total + onboard).toBe(shipments.length);
    for (const event of shipments) {
      expect(world.getEntity((event.payload as { cargo: string }).cargo)).toBeUndefined();
    }
  });

  test('卡车车头朝着行驶方向（不会车身横着平移）', () => {
    const { world } = makeWorld(60 * 300);
    const prev = new Map<string, { x: number; z: number; rot: number }>();
    let worstCos = 1;
    let samples = 0;
    for (let i = 0; i < 60 * 300; i += 1) {
      world.step(STEP);
      if (i % 10 !== 0) continue;
      for (const id of ['truck-a', 'truck-b']) {
        const truck = world.getEntity(id);
        // 只看离场：回场是原路倒回来，车头本来就朝着反方向。
        if (!truck || String(truck.attrs.truckState ?? '') !== 'departing') {
          prev.delete(id);
          continue;
        }
        const [px, , pz] = truck.transform.position as [number, number, number];
        const rot = Number((truck.transform.rotation as number[] | undefined)?.[1] ?? 0);
        const before = prev.get(id);
        prev.set(id, { x: px, z: pz, rot });
        if (!before) continue;
        const dx = px - before.x;
        const dz = pz - before.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-3) continue;
        // 车头（模型长边 local +Z）绕 Y 转 rot 后指向 (sinθ, 0, cosθ)
        const cos = (Math.sin(rot) * dx + Math.cos(rot) * dz) / dist;
        samples += 1;
        if (cos < worstCos) worstCos = cos;
      }
    }
    expect(samples, '没采到卡车离场过程').toBeGreaterThan(0);
    // cos>0.999 ≈ 夹角<2.6°。修 headingAt 之前车身比行驶方向少转 90°（cos≈0），
    // 看起来就是卡车横着平移出去。
    expect(worstCos, `车头与行驶方向最大夹角 cos=${worstCos.toFixed(4)}`).toBeGreaterThan(0.999);
  });

  test('货物全程贴着皮带 / 货架走，不会飘在空中', () => {
    const { scene, world } = makeWorld();
    const boxes = surfaces(scene.entities);
    const offenders: string[] = [];
    for (let i = 0; i < 60 * 240; i += 1) {
      world.step(STEP);
      if (i % 40 !== 0) continue;
      for (const entity of world.listEntities()) {
        if (entity.kind !== 'parcel' && entity.kind !== 'pallet') continue;
        // 被货叉抬着的托盘本来就走在巷道上方（巷道里没有皮带），不算脱线
        if (entity.attrs.state === 'carrying-in' || entity.attrs.state === 'carrying-out') continue;
        // 被打包站扣在缓存位上的小货物停在站台里，也不算脱线
        if (entity.attrs.heldBy !== undefined) continue;
        if (!onSurface(boxes, entity.transform.position)) {
          offenders.push(`${entity.id}@${entity.transform.position.map((n) => n.toFixed(1)).join(',')}`);
        }
      }
    }
    expect(offenders.slice(0, 5)).toEqual([]);
  });

  test('确定性：同种子两遍，事件流与实体指纹逐位一致', () => {
    const a = makeWorld(60 * 240);
    const b = makeWorld(60 * 240);
    const signature = (world: TwinWorld): string =>
      world
        .getEventLog()
        .map((event) => `${event.type}|${event.entityId ?? ''}|${event.occurredAt}`)
        .join(';');
    expect(signature(a.world)).toBe(signature(b.world));

    const fingerprint = (world: TwinWorld): string =>
      world
        .listEntities()
        .map((entity) => `${entity.id}:${entity.transform.position.map((n) => n.toFixed(4)).join(',')}:${String(entity.attrs.state ?? '')}`)
        .sort()
        .join('|');
    expect(fingerprint(a.world)).toBe(fingerprint(b.world));
  });

  test('快照恢复后继续跑：生成出来的小货物与托盘都能按声明重建', () => {
    const straight = makeWorld(60 * 150);
    const snapshot = straight.world.snapshot();
    for (let i = 0; i < 60 * 150; i += 1) straight.world.step(STEP);

    const restored = makeWorld();
    restored.world.restore(snapshot);
    for (let i = 0; i < 60 * 150; i += 1) restored.world.step(STEP);

    const fingerprint = (world: TwinWorld): string =>
      world
        .listEntities()
        .map((entity) => `${entity.id}:${entity.transform.position.map((n) => n.toFixed(4)).join(',')}:${String(entity.attrs.state ?? '')}`)
        .sort()
        .join('|');
    expect(fingerprint(restored.world)).toBe(fingerprint(straight.world));

    // 恢复出来的托盘要带着声明（能力/外观/路径），否则渲染与后续行为都会退化
    const pallet = restored.world.listEntities().find((entity) => entity.kind === 'pallet');
    if (pallet) {
      expect(pallet.capabilities).toEqual(['pallet']);
      expect(pallet.visual?.size).toEqual([0.8, 0.56, 1]);
      expect(Array.isArray(pallet.config.path)).toBe(true);
    }
  });
});
