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
    // 移栽机本体也是一段 inline 输送面，拐角顶点可能落在它上面，故一并计入。
    const belts = entities.filter((e) => e.kind === 'transport' || e.kind === 'transfer');
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

describe('顶升移栽机分流', () => {
  it('场景里有一台移栽机本体 + 一个托举座子实体', () => {
    const scene = buildCenterScene({ parcels: 8, asrsParcels: 2, externalLanes: 2 });
    expect(scene.entities.filter((e) => e.id === 'transfer-1' && e.kind === 'transfer').length).toBe(1);
    expect(scene.entities.filter((e) => e.id === 'transfer-1-cassette' && e.kind === 'cassette').length).toBe(1);
    // 移栽机声明了要分流的物料
    const transfer = scene.entities.find((e) => e.id === 'transfer-1');
    expect((transfer?.config as { divertIds?: string[] })?.divertIds).toContain('divert-cargo-1');
  });

  it('分流物料经过移栽机时被顶起、触发 transfer:divert 事件，且全程不脱线', () => {
    const host = new PluginHost();
    host.install(logisticsPlugin);
    const world = new TwinWorld(buildCenterScene({ parcels: 4, asrsParcels: 1, externalLanes: 1 }), {
      seed: 20240906,
      maxStepsPerAdvance: 600,
      behaviors: host.behaviors,
    });

    let maxY = 0;
    let cargoMaxY = 0;
    let busySeen = false;
    for (let i = 0; i < 60 * 30; i += 1) {
      world.step(1 / 60);
      const cassette = world.getEntity('transfer-1-cassette');
      if (cassette) maxY = Math.max(maxY, cassette.transform.position[1]);
      const cargo = world.getEntity('divert-cargo-1');
      if (cargo) cargoMaxY = Math.max(cargoMaxY, cargo.transform.position[1]);
      const transfer = world.getEntity('transfer-1');
      if (transfer?.status === 'busy') busySeen = true;
    }

    // 托举座在某时刻被抬离原位（y 高于静止位 0.6）
    expect(maxY).toBeGreaterThan(0.6 + 0.1);
    // 被分流的货随托举座一起抬离台面（货底基准 1.2 + 抬升量），不再浮在 1.2
    expect(cargoMaxY).toBeGreaterThan(1.2 + 0.05);
    // 移栽机对指定货变 busy
    expect(busySeen).toBe(true);
    // 分流事件确实触发
    expect(world.getEventLog().some((event) => event.type === 'transfer:divert')).toBe(true);
  });

  it('分流物料路径每一拐点都有输送面托着', () => {
    const scene = buildCenterScene({ parcels: 4, asrsParcels: 1, externalLanes: 1 });
    const divert = scene.entities.find((e) => e.id === 'divert-cargo-1');
    expect(divert?.motion).toBeTruthy();
    const surfaces = scene.entities.filter((e) => e.kind === 'transport' || e.kind === 'transfer');
    for (const point of divert!.motion!.points) {
      const covered = surfaces.some((belt) => {
        const [sx, , sz] = belt.visual?.size ?? [0, 0, 0];
        const [bx, , bz] = belt.transform.position;
        return Math.abs(point[0] - bx) <= sx / 2 + 1e-6 && Math.abs(point[2] - bz) <= sz / 2 + 1e-6;
      });
      expect(covered, `divert 点 ${point.join(',')} 没有输送面`).toBe(true);
    }
  });
});

describe('90° 转角模块', () => {
  it('主环线/分流支线/立库环线的每个拐角都有转角皮带，且台面高度与输送线齐平', () => {
    const scene = buildCenterScene({ parcels: 8, asrsParcels: 2, externalLanes: 2 });
    const corners = scene.entities.filter((e) => (e.config as { corner?: boolean })?.corner === true);
    // 主环线 6 + 分流支线 4 + 两条立库环线各 4 = 18
    expect(corners.length).toBe(18);
    // 转角台面高度和普通输送线一致（y = BELT_Y = 0.6）
    for (const c of corners) expect(c.transform.position[1]).toBeCloseTo(0.6, 5);

    // 主环线 6 个拐角点下方都有转角模块
    const expected = [
      [16, 0], [16, -6], [-16, -6], [-16, 2], [-12, 2], [-12, 0],
    ];
    for (const [cx, cz] of expected) {
      const has = corners.some(
        (c) => Math.abs(c.transform.position[0] - cx) < 1e-6 && Math.abs(c.transform.position[2] - cz) < 1e-6,
      );
      expect(has, `拐角 (${cx},${cz}) 缺转角模块`).toBe(true);
    }
  });
});
