import { describe, expect, test } from 'bun:test';
import { TwinWorld } from '@twin-platform/world-kernel';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { buildCenterScene, logisticsPlugin } from './index';

const STEP = 1 / 60;

function makeWorld() {
  const host = new PluginHost();
  host.install(logisticsPlugin);
  return new TwinWorld(
    // 打包间隔调小、在制品放宽：3 分钟里就能跑出足够多的托盘
    buildCenterScene({ produceInterval: 1, maxWip: 8, highWater: 6, aisles: 2 }),
    { seed: 20240906, maxStepsPerAdvance: 600, behaviors: host.behaviors },
  );
}

const num = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

describe('立库托盘流：料应进入堆垛机（托盘）而非在站台皮带上倒回', () => {
  test('模拟 3 分钟：无倒回 + 托盘入库 → 出库 → 被卡车运走', () => {
    const world = makeWorld();
    // 托盘由打包站动态产出，所以边跑边把新出现的托盘纳入跟踪。
    const last = new Map<string, { qpos: number; queued: boolean }>();
    const everState = new Map<string, Set<string>>();
    const backtracks: string[] = [];

    for (let i = 0; i < 60 * 180; i += 1) {
      world.step(STEP);
      if (i % 30 !== 0) continue;
      for (const entity of world.listEntities()) {
        if (entity.kind !== 'pallet') continue;
        if (!everState.has(entity.id)) {
          everState.set(entity.id, new Set());
          last.set(entity.id, { qpos: Infinity, queued: false });
        }
        const state = String(entity.attrs.state ?? '');
        everState.get(entity.id)!.add(state);

        // 连续 queued 段内 qpos 单调不增 = 前进（朝巷道口/堆垛机）。
        // 离开队列就断开连续段，下次回到 queued 重新起算——接管时 qpos 跳到队尾不算"倒回去"。
        const qpos = num(entity.attrs.qpos, Infinity);
        const prev = last.get(entity.id)!;
        if (state === 'queued') {
          if (prev.queued && prev.qpos !== Infinity && qpos > prev.qpos + 1e-6) {
            backtracks.push(`${entity.id}@step${i}: qpos ${prev.qpos.toFixed(3)} -> ${qpos.toFixed(3)}`);
          }
          prev.qpos = qpos;
          prev.queued = true;
        } else {
          prev.queued = false;
          prev.qpos = Infinity;
        }
      }
    }

    const events = world.getEventLog();
    const stores = events.filter((ev) => ev.type === 'asrs:store').length;
    const retrieves = events.filter((ev) => ev.type === 'asrs:retrieve').length;
    const shipped = events.filter((ev) => ev.type === 'goods:shipped').length;

    // 1) 核心回归：用户看到的"倒回去"绝不允许发生
    expect(backtracks, `检测到托盘在站台皮带上倒退：\n${backtracks.join('\n')}`).toEqual([]);

    // 2) 出入库事件都发
    expect(stores, `store 事件数=${stores}`).toBeGreaterThan(0);
    expect(retrieves, `retrieve 事件数=${retrieves}`).toBeGreaterThan(0);

    // 3) 托盘都进过堆垛机并被存入货位（= 料"进入托盘/货叉"）
    const tracked = [...everState.keys()];
    expect(tracked.length).toBeGreaterThan(0);
    const stored = tracked.filter((id) => everState.get(id)!.has('stored'));
    expect(stored.length, `入库过的托盘数=${stored.length}/${tracked.length}`).toBeGreaterThan(0);
    for (const id of stored) {
      expect(everState.get(id)!.has('carrying-in') || everState.get(id)!.has('queued'), `${id} 没进过货叉`).toBe(true);
    }

    // 4) 闭环：托盘走完"入库 → 出库 → 出库待运"，并被卡车运走（真正离开系统）
    expect(shipped).toBeGreaterThan(0);
    const fullyCycled = stored.filter((id) => {
      const seen = everState.get(id)!;
      return seen.has('carrying-out') && seen.has('outbound');
    });
    expect(fullyCycled.length, `走完出入库的托盘数=${fullyCycled.length}`).toBeGreaterThan(0);
    // 被运走的托盘真的从世界里消失了
    for (const event of events.filter((ev) => ev.type === 'goods:shipped')) {
      const cargo = (event.payload as { cargo?: string } | undefined)?.cargo;
      if (cargo) expect(world.getEntity(cargo), `${cargo} 被运走后不该还在场景里`).toBeUndefined();
    }
  });
});
