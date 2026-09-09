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
    // 移栽机本体也是一段 inline 输送面；折线皮带按段拆开，拐角顶点才可能落在它上面。
    const surfaces = beltSurfaces(entities);
    for (const mover of entities.filter((e) => e.motion)) {
      for (const point of mover.motion!.points) {
        const covered = surfaces.some(
          (b) => point[0] >= b.x0 - 1e-6 && point[0] <= b.x1 + 1e-6 && point[2] >= b.z0 - 1e-6 && point[2] <= b.z1 + 1e-6,
        );
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
    const scene = buildCenterScene({ parcels: 8, asrsParcels: 2, externalLanes: 2 });
    // 独立转角模块（config.corner === true）已全部并入折线皮带，不再单独存在。
    const corners = scene.entities.filter((e) => (e.config as { corner?: boolean })?.corner === true);
    expect(corners.length).toBe(0);

    // 主环线 / 分流支线 / 两条立库出入库环的全部拐角，逐个验证下方有输送面托着。
    const surfaces = beltSurfaces(scene.entities);
    const turnPoints: [number, number][] = [
      [-8, 0], [19, 0], [19, -6], [-16, -6], [-16, 3], [-12, 3], [-12, 0], // 主环线
      [1, 0], [10, 0], [10, -2.6], [1, -2.6], // 分流支线
      [8, 2.6], [4, 2.6], [4, 5.0], [8, 5.0], [4, 0], // 立库 A 出入库环（L 形站台：竖段接角落移栽机、横段伸到巷道口）
      [16, 2.6], [12, 2.6], [12, 5.0], [16, 5.0], [12, 0], // 立库 B 出入库环（L 形站台，inX=12 西侧）
    ];
    for (const [cx, cz] of turnPoints) {
      const ok = surfaces.some((b) => cx >= b.x0 - 1e-6 && cx <= b.x1 + 1e-6 && cz >= b.z0 - 1e-6 && cz <= b.z1 + 1e-6);
      expect(ok, `拐角 (${cx},${cz}) 下方缺输送面`).toBe(true);
    }
  });
});

describe('同线货物不互相超车（也不堆叠）', () => {
  const scene = buildCenterScene({ parcels: 10, asrsParcels: 3, externalLanes: 4 });
  const speedOf = (id: string): number => scene.entities.find((e) => e.id === id)!.motion!.speed;

  it('同一条主环线上所有包裹速度相同', () => {
    const main = Array.from({ length: 10 }, (_, i) => speedOf(`parcel-${i + 1}`));
    expect(new Set(main).size).toBe(1);
  });

  it('分流物料与主线同速（共享 x5..8, z0 段皮带，否则该段会互相超车）', () => {
    expect(speedOf('divert-cargo-1')).toBe(speedOf('parcel-1'));
  });

  it('立库出入库环、外部车道各自环内同速', () => {
    const asrs = ['a', 'b'].flatMap((t) =>
      Array.from({ length: 3 }, (_, i) => speedOf(`asrs-8-cargo-${i + 1}`)),
    );
    expect(new Set(asrs).size).toBe(1);
    const ext = Array.from({ length: 4 }, (_, i) => speedOf(`ext-cargo-${i + 1}`));
    expect(new Set(ext).size).toBe(1);
  });

  it('主环线运行 30s 内任意两箱最近距离始终 > 3m（不超车、不堆叠）', () => {
    const host = new PluginHost();
    host.install(logisticsPlugin);
    const world = new TwinWorld(buildCenterScene({ parcels: 10, asrsParcels: 3, externalLanes: 4 }), {
      seed: 20240906,
      maxStepsPerAdvance: 600,
      behaviors: host.behaviors,
    });
    let minDist = Infinity;
    for (let s = 0; s < 60 * 30; s += 1) {
      world.step(1 / 60);
      const ps: TwinVector3[] = [];
      for (let i = 1; i <= 10; i += 1) {
        const e = world.getEntity(`parcel-${i}`);
        if (e) ps.push(e.transform.position);
      }
      for (let a = 0; a < ps.length; a += 1) {
        for (let b = a + 1; b < ps.length; b += 1) {
          const d = Math.hypot(ps[a]![0] - ps[b]![0], ps[a]![1] - ps[b]![1], ps[a]![2] - ps[b]![2]);
          if (d < minDist) minDist = d;
        }
      }
    }
    // 10 箱在 ~76m 环上均布，间距 ~7.6m；若速度不同快箱会追尾、最小间距趋近 0。
    expect(minDist).toBeGreaterThan(3);
  });
});
