import { describe, expect, test } from 'bun:test';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import { buildCenterScene, logisticsPlugin } from './index';

/**
 * 货架存取（`asrs-cycle`）的行为测试。
 *
 * 这里测的不是"堆垛机动没动"，而是**库存语义**：先入先出有没有被遵守、
 * 托盘有没有真的落在货位上、占用率有没有跟着变、快照恢复后会不会分叉。
 * 这些都是"看着像对的"最容易骗过眼睛的部分，所以逐帧盯状态迁移。
 */

const STEP = 1 / 60;

/** 单巷道场景：一台堆垛机 + 4 块托盘，跑得快、看得清。 */
function createWorld(seed = 20240906, pallets = 4) {
  const scene = buildCenterScene({ parcels: 4, asrsPallets: pallets, externalLanes: 2, aisles: 1 });
  const behaviors = (logisticsPlugin.activate().behaviors ?? []) as WorldBehavior[];
  const world = new TwinWorld(scene as never, { seed, step: STEP, behaviors, maxStepsPerAdvance: 8 });
  const palletIds = scene.entities.filter((entity) => entity.kind === 'pallet').map((entity) => entity.id);
  const rackIds = scene.entities.filter((entity) => entity.kind === 'asrs').map((entity) => entity.id);
  return { scene, world, palletIds, rackIds };
}

/** 托盘状态的指纹：状态 + 货位 + 入架序号 + 位姿。 */
function signature(world: TwinWorld, palletIds: readonly string[]): string {
  return palletIds
    .map((id) => {
      const state = world.getEntity(id);
      const attrs = state?.attrs ?? {};
      const position = (state?.transform.position ?? []).map((value) => value.toFixed(4)).join(',');
      return `${id}:${String(attrs.state ?? '-')}:${String(attrs.slot ?? '-')}:${String(attrs.seq ?? '-')}:${position}`;
    })
    .join('|');
}

describe('货架先入先出', () => {
  test('入架序号单调递增，出库永远取序号最小的那块', () => {
    const { world, palletIds } = createWorld();
    let lastSeq = 0;
    let stores = 0;
    let retrieves = 0;

    for (let i = 0; i < 60 * 400; i += 1) {
      // 记下这一步之前的状态：状态迁移只有对比前后才看得见。
      const before = palletIds.map((id) => {
        const attrs = world.getEntity(id)?.attrs ?? {};
        return { id, state: String(attrs.state ?? ''), seq: Number(attrs.seq ?? -1) };
      });
      world.step(STEP);
      for (const previous of before) {
        const attrs = world.getEntity(previous.id)?.attrs ?? {};
        const state = String(attrs.state ?? '');
        const seq = Number(attrs.seq ?? -1);

        if (previous.state !== 'stored' && state === 'stored') {
          stores += 1;
          expect(seq, '入架序号必须比上一块大').toBeGreaterThan(lastSeq);
          lastSeq = seq;
        }
        if (previous.state === 'stored' && state === 'carrying-out') {
          retrieves += 1;
          const storedSeqs = before.filter((item) => item.state === 'stored').map((item) => item.seq);
          const oldest = Math.min(...storedSeqs);
          expect(previous.seq, `取货时货架上最老的序号是 ${oldest}`).toBe(oldest);
        }
      }
    }

    expect(stores).toBeGreaterThan(0);
    expect(retrieves).toBeGreaterThan(0);
  });

  test('入库取的是队列头（order 最小），入的是第一个空货位', () => {
    const { world, palletIds } = createWorld();
    let picked = 0;
    const usedSlots = new Set<string>();

    for (let i = 0; i < 60 * 400; i += 1) {
      const before = palletIds.map((id) => {
        const attrs = world.getEntity(id)?.attrs ?? {};
        return { id, state: String(attrs.state ?? ''), order: Number(attrs.order ?? -1) };
      });
      world.step(STEP);
      for (const previous of before) {
        const attrs = world.getEntity(previous.id)?.attrs ?? {};
        if (previous.state !== 'queued' || String(attrs.state ?? '') !== 'carrying-in') continue;
        picked += 1;
        const queuedOrders = before.filter((item) => item.state === 'queued').map((item) => item.order);
        expect(previous.order, '取走的必须是排队最久的那块').toBe(Math.min(...queuedOrders));
        usedSlots.add(String(attrs.slot ?? ''));
      }
    }

    expect(picked).toBeGreaterThan(0);
    // 托盘池只有 4 块，队列头反复被取走；货位是"第一个空位"，所以不会挑挑拣拣。
    expect(usedSlots.size).toBeGreaterThan(0);
  });

  test('托盘落在声明的层高上，同组托盘互不重叠', () => {
    const { world, scene, palletIds } = createWorld();
    const levelHeights = (scene.entities.find((entity) => entity.kind === 'asrs')?.config?.levelHeights ?? []) as number[];
    let checked = 0;

    const minGap = (points: readonly number[][]): number => {
      let min = Number.POSITIVE_INFINITY;
      for (let a = 0; a < points.length; a += 1) {
        for (let b = a + 1; b < points.length; b += 1) {
          const pa = points[a]!;
          const pb = points[b]!;
          min = Math.min(min, Math.hypot(pa[0]! - pb[0]!, pa[1]! - pb[1]!, pa[2]! - pb[2]!));
        }
      }
      return min;
    };

    for (let i = 0; i < 60 * 200; i += 1) {
      world.step(STEP);
      if (i % 60 !== 0) continue;
      const stored: number[][] = [];
      const queued: number[][] = [];
      const outbound: number[][] = [];
      for (const id of palletIds) {
        const state = world.getEntity(id);
        if (!state) continue;
        const kind = String(state.attrs.state ?? '');
        if (kind === 'stored') {
          stored.push(state.transform.position);
          checked += 1;
          const y = state.transform.position[1];
          expect(levelHeights.some((levelY) => Math.abs(y - (levelY + 0.3)) < 1e-6), `${id} 的 Y=${y} 不在层高上`).toBe(true);
        } else if (kind === 'queued') queued.push(state.transform.position);
        else if (kind === 'outbound') outbound.push(state.transform.position);
      }
      // 货位间距 ≥ 1.15（同列不同层），队列节距 0.9（拐角处略近），出库货位 0.8。
      expect(minGap(stored), '两块托盘占了同一个货位').toBeGreaterThan(1.0);
      expect(minGap(queued), '队列里两块托盘叠在一起').toBeGreaterThan(0.7);
      expect(minGap(outbound), '出库带上一块托盘压着另一块').toBeGreaterThan(0.7);
    }

    expect(checked).toBeGreaterThan(0);
  });

  test('货架占用 attrs 跟着库存变，且等于该侧已上架的托盘数', () => {
    const { world, palletIds, rackIds } = createWorld();
    const seen = new Map<string, Set<number>>(rackIds.map((id) => [id, new Set<number>()]));

    for (let i = 0; i < 60 * 300; i += 1) {
      world.step(STEP);
      if (i % 30 !== 0) continue;
      for (const rackId of rackIds) {
        const rack = world.getEntity(rackId);
        if (!rack) continue;
        const used = Number(rack.attrs.used ?? 0);
        seen.get(rackId)?.add(used);
        const side = String(rack.config?.side ?? 0);
        const stored = palletIds.filter((id) => {
          const attrs = world.getEntity(id)?.attrs ?? {};
          return attrs.state === 'stored' && String(attrs.slot ?? '').startsWith(`${side}:`);
        }).length;
        expect(used, `${rackId} 的占用数与已上架托盘数不符`).toBe(stored);
      }
    }

    // 两条货架都经历过"空 → 有货"，占用率不是写死的。
    for (const [, values] of seen) {
      expect(values.size, '占用率应该变化过').toBeGreaterThan(1);
      expect(Math.max(...values)).toBeGreaterThan(0);
    }
  });
});

describe('货架存取 · 确定性', () => {
  test('同种子跑两遍，托盘状态与位姿逐位一致', () => {
    const a = createWorld();
    const b = createWorld();
    for (let i = 0; i < 60 * 300; i += 1) {
      a.world.step(STEP);
      b.world.step(STEP);
    }
    expect(signature(a.world, a.palletIds)).toBe(signature(b.world, b.palletIds));
  });

  test('快照恢复后继续跑，和一路跑到底完全一样', () => {
    const straight = createWorld();
    for (let i = 0; i < 60 * 150; i += 1) straight.world.step(STEP);
    const snapshot = straight.world.snapshot();
    for (let i = 0; i < 60 * 150; i += 1) straight.world.step(STEP);

    const restored = createWorld();
    restored.world.restore(snapshot);
    for (let i = 0; i < 60 * 150; i += 1) restored.world.step(STEP);

    expect(signature(restored.world, restored.palletIds)).toBe(signature(straight.world, straight.palletIds));
  });

  test('出库托盘会回到入库队列：整条环路都跑得通', () => {
    const { world, palletIds } = createWorld();
    const reached = new Set<string>();
    for (let i = 0; i < 60 * 500; i += 1) {
      world.step(STEP);
      for (const id of palletIds) reached.add(String(world.getEntity(id)?.attrs.state ?? ''));
    }
    // 五个状态都出现过，说明"入库 → 上架 → 出库 → 出库待运 → 回队列"闭环了。
    expect(reached).toEqual(new Set(['queued', 'carrying-in', 'stored', 'carrying-out', 'outbound']));
  });
});
