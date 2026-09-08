import { describe, expect, it } from 'bun:test';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildCenterScene, centerTemplate, logisticsPlugin, splitClosedLoop } from './index';
import type { TwinVector3 } from '@twin-platform/scene-schema';

/** 把场景装上插件行为跑若干步，返回最终世界。 */
function simulate(scene: ReturnType<typeof buildCenterScene>, steps: number, seed = 20240906) {
  const host = new PluginHost();
  host.install(logisticsPlugin);
  const world = new TwinWorld(scene, { seed, maxStepsPerAdvance: 600, behaviors: host.behaviors });
  for (let i = 0; i < steps; i += 1) world.step(1 / 60);
  return world;
}

const closed = (points: TwinVector3[]): boolean =>
  points.length > 2 &&
  points[0]!.every((value, axis) => Math.abs(value - points[points.length - 1]![axis]!) < 1e-9);

describe('splitClosedLoop', () => {
  const corners: TwinVector3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 0, 6],
    [0, 0, 6],
  ];

  it('剪出来的路径首尾闭合，且周长与原折线一致', () => {
    for (const fraction of [0, 0.13, 0.5, 0.77]) {
      const loop = splitClosedLoop(corners, fraction);
      expect(closed(loop)).toBe(true);
      let total = 0;
      for (let i = 1; i < loop.length; i += 1) {
        const a = loop[i - 1]!;
        const b = loop[i]!;
        total += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      }
      expect(total).toBeCloseTo(32, 6);
    }
  });

  it('不同比例剪出的起点不同', () => {
    const a = splitClosedLoop(corners, 0)[0]!;
    const b = splitClosedLoop(corners, 0.25)[0]!;
    expect(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!)).toBeGreaterThan(1);
  });
});

describe('智能物流中心模板', () => {
  const scene = buildCenterScene({ parcels: 10, asrsParcels: 3, externalLanes: 4 });
  const entities = scene.entities;

  it('场景里有立库与堆垛机', () => {
    expect(entities.filter((e) => e.kind === 'asrs').length).toBe(4);
    expect(entities.filter((e) => e.kind === 'stacker').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'carriage').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'fork').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'pallet').length).toBe(2);
  });

  it('每条物料路径都首尾闭合，不会瞬移', () => {
    const movers = entities.filter((e) => e.motion);
    expect(movers.length).toBeGreaterThan(15);
    for (const mover of movers) {
      expect(closed(mover.motion!.points)).toBe(true);
    }
  });

  it('物料起步位置彼此错开，不会叠在一点', () => {
    const starts = entities
      .filter((e) => e.id.startsWith('parcel-'))
      .map((e) => e.transform.position.join(','));
    expect(new Set(starts).size).toBe(starts.length);
  });

  it('每条物料路径的每一个拐点下面都有输送线托着（不脱线）', () => {
    const belts = entities.filter((e) => e.kind === 'transport');
    for (const mover of entities.filter((e) => e.motion)) {
      for (const point of mover.motion!.points) {
        const covered = belts.some((belt) => {
          const [sx, , sz] = belt.visual?.size ?? [0, 0, 0];
          const [bx, , bz] = belt.transform.position;
          return Math.abs(point[0] - bx) <= sx / 2 + 1e-6 && Math.abs(point[2] - bz) <= sz / 2 + 1e-6;
        });
        expect(covered, `${mover.id} 的点 ${point.join(',')} 没有皮带`).toBe(true);
      }
    }
  });

  it('物料高度贴着输送线台面', () => {
    for (const mover of entities.filter((e) => e.motion)) {
      for (const point of mover.motion!.points) expect(point[1]).toBeCloseTo(1.2, 6);
    }
  });

  it('参数可伸缩：巷道数与外部车道数生效', () => {
    const one = centerTemplate.build({ aisles: 1, externalLanes: 2 });
    expect(one.filter((e) => e.kind === 'asrs').length).toBe(2);
    expect(one.filter((e) => e.kind === 'stacker').length).toBe(1);
    expect(one.filter((e) => e.kind === 'transport' && e.id.startsWith('ext-')).length).toBe(2);
  });
});

describe('堆垛机存取循环', () => {
  it('门架沿巷道走、载货台升降、货叉伸缩，并发存取事件', () => {
    const world = simulate(buildCenterScene({ parcels: 4, asrsParcels: 2, externalLanes: 2 }), 60 * 30);
    const crane = world.getEntity('stacker-a');
    const carriage = world.getEntity('stacker-a-carriage');
    const fork = world.getEntity('stacker-a-fork');
    const load = world.getEntity('stacker-a-load');
    expect(crane && carriage && fork && load).toBeTruthy();

    // 门架始终在巷道中心线上，且只沿 Z 走
    expect(crane!.transform.position[0]).toBeCloseTo(8, 6);
    expect(crane!.transform.position[1]).toBeCloseTo(0, 6);

    // 载货台与门架同步走 Z，但高度会变（起升过）
    expect(carriage!.transform.position[0]).toBeCloseTo(8, 6);
    const events = world.getEventLog();
    expect(events.some((event) => event.type === 'asrs:store')).toBe(true);
    expect(events.some((event) => event.type === 'asrs:retrieve')).toBe(true);
  });

  it('一个循环内货叉确实伸进过货架（X 偏离巷道中心）', () => {
    const host = new PluginHost();
    host.install(logisticsPlugin);
    const world = new TwinWorld(buildCenterScene({ parcels: 2, asrsParcels: 1, externalLanes: 1 }), {
      seed: 7,
      maxStepsPerAdvance: 600,
      behaviors: host.behaviors,
    });
    let maxOffset = 0;
    let maxHeight = 0;
    for (let i = 0; i < 60 * 40; i += 1) {
      world.step(1 / 60);
      const fork = world.getEntity('stacker-a-fork');
      if (!fork) continue;
      maxOffset = Math.max(maxOffset, Math.abs(fork.transform.position[0] - 8));
      maxHeight = Math.max(maxHeight, fork.transform.position[1]);
    }
    expect(maxOffset).toBeGreaterThan(1.0);
    expect(maxHeight).toBeGreaterThan(2.0);
  });

  it('同种子跑两遍，堆垛机位姿逐帧一致', () => {
    const pose = (): string => {
      const world = simulate(buildCenterScene({ parcels: 2, asrsParcels: 1, externalLanes: 1 }), 60 * 12);
      return ['stacker-a', 'stacker-a-carriage', 'stacker-a-fork', 'stacker-a-load']
        .map((id) => world.getEntity(id)?.transform.position.map((v) => v.toFixed(6)).join(','))
        .join('|');
    };
    expect(pose()).toBe(pose());
  });
});
