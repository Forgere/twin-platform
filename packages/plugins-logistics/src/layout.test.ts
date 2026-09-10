import { describe, expect, it } from 'bun:test';
import type { TwinEntity } from '@twin-platform/scene-schema';
import { buildCenterScene, buildFactoryScene, buildLineScene } from './index';

/**
 * 布局回归测试：把"输送线怎么摆"从口头约定固化成断言。
 *
 * 背景：center 场景以前靠手写坐标铺皮带，结果是主线每个转角都叠 0.7m、
 * 立库接口转角直接压在主线皮带上、分流支线还压着拒收货架——渲染出来就是
 * 同高度叠面 z-fighting，也就是"输送线有重叠"。
 *
 * 这里定两条铁律并断言：
 * 1. 任何两个"占地面"实体不得叠出面积（贴边相接是允许的）；
 * 2. 任何物料路径的拐点都必须落在某段皮带/转角/移栽机的占地上——货物不许脱线。
 *
 * 谁再改坐标改漏了，测试会直接报出"哪两个实体、在哪叠了多少"，不用靠眼睛找。
 */

/** 只查占地面：会动的（物料/堆垛机/货叉/托举座）和跨在皮带上方的拱门（检测站）不算。 */
const FOOTPRINT_KINDS = new Set(['transport', 'transfer', 'buffer', 'asrs']);

/** 允许贴边相接，只有真叠出面积才算数（浮点噪声级别忽略）。 */
const EPS = 1e-6;

interface Footprint {
  id: string;
  /** 所属实体：折线输送线会拆成多段，同实体的段之间不算重叠。 */
  owner: string;
  kind: string;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

function footprints(entities: readonly TwinEntity[]): Footprint[] {
  const out: Footprint[] = [];
  for (const entity of entities) {
    if (!FOOTPRINT_KINDS.has(entity.kind)) continue;
    const size = entity.visual?.size ?? [1, 1, 1];
    const px = entity.transform.position[0];
    const pz = entity.transform.position[2];
    const path = entity.config?.beltPath;
    // 折线输送线（一条线自带 90° 拐）：拆成若干段矩形再查。
    // 只在**宽度方向**膨胀，长度方向不膨胀——否则端点会把相邻模块的地盘吃掉，误报重叠。
    if (Array.isArray(path) && path.length >= 2) {
      const beltWidth =
        typeof entity.config?.beltWidth === 'number' ? (entity.config.beltWidth as number) : size[0];
      for (let i = 0; i < path.length - 1; i += 1) {
        const a = path[i] as [number, number];
        const b = path[i + 1] as [number, number];
        if (!Array.isArray(a) || !Array.isArray(b)) continue;
        const ax = px + a[0];
        const az = pz + a[1];
        const bx = px + b[0];
        const bz = pz + b[1];
        const alongX = Math.abs(bx - ax) >= Math.abs(bz - az);
        const padX = alongX ? 0 : beltWidth / 2;
        const padZ = alongX ? beltWidth / 2 : 0;
        out.push({
          id: `${entity.id}#${i}`,
          owner: entity.id,
          kind: entity.kind,
          x0: Math.min(ax, bx) - padX,
          x1: Math.max(ax, bx) + padX,
          z0: Math.min(az, bz) - padZ,
          z1: Math.max(az, bz) + padZ,
        });
      }
      continue;
    }
    out.push({
      id: entity.id,
      owner: entity.id,
      kind: entity.kind,
      x0: px - size[0] / 2,
      x1: px + size[0] / 2,
      z0: pz - size[2] / 2,
      z1: pz + size[2] / 2,
    });
  }
  return out;
}

describe('center 场景布局', () => {
  const scene = buildCenterScene();
  const boxes = footprints(scene.entities);

  it('输送线与设备不互相叠面（不再 z-fighting）', () => {
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.owner === b.owner) continue; // 同一条折线自己的段之间，拐角处必然相接
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
        const oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
        if (ox > EPS && oz > EPS) {
          overlaps.push(
            `${a.id}(${a.kind}) × ${b.id}(${b.kind})：X 叠 ${ox.toFixed(3)}m，Z 叠 ${oz.toFixed(3)}m`,
          );
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it('物料路径的拐点都踩在皮带/转角/移栽机上（不脱线）', () => {
    const unsupported: string[] = [];
    for (const entity of scene.entities) {
      const points = entity.motion?.points;
      if (!points) continue;
      for (const point of points) {
        const [px, , pz] = point;
        // 允许落在边界上，故用 <= / >= 而不是严格小于
        const ok = boxes.some((b) => px >= b.x0 - EPS && px <= b.x1 + EPS && pz >= b.z0 - EPS && pz <= b.z1 + EPS);
        if (!ok) unsupported.push(`${entity.id} 的拐点 (${px.toFixed(2)}, ${pz.toFixed(2)}) 没有皮带托着`);
      }
    }
    expect(unsupported).toEqual([]);
  });

  it('每条直行皮带都显式声明了走向（不许靠尺寸猜）', () => {
    // 背景：渲染层原来用 `sizeZ > sizeX` 猜长边落在哪个轴。短接驳段
    // （0.9m 长 × 1.4m 宽）会被判成"沿 Z 铺"，整段转 90°——宽窄互换、
    // 滚筒改推 ±Z、箭头也横着流。所以走向必须由 config.beltAxis 声明。
    const scenes = [buildLineScene(), buildFactoryScene(), buildCenterScene()];
    const missing: string[] = [];
    for (const scene of scenes) {
      for (const entity of scene.entities as TwinEntity[]) {
        if (entity.kind !== 'transport') continue;
        if (Array.isArray(entity.config?.beltPath)) continue; // 折线自带走向
        const axis = entity.config?.beltAxis;
        if (axis !== 'x' && axis !== 'z') {
          const size = entity.visual?.size ?? [0, 0, 0];
          missing.push(
            `${entity.id} 未声明 beltAxis（size=[${size[0]?.toFixed(2)}, ${size[2]?.toFixed(2)}]，` +
              `渲染层会猜成 ${(size[2] ?? 0) > (size[0] ?? 0) ? "'z'" : "'x'"}）`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('卡车按转向后的真实占位不压任何输送线/设备', () => {
    // 背景：卡车 6m 长 × 2.2m 宽，**起步朝向决定长边落在哪个轴**，所以占位必须
    // 按路线第一段的方向旋转后再算。而 `FOOTPRINT_KINDS` 不含 truck，这块一直是
    // 盲区——实测卡车停在 z=1.5 时会压住主线皮带 0.3m、压住出库缓存台 0.5m，
    // 却没人报错。这里把这个盲区补上。
    const trucks = scene.entities.filter((entity) => entity.kind === 'truck');
    expect(trucks.length).toBe(2);
    const clashes: string[] = [];
    for (const t of trucks) {
      const size = t.visual?.size ?? [0, 0, 0];
      const [px, , pz] = t.transform.position;
      const route = (t.config?.route as number[][]) ?? [];
      const dx = (route[1]?.[0] ?? px) - px;
      const dz = (route[1]?.[2] ?? pz) - pz;
      const alongX = Math.abs(dx) >= Math.abs(dz);
      const halfLen = size[2] / 2;
      const halfWid = size[0] / 2;
      const x0 = alongX ? px - halfLen : px - halfWid;
      const x1 = alongX ? px + halfLen : px + halfWid;
      const z0 = alongX ? pz - halfWid : pz - halfLen;
      const z1 = alongX ? pz + halfWid : pz + halfLen;
      for (const b of boxes) {
        const ox = Math.min(x1, b.x1) - Math.max(x0, b.x0);
        const oz = Math.min(z1, b.z1) - Math.max(z0, b.z0);
        if (ox > EPS && oz > EPS) {
          clashes.push(`${t.id} 压 ${b.id}(${b.kind})：X 叠 ${ox.toFixed(3)}m，Z 叠 ${oz.toFixed(3)}m`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it('堆垛机载货出巷：卸货点在货架北端之外，且落在出库缓存台上', () => {
    // 回归：出库口原来和入库队列挤在巷道同一侧，出库路径必然穿过入库队列，
    // 于是 `releaseCarriedOut` 只能退化成"托盘从巷道口瞬移到缓存台"。
    // 现在靠 `outfeedTravelZ` 让门架真的把货载出货架北端，这里把约束钉死。
    const racks = scene.entities.filter((entity) => entity.kind === 'asrs');
    const rackBack = Math.max(
      ...racks.map((r) => r.transform.position[2] + (r.visual?.size?.[2] ?? 0) / 2),
    );
    const cranes = scene.entities.filter((entity) => entity.kind === 'stacker');
    const docks = scene.entities.filter((entity) => entity.id.startsWith('dock-'));
    expect(cranes.length).toBe(2);
    expect(docks.length).toBe(2);
    for (const crane of cranes) {
      const travelZ = crane.config?.outfeedTravelZ;
      expect(typeof travelZ, `${crane.id} 没声明 outfeedTravelZ，出库会退化成瞬移`).toBe('number');
      expect(travelZ as number, `${crane.id} 卸货点没走出货架北端（rackBack=${rackBack}）`).toBeGreaterThan(rackBack);

      // 卸货点必须落在某块出库缓存台上，否则托盘卸下来是悬空的
      const outX = crane.config?.outfeedX as number;
      const onDock = docks.some((dock) => {
        const size = dock.visual?.size ?? [0, 0, 0];
        const px = dock.transform.position[0];
        const pz = dock.transform.position[2];
        return (
          outX >= px - size[0] / 2 - EPS &&
          outX <= px + size[0] / 2 + EPS &&
          (travelZ as number) >= pz - size[2] / 2 - EPS &&
          (travelZ as number) <= pz + size[2] / 2 + EPS
        );
      });
      expect(onDock, `${crane.id} 卸货点 (${outX}, ${travelZ}) 不在任何出库缓存台上`).toBe(true);
    }
  });
});

/**
 * 闭环产线的布局铁律：小货物路径、两条打包出料带、两段载货站台各自首尾相接，
 * 但**不许叠面**；每条路径的每个拐点都必须踩在皮带上。
 */
describe('闭环产线布局（center 场景）', () => {
  const scene = buildCenterScene({ maxWip: 10, produceInterval: 6, externalLanes: 4 });
  const boxes = footprints(scene.entities);

  it('小货物路径的每个拐点都踩在皮带上（不脱线）', () => {
    const source = scene.entities.find((entity) => entity.kind === 'source')!;
    const path = source.config?.goodsPath as [number, number, number][];
    expect(path.length).toBeGreaterThan(2);
    // 首尾闭合，否则 loop:'repeat' 会让小货物瞬移回起点
    expect(path[0]).toEqual(path[path.length - 1]);
    for (const point of path) {
      const ok = boxes.some((b) => point[0] >= b.x0 - EPS && point[0] <= b.x1 + EPS && point[2] >= b.z0 - EPS && point[2] <= b.z1 + EPS);
      expect(ok, `小货物拐点 (${point[0]}, ${point[2]}) 下方没有皮带`).toBe(true);
    }
  });

  it('两条打包出料带把托盘送进各自巷道的队列尾，端点都有皮带托着', () => {
    const packs = scene.entities.filter((entity) => entity.kind === 'pack');
    expect(packs.length).toBe(2);
    for (const pack of packs) {
      const path = pack.config?.palletPath as [number, number, number][];
      expect(path.length).toBe(4);
      for (const point of path) {
        const ok = boxes.some((b) => point[0] >= b.x0 - EPS && point[0] <= b.x1 + EPS && point[2] >= b.z0 - EPS && point[2] <= b.z1 + EPS);
        expect(ok, `${pack.id} 托盘路径端点 (${point[0]}, ${point[2]}) 下方没有皮带`).toBe(true);
      }
    }
  });

  it('出库缓存台摆在皮带走廊里，不压任何输送线', () => {
    const docks = scene.entities.filter((entity) => entity.id.startsWith('dock-'));
    expect(docks.length).toBe(2);
    for (const dock of docks) {
      const size = dock.visual?.size ?? [0, 0, 0];
      const px = dock.transform.position[0];
      const pz = dock.transform.position[2];
      const clash = boxes.filter((b) => b.owner !== dock.id).some((b) => {
        const ox = Math.min(px + size[0] / 2, b.x1) - Math.max(px - size[0] / 2, b.x0);
        const oz = Math.min(pz + size[2] / 2, b.z1) - Math.max(pz - size[2] / 2, b.z0);
        return ox > EPS && oz > EPS;
      });
      expect(clash, `${dock.id} 和别的皮带叠面了`).toBe(false);
    }
  });
});
