import { describe, expect, it } from 'bun:test';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildCenterScene, centerTemplate, logisticsPlugin, splitClosedLoop } from './index';
import type { TwinEntity, TwinVector3 } from '@twin-platform/scene-schema';

/** 把输送面（含折线皮带，按段拆分）展开成俯视矩形，供"拐点/拐角是否托住"校验。 */
function beltSurfaces(entities: TwinEntity[]): { x0: number; x1: number; z0: number; z1: number }[] {
  const out: { x0: number; x1: number; z0: number; z1: number }[] = [];
  for (const entity of entities) {
    if (entity.kind !== 'transport' && entity.kind !== 'transfer') continue;
    const size = entity.visual?.size ?? [1, 1, 1];
    const px = entity.transform.position[0];
    const pz = entity.transform.position[2];
    const path = entity.config?.beltPath;
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
        out.push({ x0: Math.min(ax, bx) - padX, x1: Math.max(ax, bx) + padX, z0: Math.min(az, bz) - padZ, z1: Math.max(az, bz) + padZ });
      }
    } else {
      out.push({ x0: px - size[0] / 2, x1: px + size[0] / 2, z0: pz - size[2] / 2, z1: pz + size[2] / 2 });
    }
  }
  return out;
}

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
  const scene = buildCenterScene({ maxWip: 10, produceInterval: 6, externalLanes: 4 });
  const entities = scene.entities;

  it('闭环产线的四个环节都在场景里：发生器 / 打包站 / 立库 / 卡车', () => {
    expect(entities.filter((e) => e.kind === 'source').length).toBe(1);
    expect(entities.filter((e) => e.kind === 'pack').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'asrs').length).toBe(4);
    expect(entities.filter((e) => e.kind === 'stacker').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'carriage').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'fork').length).toBe(2);
    expect(entities.filter((e) => e.kind === 'truck').length).toBe(2);
    // 大货物（托盘）不再预置：全部由打包站产出，所以场景里一块托盘都没有。
    expect(entities.filter((e) => e.kind === 'pallet').length).toBe(0);
    for (const station of entities.filter((e) => e.kind === 'pack')) {
      expect(station.config?.batch).toBe(2);
      expect(typeof station.config?.carrier).toBe('string');
    }
    expect(new Set(entities.filter((e) => e.kind === 'pack').map((e) => e.config?.carrier))).toEqual(
      new Set(['stacker-a', 'stacker-b']),
    );
  });

  it('货架声明了货位几何（层高与列数），堆垛机用同一份数据', () => {
    for (const rack of entities.filter((e) => e.kind === 'asrs')) {
      expect(Array.isArray(rack.config?.levelHeights)).toBe(true);
      expect((rack.config?.levelHeights as number[]).length).toBe(3);
      expect(rack.config?.bays).toBe(5);
    }
    const crane = entities.find((e) => e.id === 'stacker-a');
    const rack = entities.find((e) => e.id === 'rack-a1');
    expect(crane?.config?.levels).toEqual(rack?.config?.levelHeights);
    expect(crane?.config?.columns).toBe(rack?.config?.bays);
    expect(crane?.config?.stationX).toBe(4);
    expect(Array.isArray(crane?.config?.outfeedZ)).toBe(true);
  });

  it('小货物路径首尾闭合，不会瞬移', () => {
    // 小货物由发生器动态产出（不走场景声明的 motion），路径写在发生器的 config 里。
    const source = entities.find((e) => e.kind === 'source')!;
    const path = source.config?.goodsPath as [number, number, number][];
    expect(path.length).toBeGreaterThan(2);
    expect(closed(path)).toBe(true);
  });

  it('每条物料路径的每一个拐点下面都有输送线托着（不脱线）', () => {
    // 移栽机本体也是一段 inline 输送面；折线皮带按段拆开，拐角顶点才可能落在它上面。
    const surfaces = beltSurfaces(entities);
    const paths: { id: string; points: [number, number, number][] }[] = [
      { id: 'source-1.goodsPath', points: entities.find((e) => e.kind === 'source')!.config?.goodsPath as never },
      ...entities
        .filter((e) => e.kind === 'pack')
        .map((e) => ({ id: `${e.id}.palletPath`, points: e.config?.palletPath as never })),
      ...entities.filter((e) => e.motion).map((e) => ({ id: e.id, points: e.motion!.points as never })),
    ];
    for (const path of paths) {
      for (const point of path.points) {
        const covered = surfaces.some(
          (b) => point[0] >= b.x0 - 1e-6 && point[0] <= b.x1 + 1e-6 && point[2] >= b.z0 - 1e-6 && point[2] <= b.z1 + 1e-6,
        );
        expect(covered, `${path.id} 的点 ${point.join(',')} 没有皮带`).toBe(true);
      }
    }
  });

  it('物料高度贴着输送线台面', () => {
    for (const entity of entities.filter((e) => e.motion)) {
      for (const point of entity.motion!.points) expect(point[1]).toBeCloseTo(1.2, 6);
    }
    for (const entity of entities.filter((e) => e.kind === 'source' || e.kind === 'pack')) {
      const path = (entity.config?.goodsPath ?? entity.config?.palletPath) as [number, number, number][];
      for (const point of path) expect(point[1]).toBeCloseTo(1.2, 6);
    }
  });

  it('参数可伸缩：巷道数、在制品上限与高水位生效', () => {
    const one = centerTemplate.build({ aisles: 1, maxWip: 4, highWater: 3 });
    expect(one.filter((e) => e.kind === 'asrs').length).toBe(2);
    expect(one.filter((e) => e.kind === 'stacker').length).toBe(1);
    expect(one.filter((e) => e.kind === 'pack').length).toBe(1);
    expect(one.filter((e) => e.kind === 'truck').length).toBe(1);
    expect(one.find((e) => e.kind === 'source')?.config?.maxWip).toBe(4);
    expect(one.find((e) => e.id === 'stacker-a')?.config?.highWater).toBe(3);
  });
});

describe('堆垛机存取循环', () => {
  it('门架沿巷道走、载货台升降、货叉伸缩，并发存取事件', () => {
    // 打包间隔压到 1s、在制品放宽：30s 内就能攒出托盘并走完"入库 → 出库"。
    const world = simulate(
      buildCenterScene({ maxWip: 8, produceInterval: 1, highWater: 4, externalLanes: 2 }),
      60 * 120,
    );
    const crane = world.getEntity('stacker-a');
    const carriage = world.getEntity('stacker-a-carriage');
    const fork = world.getEntity('stacker-a-fork');
    expect(crane && carriage && fork).toBeTruthy();
    // 托盘是打包站产出的：跑一会儿必然有一块在系统里（或已经被卡车运走）
    expect(world.listEntities().some((entity) => entity.kind === 'pallet') || world.getEventLog().some((e) => e.type === 'goods:shipped')).toBe(true);

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
    const world = new TwinWorld(buildCenterScene({ maxWip: 6, produceInterval: 1, highWater: 4, externalLanes: 1 }), {
      seed: 7,
      maxStepsPerAdvance: 600,
      behaviors: host.behaviors,
    });
    let maxOffset = 0;
    let maxHeight = 0;
    // 托盘从打包站走到队列、再等堆垛机来取需要时间；要跑到它开始往 2/3 层存货。
    for (let i = 0; i < 60 * 150; i += 1) {
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
      const world = simulate(buildCenterScene({ maxWip: 6, produceInterval: 1, highWater: 4, externalLanes: 1 }), 60 * 40);
      return ['stacker-a', 'stacker-a-carriage', 'stacker-a-fork']
        .map((id) => world.getEntity(id)?.transform.position.map((v) => v.toFixed(6)).join(','))
        .join('|');
    };
    expect(pose()).toBe(pose());
  });
});

describe('顶升移栽机分流', () => {
  it('场景里有一台移栽机本体 + 一个托举座子实体', () => {
    const scene = buildCenterScene({ externalLanes: 2 });
    expect(scene.entities.filter((e) => e.id === 'transfer-1' && e.kind === 'transfer').length).toBe(1);
    expect(scene.entities.filter((e) => e.id === 'transfer-1-cassette' && e.kind === 'cassette').length).toBe(1);
    // 移栽机声明了要分流的物料
    const transfer = scene.entities.find((e) => e.id === 'transfer-1');
    expect((transfer?.config as { divertIds?: string[] })?.divertIds).toContain('divert-cargo-1');
  });

  it('分流物料经过移栽机时被顶起、触发 transfer:divert 事件，且全程不脱线', () => {
    const host = new PluginHost();
    host.install(logisticsPlugin);
    const world = new TwinWorld(buildCenterScene({ maxWip: 6, produceInterval: 2, externalLanes: 1 }), {
      seed: 20240906,
      maxStepsPerAdvance: 600,
      behaviors: host.behaviors,
    });

    let maxY = 0;
    let cargoMaxY = 0;
    let busySeen = false;
    for (let i = 0; i < 60 * 60; i += 1) {
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
    const scene = buildCenterScene({ externalLanes: 1 });
    const divert = scene.entities.find((e) => e.id === 'divert-cargo-1');
    expect(divert?.motion).toBeTruthy();
    const surfaces = beltSurfaces(scene.entities);
    for (const point of divert!.motion!.points) {
      const covered = surfaces.some(
        (b) => point[0] >= b.x0 - 1e-6 && point[0] <= b.x1 + 1e-6 && point[2] >= b.z0 - 1e-6 && point[2] <= b.z1 + 1e-6,
      );
      expect(covered, `divert 点 ${point.join(',')} 没有输送面`).toBe(true);
    }
  });
});

describe('90° 转角', () => {
  it('转角模块已退役，所有 90° 拐都并进折线输送线（自带倒圆），且每个拐角下方仍有输送面托着', () => {
    const scene = buildCenterScene({ externalLanes: 2 });
    // 独立转角模块（config.corner === true）已全部并入折线皮带，不再单独存在。
    const corners = scene.entities.filter((e) => (e.config as { corner?: boolean })?.corner === true);
    expect(corners.length).toBe(0);

    // 主环线 / 分流支线 / 两条立库的"打包出料带 + 载货站台"的全部拐角，
    // 逐个验证下方有输送面托着。
    const surfaces = beltSurfaces(scene.entities);
    const turnPoints: [number, number][] = [
      [-8, 0], [19, 0], [19, -6], [-16, -6], [-16, 3], [-12, 3], [-12, 0], // 主环线
      [1, 0], [10, 0], [10, -2.6], [1, -2.6], // 分流支线
      [6, 1.4], [8.5, 1.4], [8.5, 3.6], [4.7, 3.6], [4, 5.0], [8, 5.0], // 立库 A：出料带 + L 形站台
      [14, 1.4], [16.5, 1.4], [16.5, 3.6], [12.7, 3.6], [12, 5.0], [16, 5.0], // 立库 B：出料带 + L 形站台
    ];
    for (const [cx, cz] of turnPoints) {
      const ok = surfaces.some((b) => cx >= b.x0 - 1e-6 && cx <= b.x1 + 1e-6 && cz >= b.z0 - 1e-6 && cz <= b.z1 + 1e-6);
      expect(ok, `拐角 (${cx},${cz}) 下方缺输送面`).toBe(true);
    }
  });
});

describe('同线货物不互相超车（也不堆叠）', () => {
  const scene = buildCenterScene({ maxWip: 10, produceInterval: 6, externalLanes: 4 });
  const speedOf = (id: string): number => scene.entities.find((e) => e.id === id)!.motion!.speed;

  it('主环线上的小货物由发生器产出，速度只有一个来源', () => {
    const source = scene.entities.find((e) => e.kind === 'source')!;
    expect(source.config?.goodsSpeed).toBe(1.3);
    // 场景里不再预置 parcel-*：小货物全部由 source-1 按同一速度生成
    expect(scene.entities.filter((e) => e.id.startsWith('parcel-')).length).toBe(0);
  });

  it('分流物料与主线同速（共享 x5..8, z0 段皮带，否则该段会互相超车）', () => {
    const source = scene.entities.find((e) => e.kind === 'source')!;
    expect(speedOf('divert-cargo-1')).toBe(source.config?.goodsSpeed);
  });

  it('托盘不走皮带，由打包站产出后交给货架行为摆位', () => {
    // 托盘没有 motion 路径：出生后位姿全程归 asrs-cycle（否则内核每步会把它拉回路径终点）。
    const pack = scene.entities.find((e) => e.kind === 'pack')!;
    expect(pack.motion).toBeUndefined();
    expect(Array.isArray(pack.config?.palletPath)).toBe(true);
  });

  it('主环线上的小货物同速前进，最小间距不会趋近 0（不超车、不堆叠）', () => {
    const host = new PluginHost();
    host.install(logisticsPlugin);
    const world = new TwinWorld(
      buildCenterScene({ maxWip: 10, produceInterval: 6, externalLanes: 4 }),
      { seed: 20240906, maxStepsPerAdvance: 600, behaviors: host.behaviors },
    );
    let minDist = Infinity;
    for (let s = 0; s < 60 * 120; s += 1) {
      world.step(1 / 60);
      const ps: TwinVector3[] = world
        .listEntities()
        .filter(
          (entity) =>
            entity.kind === 'parcel' &&
            String(entity.config?.source ?? '') !== '' &&
            // 被打包站扣在缓存位上的货不算"在线上跑"，它们本来就挨着站台排
            entity.attrs.heldBy === undefined,
        )
        .map((entity) => entity.transform.position);
      for (let a = 0; a < ps.length; a += 1) {
        for (let b = a + 1; b < ps.length; b += 1) {
          const d = Math.hypot(ps[a]![0] - ps[b]![0], ps[a]![1] - ps[b]![1], ps[a]![2] - ps[b]![2]);
          if (d < minDist) minDist = d;
        }
      }
    }
    // 同速前进 + 固定产出间隔 → 间距恒定（产出间隔 6s × 1.3 m/s ≈ 7.8m）；
    // 只要有一处速度不同，快箱就会追尾，最小间距趋近 0。
    expect(minDist).toBeGreaterThan(3);
  });
});
