import type { ConfigValue, SceneTemplateDescriptor } from '@twin-platform/plugin-sdk';
import type { TwinEntity, TwinScene, TwinVector3 } from '@twin-platform/scene-schema';
import {
  asrsRack,
  bufferRack,
  conveyorPolyline,
  conveyorSegment,
  goodsSource,
  inspectionStation,
  liftTransfer,
  liftTransferCassette,
  packingStation,
  parcel,
  stackerCarriage,
  stackerCrane,
  stackerFork,
  truck,
} from './devices';

export interface LineTemplateParams {
  /** 同时在线包裹数，默认 5。 */
  parcels?: number;
  /** 产线中心线长度（米），默认 20。 */
  length?: number;
  /** 包裹基础速度（m/s），默认 1.6。 */
  baseSpeed?: number;
}

/**
 * "一段物流输送线"场景模板：把可复用的产线片段参数化成实体列表。
 *
 * 由首尾闭合的环形输送线、检测站、缓存货架与若干循环包裹组成。
 * 同一条连续皮带上的所有包裹**速度相同**（真实皮带物理）；包裹之间靠
 * `splitClosedLoop` 把起步点错开，从而既保持间距、不会堆在一起，又不会
 * 出现"快的从慢的身上穿过去"的超车现象。
 */
export const lineTemplate: SceneTemplateDescriptor<LineTemplateParams> = {
  id: 'logistics-line',
  label: '物流输送线',
  build(params: LineTemplateParams = {}) {
    const count = params.parcels ?? 5;
    const length = params.length ?? 20;
    const base = params.baseSpeed ?? 1.6;
    const w = length / 2;
    // 闭环矩形：上行（z=0）与下行（z=DEPTH）是两条平行皮带，去/回分走两侧，
    // 因此即便同速也不会迎面叠在一起。
    const DEPTH = 1.4;
    const path: TwinVector3[] = [
      [-w, 1.15, 0],
      [w, 1.15, 0],
      [w, 1.15, DEPTH],
      [-w, 1.15, DEPTH],
    ];

    const entities: TwinEntity[] = [
      conveyorSegment('belt-top', [0, 0.6, 0], { label: '输送线上行', size: [length, 0.6, 1.4], axis: 'x' }),
      conveyorSegment('belt-bottom', [0, 0.6, DEPTH], { label: '输送线下行', size: [length, 0.6, 1.4], axis: 'x' }),
      conveyorSegment('belt-left', [-w, 0.6, DEPTH / 2], { label: '输送线左转', size: [1.4, 0.6, DEPTH], axis: 'z' }),
      conveyorSegment('belt-right', [w, 0.6, DEPTH / 2], { label: '输送线右转', size: [1.4, 0.6, DEPTH], axis: 'z' }),
      inspectionStation('scan-01', [0, 0.9, 0], 1.6),
      bufferRack('buffer-01', [length / 2 + 1.5, 1, 0]),
    ];

    for (let index = 0; index < count; index += 1) {
      entities.push(
        parcel(`parcel-${index + 1}`, splitClosedLoop(path, index / count), base, { label: `在制物料 ${index + 1}` }),
      );
    }
    return entities;
  },
};

/** 把模板产出的实体组装成可直接喂给 `TwinWorld` 的场景。 */
export function buildLineScene(params: LineTemplateParams = {}): TwinScene {
  return {
    version: 1,
    id: 'logistics-line',
    name: '物流输送线',
    entities: lineTemplate.build(params),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 物流工厂场景模板（参考 VividFactory 范例，移植到本架构）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 工厂马卡龙配色，直接对齐 VividFactory 范例的 PALETTE ——
 * 后续 Studio 重皮肤（2D HUD / 3D 场景）也复用同一组色值，保证整体一致。
 */
const PASTEL = {
  conveyor: '#8BD3C7',
  inspection: '#9FD8F0',
  reject: '#F7E3A4',
  pack: '#F4A261',
  external: '#C4B5E0',
  cargo: ['#FFB7B2', '#B5EAD7', '#C7CEEA', '#FFDAC1', '#FDFD96'],
} as const;

export interface FactoryTemplateParams {
  /** 主环线在制物料数，默认 8。 */
  parcels?: number;
  /** 外部数字孪生车道数，默认 4。 */
  externalLanes?: number;
  /** 整体缩放，默认 1。 */
  scale?: number;
}

/** 把实体的视觉颜色覆盖成马卡龙色（其余视觉属性保持不变）。 */
const withColor = (entity: TwinEntity, color: string): TwinEntity => ({
  ...entity,
  visual: { ...(entity.visual ?? { kind: 'box' as const }), color },
});

/**
 * "物流工厂"场景模板：一段闭环主输送线串起入料、质检、分拣、包装，
 * 两侧挂拒收货架，右侧接 N 条外部数字孪生车道。
 *
 * 复用 line 模板同款的 `logistics-flow` 行为 —— 包裹按 `motion.loop:'repeat'`
 * 绕主环线循环，每圈触发一次 `parcel:exit`+`parcel:enter`；检测站按覆盖区发
 * `entity:status` 忙闲。即插即用，不改内核。
 */
export const factoryTemplate: SceneTemplateDescriptor<FactoryTemplateParams> = {
  id: 'logistics-factory',
  label: '物流工厂',
  build(params: FactoryTemplateParams = {}) {
    const count = params.parcels ?? 8;
    const lanes = params.externalLanes ?? 4;
    const s = params.scale ?? 1;
    const x = (value: number): number => value * s;
    const yLine = 1.15;

    const entities: TwinEntity[] = [
      conveyorSegment('infeed-1', [x(-14), 0.6, -2], { label: '入料线 1', color: PASTEL.conveyor, axis: 'x' }),
      conveyorSegment('infeed-2', [x(-14), 0.6, 2], { label: '入料线 2', color: PASTEL.conveyor, axis: 'x' }),
      conveyorSegment('belt-main-1', [x(-9), 0.6, 0], { label: '主输送段 1', color: PASTEL.conveyor, axis: 'x' }),
      conveyorSegment('belt-main-2', [x(-2), 0.6, 0], { label: '主输送段 2', color: PASTEL.conveyor, axis: 'x' }),
      conveyorSegment('belt-main-3', [x(9), 0.6, 0], { label: '主输送段 3', color: PASTEL.conveyor, axis: 'x' }),
      conveyorSegment('outfeed-1', [x(14), 0.6, 0], { label: '出料线', color: PASTEL.conveyor, axis: 'x' }),
      withColor(inspectionStation('scan-01', [x(-5), 0.9, 0], 1.6), PASTEL.inspection),
      withColor(inspectionStation('scan-02', [x(5), 0.9, 0], 1.6), PASTEL.inspection),
      withColor(bufferRack('reject-rack-1', [x(-5), 1, 3]), PASTEL.reject),
      withColor(bufferRack('reject-rack-2', [x(5), 1, 3]), PASTEL.reject),
      conveyorSegment('sorter-1', [x(1.5), 0.6, 0], { label: '分拣台', color: PASTEL.conveyor, axis: 'x' }),
      { ...withColor(bufferRack('pack-01', [x(12), 1, 0]), PASTEL.pack), capabilities: ['store', 'buffer', 'pack'] },
      // 外部车道沿 Z 铺设（长边给 Z），间距 4 > 长度 3.2，彼此不重叠。
      ...Array.from({ length: lanes }, (_, i) =>
        conveyorSegment(`ext-${i + 1}`, [x(16), 0.6, -6 + i * 4], {
          label: `外部车道 ${i + 1}`,
          color: PASTEL.external,
          size: [1.4, 0.6, 3.2],
          axis: 'z',
        }),
      ),
    ];

    // 包装线（单向、不回流）：左入料 → 质检 → 分拣 → 到达 pack-01（等待/装盒处）停下。
    // 之前是闭环矩形（loop:'repeat'），物料会一圈圈绕回 pack-01——即用户看到的
    // "小盒子在等待处被装盒、却又绕回去"。改成开放路径 + loop:'none'：物料只走一趟、
    // 到 pack-01 即停（堆积成「大箱」），不再回流。同线仍用 splitOpenPath 错开起步点。
    const mainPath: TwinVector3[] = [
      [x(-14), yLine, 0],
      [x(12), yLine, 0], // 终点落在 pack-01：物料到此停下、堆积成「大箱」，不再绕回
    ];
    const MAIN_SPEED = 1.4;
    for (let i = 0; i < count; i += 1) {
      entities.push(
        parcel(`parcel-${i + 1}`, splitOpenPath(mainPath, i / count), MAIN_SPEED, {
          label: `在制物料 ${i + 1}`,
          color: PASTEL.cargo[i % PASTEL.cargo.length],
          loop: 'none',
        }),
      );
    }
    // 外部车道各自的短往返路径（沿 z 在车道内上下往复）。
    for (let i = 0; i < lanes; i += 1) {
      const z = -6 + i * 4;
      entities.push(
        parcel(
          `ext-cargo-${i + 1}`,
          [
            [x(16), yLine, z - 1.4],
            [x(16), yLine, z + 1.4],
          ],
          1.1 + i * 0.1,
          { label: `外部物料 ${i + 1}`, color: PASTEL.cargo[(i + 2) % PASTEL.cargo.length] },
        ),
      );
    }

    return entities;
  },
};

/** 把工厂模板产出的实体组装成可直接喂给 `TwinWorld` 的场景。 */
export function buildFactoryScene(params: FactoryTemplateParams = {}): TwinScene {
  return {
    version: 1,
    id: 'logistics-factory',
    name: '物流工厂',
    entities: factoryTemplate.build(params),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 智能物流中心（含立体仓库与堆垛机）
// ─────────────────────────────────────────────────────────────────────────

/** 输送线实体高度 0.6 → 台面中心 +0.25、半厚 0.05，货物半高 0.3，故货物中心 1.2。 */
const DECK_Y = 1.2;
/** 输送线实体高度。 */
const BELT_Y = 0.6;

/**
 * 各闭环输送线（皮带）的统一步速。
 *
 * 真实皮带只有"一个速度"——同一条线上所有货物靠同一速度前进，靠起步位错开
 * 来维持间距，而不是各自不同速度。内核 `world.ts` 每个包裹按自己的
 * `motion.speed * dt` 独立推进，**没有任何间距/碰撞逻辑**，所以一旦给同线包裹
 * 赋不同速度，快的就会从慢的身上穿过去（"超车"）。
 *
 * 因此这里强制：**同一条物理皮带上的所有包裹速度相同**。
 * - 主环线与分流支线在 `x∈[5,8], z=0` 段共用同一段皮带，所以分流物料速度必须等于主线；
 * - 立库出入库环、外部车道各自独立皮带，可独立定速，但环内必须同速。
 */
const LINE_SPEED = {
  /** 主环线步速（m/s）。 */
  main: 1.3,
  /** 分流支线：与主环线共用 x5..8 段皮带，必须同速。 */
  divert: 1.3,
  /** 外部数字孪生车道步速。 */
  ext: 1.0,
} as const;

const CENTER = {
  belt: '#8BD3C7',
  sorter: '#8BD3C7',
  inspect: '#9FD8F0',
  reject: '#F7E3A4',
  pack: '#F4A261',
  external: '#C4B5E0',
  rack: '#B5EAD7',
  stacker: '#C4B5E0',
  cargo: ['#FFB7B2', '#B5EAD7', '#C7CEEA', '#FFDAC1', '#FDFD96'],
} as const;

const dist = (a: TwinVector3, b: TwinVector3): number =>
  Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 + (b[2] - a[2]) ** 2);

/**
 * 把闭合折线在指定弧长比例处"剪开"重新闭合。
 *
 * 两个用途，都是为了解决 `loop: 'repeat'` 的坑：
 * 1. 路径首尾必须是同一点，否则物料每圈结束会从终点瞬移回起点；
 * 2. 内核没有"初始弧长"字段，所有物料都从 path[0] 起步会叠在一起，
 *    所以给每箱货一条起点错开的同形状路径。
 *
 * 剪开点落在直段中间（不在拐角），因此首尾接缝处切线连续，看不出接缝。
 */
export function splitClosedLoop(corners: TwinVector3[], fraction: number): TwinVector3[] {
  const n = corners.length;
  if (n < 2) return [...corners, ...corners];

  let total = 0;
  for (let i = 0; i < n; i += 1) total += dist(corners[i]!, corners[(i + 1) % n]!);

  let target = (((fraction % 1) + 1) % 1) * total;
  let index = 0;
  let ratio = 0;
  for (let i = 0; i < n; i += 1) {
    const segment = dist(corners[i]!, corners[(i + 1) % n]!);
    if (target <= segment || i === n - 1) {
      index = i;
      ratio = segment > 1e-9 ? Math.min(1, target / segment) : 0;
      break;
    }
    target -= segment;
  }

  const a = corners[index]!;
  const b = corners[(index + 1) % n]!;
  const start: TwinVector3 = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, a[2] + (b[2] - a[2]) * ratio];

  const rest: TwinVector3[] = [];
  for (let k = index + 1; k < n; k += 1) rest.push(corners[k]!);
  for (let k = 0; k <= index; k += 1) rest.push(corners[k]!);
  return [start, ...rest, start];
}

/**
 * 开放路径的起步点错开（不闭合、不回绕）。
 *
 * 与 `splitClosedLoop` 的区别：返回的 path 首尾**不重合**，且沿行进方向走到终点即止，
 * 配合 `parcel(..., { loop: 'none' })` 使用——物料从错开的位置进入、单向走到终点停下，
 * 不会像闭环那样绕回起点（即用户看到的"小盒子回去"）。
 */
export function splitOpenPath(points: TwinVector3[], fraction: number): TwinVector3[] {
  const n = points.length;
  if (n < 2) return [...points];
  let total = 0;
  for (let i = 0; i < n - 1; i += 1) total += dist(points[i]!, points[i + 1]!);
  let target = (((fraction % 1) + 1) % 1) * total;
  let index = 0;
  let ratio = 0;
  for (let i = 0; i < n - 1; i += 1) {
    const segment = dist(points[i]!, points[i + 1]!);
    if (target <= segment || i === n - 2) {
      index = i;
      ratio = segment > 1e-9 ? Math.min(1, target / segment) : 0;
      break;
    }
    target -= segment;
  }
  const a = points[index]!;
  const b = points[index + 1]!;
  const start: TwinVector3 = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio, a[2] + (b[2] - a[2]) * ratio];
  return [start, ...points.slice(index + 1)];
}

export interface CenterTemplateParams {
  /** 线上一共允许多少个小货物同时在制（发生器背压），默认 10。 */
  maxWip?: number;
  /** 小货物产出间隔（秒），默认 6。 */
  produceInterval?: number;
  /** 立库库存高水位：到线就转去出库，默认 8。 */
  highWater?: number;
  /** 外部数字孪生车道数，默认 4。 */
  externalLanes?: number;
  /** 堆垛机巷道数（1 或 2），默认 2。 */
  aisles?: number;
  /** 整体缩放，默认 1。 */
  scale?: number;
}

/**
 * "智能物流中心"场景模板：一条闭合的环形输送线串起入料、质检、分拣，
 * 背后接一座双巷道立体仓库（四条高层货架 + 两台堆垛机），右侧接外部车道。
 *
 * 与工厂模板最大的不同是**路由**：主环线的每一段折线下面都真的铺了输送线，
 * 因此物料不会悬空跑；所有物料路径都是首尾闭合的环，不会瞬移回起点。
 * 立库部分由 `asrs-cycle` 行为驱动，堆垛机会自己在巷道里走位、起升、伸缩货叉。
 */
export const centerTemplate: SceneTemplateDescriptor<CenterTemplateParams> = {
  id: 'logistics-center',
  label: '智能物流中心（含立库）',
  build(params: CenterTemplateParams = {}) {
    const maxWip = params.maxWip ?? 10;
    const produceInterval = params.produceInterval ?? 6;
    const highWater = params.highWater ?? 8;
    const lanes = params.externalLanes ?? 4;
    const aisles = Math.min(2, Math.max(1, Math.round(params.aisles ?? 2)));
    const s = params.scale ?? 1;
    const x = (value: number): number => value * s;
    const z = (value: number): number => value * s;

    const entities: TwinEntity[] = [];

    /**
     * 沿 X 铺一段输送线（长边给 X）。
     * `dir` 是箭头流动方向：`+1` 顺着 +X（local +X = 世界 +X），`-1` 逆行。
     */
    const beltX = (
      id: string,
      x0: number,
      x1: number,
      zAt: number,
      label: string,
      color = CENTER.belt,
      dir: 1 | -1 = 1,
    ): void => {
      entities.push(
        conveyorSegment(id, [x((x0 + x1) / 2), BELT_Y, z(zAt)], {
          label,
          color,
          size: [x(Math.abs(x1 - x0)), 0.6, 1.4],
          axis: 'x',
          beltDirection: dir,
        }),
      );
    };
    /**
     * 沿 Z 铺一段输送线（长边给 Z）。
     * 沿 Z 铺设时模型会转 90°，local +X = 世界 **-Z**：
     * 所以"物料往 -Z 走"填 `+1`，"往 +Z 走"填 `-1`。
     */
    const beltZ = (
      id: string,
      xAt: number,
      z0: number,
      z1: number,
      label: string,
      color = CENTER.belt,
      dir: 1 | -1 = 1,
    ): void => {
      entities.push(
        conveyorSegment(id, [x(xAt), BELT_Y, z((z0 + z1) / 2)], {
          label,
          color,
          size: [1.4, 0.6, z(Math.abs(z1 - z0))],
          axis: 'z',
          beltDirection: dir,
        }),
      );
    };

    // ── 布局铁律（之前没章法、皮带互相叠面 z-fighting，就是缺这三条）──
    // 1) 模块优先占位：转角模块 1.4 宽（半宽 HALF_C）、顶升移栽机 1.6 长（半长 HALF_T）；
    // 2) 直行皮带两端一律让到模块边，**绝不铺进模块占地**；
    // 3) 转弯用 90° 转角模块；**只有不转弯的垂直移动**才用顶升移栽机，并把主线断开。
    const HALF_C = 0.7;
    const HALF_T = 0.8;
    // 立库巷道：环线宽 4.0（巷道 → 载货站台），所以相邻巷道要隔 ≥7.6，
    // 否则下一巷道的载货站台会撞上一巷道的货架（货架在 aisleX±2、半宽 0.9）。
    // 取 [8, 16]：相隔 8.0，两侧各留 0.4 净距。
    const aisleXs = aisles >= 2 ? [8, 16] : [8];
    const IO_TOP = 2.6;
    /**
     * 环线宽 = 巷道到载货站台的横向距离。载货站台在 inX 处沿 +Z 铺开，
     * 必须整个落进"上一巷道 rack2"与"本巷道 rack1"之间的空档，否则会穿货架。
     * 4.0 是算出来的下限：站台右缘 inX+0.7 ≤ aisleX−2−0.9−0.3 ⇒ IO_SPAN ≥ 3.9。
     */
    const IO_SPAN = 4.0;
    const ioInX = (aisleX: number): number => aisleX - IO_SPAN;
    /** 载货站台北端 / 堆垛机出入库交接点 Z：紧贴货架前沿（zFront=6）南侧 1.0m 处。
     *  站台横段（朝巷道中心伸出那段）就在这个 Z：低于货架前沿，所以不会和货架叠面；
     *  又高过角落移栽机（IO_TOP=2.6），所以竖段+横段构成 L 形、货从 -Z 侧被顶进来排队。 */
    const STATION_END = 5.0;
    /** 堆垛机出入库交接点 Z：与站台横段同高（紧邻货架前沿南侧），堆垛机从这里把货叉伸进巷道存取。 */
    const ASRS_IO_Z = STATION_END;
    // 分流移栽机放在两巷道入库口之间的空档（T@8 右缘 8.8 ~ T@12 左缘 11.2，共 2.4m）。
    const transferX = 10.0;
    /** 主环线东界（右转载拐角 x）：要容下 aisleX=16 的入库移栽机右缘 16.8，留 1.5 净距。 */
    const MAIN_EAST = 19;
    // 分流支线：南行到 z=-2.6，西行回主线；回程接口选西侧长直段 x=1.0。
    const BRANCH_Z = -2.6;
    const branchBackX = 1.0;

    /**
     * 折线输送线：一条线自带 90° 拐，点列按**行进顺序**给（未缩放的世界坐标）。
     * 拐角在渲染层按带宽一半（= HALF_C）倒圆，占地跟独立转角模块完全一样，
     * 所以相邻直段的让位距离沿用 HALF_C 即可，不用重新算。
     */
    const beltL = (
      id: string,
      // 用 `number[][]` 而不是 `[number, number][]`：数组字面量 [[16,0],[16,-6]]
      // 会被推断成 number[][]，赋给元组类型要报错，没必要为此在每个调用点写断言。
      pts: number[][],
      label: string,
      // 显式标 string：不标的话类型会被推成默认值的字面量 '#8BD3C7'，
      // 传 CENTER.pack 之类就报错。
      color: string = CENTER.belt,
      direction: 1 | -1 = 1,
    ): void => {
      const head = pts[0]!;
      const p0x = head[0] ?? 0;
      const p0z = head[1] ?? 0;
      entities.push(
        conveyorPolyline(
          id,
          [x(p0x), BELT_Y, z(p0z)],
          pts.map((seg) => {
            const sx = seg[0] ?? 0;
            const sz = seg[1] ?? 0;
            return [x(sx) - x(p0x), z(sz) - z(p0z)] as [number, number];
          }),
          { label, color, beltDirection: direction },
        ),
      );
    };

    // 箭头方向按"物料实际行进方向"填：主线东行 +1、回程西行 -1；
    // 沿 Z 的段注意 local +X = 世界 -Z（往 -Z 走填 +1，往 +Z 走填 -1）。
    // 入料/回程线抬到 z=3，让 (-12) 那一对转角之间留出 1.6m 接驳段，不再是 0.6m 的缝。
    // 汇入段—主输送段：从入料拐的出口切点 (-12, 2.3) 南下，到 (-12,0) 拐 90° 东行，
    // 一路铺到合流移栽机前（回程接口是合流点，让位按移栽机半长 HALF_T 算）。
    beltL(
      'belt-join-main',
      [[-12, 3 - HALF_C], [-12, 0], [branchBackX - HALF_T, 0]],
      '汇入段—主输送段',
      CENTER.belt,
      1,
    );
    // 分拣台：紧贴分流支线回程接口往东，铺到第一条巷道的接口移栽机为止。
    const firstAisle = aisleXs[0]!;
    const lastAisle = aisleXs[aisleXs.length - 1]!;
    // 分拣台：紧贴分流支线回程接口往东，铺到第一条巷道的接口移栽机为止。
    beltX('sorter-1', branchBackX + HALF_T, ioInX(firstAisle) - HALF_T, 0, '分拣台', CENTER.sorter, 1);
    // 每条巷道的两个接口移栽机之间，主线让位后剩下的一小段接驳皮带。
    // 由巷道位置推出来，不写死数字——改巷道位置时不会漏改。
    aisleXs.forEach((aisleX, index) => {
      const tag = String.fromCharCode(97 + index);
      // 终点一直铺到 aisleX + 0.8：这里原来接的是入库移栽机（已随旧进料环线撤掉），
      // 现在主线必须连续，否则小货物会在缺口处脱线。
      beltX(`belt-io-${tag}-join`, ioInX(aisleX) + HALF_T, aisleX + 0.8, 0, `主线接驳 ${tag.toUpperCase()}`, CENTER.belt, 1);
    });
    // 出库段—右转载—回程段 1：一条线带两个 90° 拐——东行到 (16,0) 南下、到 (16,-6) 再西行。
    beltL(
      'belt-outfeed-turn-back',
      [[lastAisle + HALF_T, 0], [MAIN_EAST, 0], [MAIN_EAST, -6], [-2, -6]],
      '出库段—右转载—回程段 1',
      CENTER.belt,
      1,
    );
    // 回程段 2—左转载—入料线 1：西行到 (-16,-6) 北上、(-16,3) 东行、(-12,3) 南下，
    // 终点 (-12, 2.3) 正是 belt-join-main 的起点，两条线首尾相接、中间没有拼缝。
    beltL(
      'belt-back-turn-left',
      [[-2, -6], [-16, -6], [-16, 3], [-12, 3], [-12, 3 - HALF_C]],
      '回程段 2—左转载—入料线 1',
      CENTER.belt,
      1,
    );

    // 转角模块全部退役：所有 90° 拐都并进了上面的折线输送线（beltL）。
    // 剩下没并的只有"不转弯的垂直接入/合流"——那是顶升移栽机的活，见下面的 liftTransfer。

    // 主线在相邻移栽机之间还有两小段没铺皮带：transfer-io-8-1 右缘 8.8 →
    // transfer-1 左缘 9.2，以及 transfer-1 右缘 10.8 → transfer-io-16-4 左缘 11.2。
    // 这两条都是纯直段（沿 +X 东行），按规矩用直行皮带补齐；不补的话主线包裹
    // 会在缺口处脱线悬空（runtime 测试抓的就是这种历史遗留断点）。
    beltX('belt-main-link-1', 8.8, 9.2, 0, '主线接驳（8.8→9.2）', CENTER.belt, 1);
    beltX('belt-main-link-2', 10.8, 11.2, 0, '主线接驳（10.8→11.2）', CENTER.belt, 1);

    // 主环线折线：从直段中间起笔，首尾同点，拐角才会被倒圆。
    const mainCorners: TwinVector3[] = [
      [x(-8), DECK_Y, z(0)],
      [x(MAIN_EAST), DECK_Y, z(0)],
      [x(MAIN_EAST), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(3)],
      [x(-12), DECK_Y, z(3)],
      [x(-12), DECK_Y, z(0)],
    ];
    // 主环线是一条连续皮带 → 所有包裹同速（LINE_SPEED.main）。靠 splitClosedLoop
    // 把起步点错开在环上不同位置来维持间距，既不会互相超车、也不会叠在一起。
    // 主环线是一条连续皮带 → 线上所有小货物同速（LINE_SPEED.main）。
    // 小货物**不再预置**：由发生器按固定间隔生成（见下面的 source-1），
    // 在制品达到 maxWip 就停产——这是最朴素的背压，也是"一处持续产出"的落地。
    const goodsPath: TwinVector3[] = [
      [x(-16), DECK_Y, z(1.5)],
      [x(-16), DECK_Y, z(3)],
      [x(-12), DECK_Y, z(3)],
      [x(-12), DECK_Y, z(0)],
      [x(MAIN_EAST), DECK_Y, z(0)],
      [x(MAIN_EAST), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(1.5)],
    ];
    entities.push(
      goodsSource('source-1', [x(-17.6), 0, z(1.5)], {
        label: '小货物发生器',
        interval: produceInterval,
        maxWip,
        goodsPath,
        goodsSpeed: LINE_SPEED.main,
        goodsColor: CENTER.cargo[0],
        goodsSize: [0.6, 0.6, 0.6],
        goodsCornerRadius: 0.5 * s,
      }),
    );

    // ── 顶升移栽机 + 分流支线 ──
    // 移栽机嵌在主线上（两巷道之间的空档），直行货直接滚过去；
    // 指定货 divert-cargo-1 到跟前会被顶起、垂直接入南侧支线绕一圈再汇回主线。
    // 这里是"不转弯的垂直移动"，所以主线在移栽机处断开（两侧各留 0.15 缝）。
    // 支线三面铺皮带 + 三个 90° 转角，货物不会脱线。
    // 分流环走向：主线东行到移栽机 → 顶起南行 → 西行 → 北行 → 回主线东行。
    // 台面与托举座必须同宽同深：两边共用一套节距算链带位置，尺寸不一致
    // 链带就会压在滚筒上而不是落在缝里。
    const TRANSFER_SIZE: TwinVector3 = [1.6, 0.6, 1.4];
    const CASSETTE_SIZE: TwinVector3 = [1.6, 0.14, 1.4];
    // 分流支线：一条线走完"南行 → 西行 → 北行"，两个 90° 拐都在线上，不再拼转角模块。
    beltL(
      'belt-branch',
      [
        [transferX, 0 - HALF_C],
        [transferX, BRANCH_Z],
        [branchBackX, BRANCH_Z],
        [branchBackX, 0 - HALF_C],
      ],
      '分流支线（南—西—北）',
      CENTER.belt,
      1,
    );

    entities.push(
      liftTransfer('transfer-1', [x(transferX), BELT_Y, z(0)], {
        label: '顶升移栽机 1',
        color: CENTER.sorter,
        size: TRANSFER_SIZE,
        divertIds: ['divert-cargo-1'],
        liftHeight: 0.13,
        beltDirection: 1, // 主线东行
        divertSign: -1, // 往南(-Z)顶进分流支线
      }),
    );
    entities.push(
      liftTransferCassette(
        'transfer-1-cassette',
        [x(transferX), BELT_Y, z(0)],
        CENTER.pack,
        '移栽托举座',
        CASSETTE_SIZE,
        -1,
      ),
    );

    // 分流环：主线(branchBackX→transferX) → 南行 → 西行 → 北行 → 回主线。
    // 起笔点落在第一段（沿主线的那一笔）上，货物开局就在主线上。
    const divertCorners: TwinVector3[] = [
      [x(branchBackX), DECK_Y, z(0)],
      [x(transferX), DECK_Y, z(0)],
      [x(transferX), DECK_Y, z(BRANCH_Z)],
      [x(branchBackX), DECK_Y, z(BRANCH_Z)],
    ];
    entities.push(
      parcel('divert-cargo-1', splitClosedLoop(divertCorners, 0.15), LINE_SPEED.divert, {
        label: '分流物料 1',
        color: CENTER.cargo[2],
        cornerRadius: 0.4 * s,
      }),
    );

    // 支线两个真拐弯（南行→西行、西行→北行）都是单线纯过路 → 90° 弯道。
    // corner-d2 / corner-d3 已撤：那两个拐并进 belt-branch 了。
    // 支线汇回主线那一点是**合流**：主线要直通、支线要并入，两条线在此相交，
    // 按规矩改用顶升移栽机（不是 90° 弯道）。且必须是 merge 模式：
    // 货从 −Z 侧驶入台面边缘 → 顶起 → 链带(+Z)送到台面中央 → 落带 → 主线带走。
    // 用 divert 模式会把货往回推（它是"中央→边缘"，正好相反）。
    entities.push(
      liftTransfer('transfer-merge-1', [x(branchBackX), BELT_Y, z(0)], {
        label: '合流移栽机 1',
        color: CENTER.sorter,
        size: TRANSFER_SIZE,
        divertIds: ['divert-cargo-1'],
        liftHeight: 0.13,
        beltDirection: 1,
        divertSign: 1, // 链带往北(+Z)，与支线来料同向
        mode: 'merge',
      }),
    );
    entities.push(
      liftTransferCassette(
        'transfer-merge-1-cassette',
        [x(branchBackX), BELT_Y, z(0)],
        CENTER.pack,
        '合流托举座',
        CASSETTE_SIZE,
        1,
      ),
    );

    // ── 质检与拒收 ──
    // 检测站是跨在皮带上方的拱门，不占皮带，所以直接架在主干线上。
    entities.push(inspectionStation('scan-01', [x(-8.5), 0, z(0)], 1.8));
    entities.push(inspectionStation('scan-02', [x(-2), 0, z(0)], 1.8));
    // 拒收货架落在 z=-2.6 分流支线与 z=-6 回程线之间唯一空档的正中（z=-4.3）：
    // 深 1.8 → z∈[-5.2,-3.4]，与回程线台面（z∈[-6.7,-5.3]）和支线台面（z∈[-3.3,-1.9]）
    // 各留 0.1m，不再叠面。
    entities.push(withColor(bufferRack('reject-rack-1', [x(-6), 1, z(-4.3)]), CENTER.reject));
    entities.push(withColor(bufferRack('reject-rack-2', [x(6), 1, z(-4.3)]), CENTER.reject));
    // ── 立体仓库 + 闭环产线 ──
    // 打包站骑在主线上：2 个小货物 → 1 个托盘；托盘沿出料带走上载货站台排队，
    // 堆垛机存进货位；出库后停在出库缓存台上等卡车运走（真正的"出口"）。
    // 货架前沿从 z=4 挪到 6：让出 2m 给载货站台，否则站台只有 1.1m、存不下货。
    // 后端同步 13→15，货架净长仍是 9m，库容不变。
    const RACK = { halfW: 0.9, height: 4.5, zFront: 6, zBack: 15 } as const;
    const rackZ = (RACK.zFront + RACK.zBack) / 2;
    const rackLen = RACK.zBack - RACK.zFront;
    const rackY = RACK.height / 2; // 货架实体 y 取半高，模型才落在地面上
    /** 每层货位的实际高度：货架横梁、堆垛机取货高度、托盘落位高度三者共用这一份。 */
    const RACK_LEVELS = [1.35, 2.5, 3.65];
    /** 沿货架长边的货位列数。 */
    const RACK_BAYS = 5;
    /**
     * 出库口 Z：货架北端（zBack=15）再往外 1.0m。
     *
     * 巷道在北侧是敞开的，堆垛机载货走出货架北端把托盘放到这里的出库缓存台上，
     * 卡车停它北面装货——**南进北出**的贯通式流，出库不再和入库抢同一条走廊。
     */
    const OUT_Z = 16.0;
    /**
     * 卡车停车位 Z：出库缓存台北面，**纵置停车**（6m 长边沿 Z，车头朝北）。
     *
     * 车尾（南端）停在 z=17，和缓存台北沿（16.8）留 0.2m 净距——车尾正对装车区，
     * 装满后沿 +Z 直线驶离，不用先横移再转弯。
     */
    const TRUCK_Z = 20.0;
    /**
     * 出库缓存台：堆垛机**卸货点**在巷道东侧 `aisleX+1.6`（货叉够得着的最远处），
     * 托盘落台后沿 +X 被送到排队段，队首停在 `aisleX+1.6+OUT_LANE_LEN` 处等卡车。
     */
    const OUT_DROP_DX = 1.6;
    /** 排队段长度：节距 0.9 → 能排 4 块（+ 卸货点 1 块），比卡车容量多一位，卸货点不会堵。 */
    const OUT_LANE_LEN = 3.6;

    for (const aisleX of aisleXs) {
      const tag = aisleXs.indexOf(aisleX) === 0 ? 'a' : 'b';
      const upper = tag.toUpperCase();
      const inX = ioInX(aisleX);
      /** 打包站骑在主线上（巷道口西侧 2m），一巷道一台。 */
      const packX = aisleX - 2;
      /** 出料带绕行用的东侧通道：从打包站东行、北上、再西行插进队列尾。 */
      const outLaneX = aisleX + 0.5;
      const outLaneZ = 3.6;
      /**
       * 出库缓存台与卡车都搬到**货架北端之外**（z=OUT_Z），停在巷道正北偏东 2m：
       * - 偏东 2m 是为了让开门架（占 aisleX±0.5）和缓存台（半宽 1.3）不叠面，
       *   同时货叉（伸 aisleX+1.5）正好够得着卸货位；
       * - 原来放在巷道西侧 z=1.5 的走廊里，那条走廊只有 1.6m 宽，2.2m 宽的卡车
       *   停那儿必定压住主线皮带（实测压 0.3m），而且出库路径会穿过入库队列，
       *   只能退化成"托盘从巷道口瞬移到缓存台"。
       */
      /** 卸货点 X：货叉伸出 `slotX` 后托盘落在这里，也是出库带的起点。 */
      const outDropX = aisleX + OUT_DROP_DX;
      /** 缓存台中心 X（= 卡车停车位 X）：卸货点往东半个排队段，车尾正对装车区。 */
      const dockX = outDropX + OUT_LANE_LEN / 2;
      const truckX = dockX;

      for (const [suffix, offset, side] of [
        ['1', -2, 0],
        ['2', 2, 1],
      ] as const) {
        entities.push(
          asrsRack(`rack-${tag}${suffix}`, [x(aisleX + offset), rackY, z(rackZ)], [1.8, RACK.height, rackLen], {
            label: `货架 ${upper}${suffix}`,
            color: CENTER.rack,
            levelHeights: RACK_LEVELS,
            bays: RACK_BAYS,
            craneId: `stacker-${tag}`,
            side,
          }),
        );
      }

      // 载货站台：L 形——竖段从出料带汇入点沿 +Z 立起到 STATION_END，
      // 横段朝巷道中心伸到 aisleX，让堆垛机从侧面接货。入库队列就排在它上面。
      beltL(
        `belt-io-${tag}-station`,
        [[inX, IO_TOP + HALF_C], [inX, STATION_END], [aisleX, STATION_END]],
        `载货站台 ${upper}`,
        CENTER.pack,
        1,
      );

      // 主线上的接驳移栽机：这一段原来是"出库并入主线"的合流点，
      // 现在出库走卡车，它只负责把主线在 inX 处接续起来（divertIds 为空，不顶升任何货）。
      entities.push(
        liftTransfer(`transfer-io-${aisleX}-4`, [x(inX), BELT_Y, z(0)], {
          label: `主线接驳移栽机 ${upper}`,
          color: CENTER.sorter,
          size: TRANSFER_SIZE,
          liftHeight: 0.13,
          beltDirection: 1,
          divertSign: -1,
          mode: 'merge',
        }),
      );
      entities.push(
        liftTransferCassette(
          `transfer-io-${aisleX}-4-cassette`,
          [x(inX), BELT_Y, z(0)],
          CENTER.pack,
          `主线托举座 ${upper}`,
          CASSETTE_SIZE,
          -1,
        ),
      );

      // 打包站：跨在主线上的龙门工位，小货物从底下经过就被认领（2 个合 1 个托盘）。
      entities.push(
        packingStation(`pack-${tag}`, [x(packX), 0, z(0)], {
          label: `打包站 ${upper}`,
          color: CENTER.pack,
          batch: 2,
          radius: 1.8 * s,
          palletPath: [
            [x(packX), DECK_Y, z(1.4)],
            [x(outLaneX), DECK_Y, z(1.4)],
            [x(outLaneX), DECK_Y, z(outLaneZ)],
            [x(inX + HALF_C), DECK_Y, z(outLaneZ)],
          ],
          palletSpeed: 0.9,
          palletSize: [0.8, 0.56, 1],
          palletColor: CENTER.pack,
          carrier: `stacker-${tag}`,
        }),
      );
      // 出料带：东行 → 北上 → 西行插进队列尾。托盘路径全程压在这条皮带上。
      beltL(
        `belt-pack-out-${tag}`,
        [
          [packX, 1.4],
          [outLaneX, 1.4],
          [outLaneX, outLaneZ],
          [inX + HALF_C, outLaneZ],
        ],
        `打包出料带 ${upper}`,
        CENTER.pack,
        1,
      );

      // 出库缓存台（= 出库输送线）：货架北端之外，堆垛机载货出巷后把托盘放这，
      // 托盘再沿 +X 往东排队，队首停到卡车车尾前等装车。
      // 台面要够长：卸货点 + 排队段 + 两端余量，否则排到第 5 块就会叠在一起。
      entities.push(
        conveyorSegment(`dock-${tag}`, [x(dockX), BELT_Y, z(OUT_Z)], {
          label: `出库缓存台 ${upper}`,
          color: CENTER.reject,
          size: [OUT_LANE_LEN + 1.2, 0.6, 1.6],
          axis: 'x',
          beltDirection: 1,
        }),
      );

      // 堆垛机三件套：门架走 Z、载货台升降 Y、货叉伸 X，全部由 asrs-cycle 行为驱动。
      const cycle = tag === 'a' ? 14 : 16.5;
      const phase = tag === 'a' ? 0 : 0.38;
      /** 货位 X：从货架内侧面（aisleX±1.1）再往里 0.4m，0.8m 宽的托盘整个落在货架里。 */
      const slotX = 1.5;
      entities.push(
        stackerCrane(`stacker-${tag}`, [x(aisleX), 0, z(ASRS_IO_Z)], {
          label: `堆垛机 ${upper}`,
          color: CENTER.stacker,
          cycle: {
            aisleX: x(aisleX),
            ioZ: z(ASRS_IO_Z),
            ioY: DECK_Y,
            zMin: z(RACK.zFront + 0.4),
            zMax: z(RACK.zBack - 0.4),
            // 货位高度 / 列数必须和货架声明一致，否则托盘会落在横梁外面。
            levels: RACK_LEVELS,
            columns: RACK_BAYS,
            cycle,
            phase,
            reach: x(slotX),
            forkX: [x(aisleX - slotX), x(aisleX + slotX)],
            // 入库队列排在 L 形载货站台上（横段西端 = inX）；
            // 出库：载货走出货架**北端**，货叉朝东把托盘放到北侧出库缓存台，
            // 等卡车装走（shipped 模式，不回流）。
            // `outfeedTravelZ` 是让门架真的把货载出去的关键——不声明它就只会
            // 回到巷道口卸货，托盘等于从巷道口瞬移到缓存台。
            stationX: x(inX),
            // +0.1 已并进 outDropX：托盘放下时正好在 outfeedX 上（零跳变）。
            outfeedX: x(outDropX),
            outfeedZ: [z(OUT_Z)],
            outfeedTravelZ: z(OUT_Z),
            outfeedDir: 1,
            // 出库带：托盘落到缓存台后**沿 +X 自己走出去**排成一列（队列头在东端，
            // 离卡车最近；后面的依次退一个节距）。
            //
            // 不声明这段路径，asrs 就退化成"所有出库托盘直接落在同一个点上"——
            // 缓存台上永远只有一件货可装，卡车自然只能装一件就走。
            outboundPath: [
              [x(outDropX), 0, z(OUT_Z)],
              [x(outDropX + OUT_LANE_LEN), 0, z(OUT_Z)],
            ],
            outboundMode: 'shipped',
            highWater,
          },
        }),
      );
      entities.push(
        stackerCarriage(`stacker-${tag}-carriage`, [x(aisleX), DECK_Y, z(3)], CENTER.stacker, `载货台 ${upper}`),
      );
      entities.push(stackerFork(`stacker-${tag}-fork`, [x(aisleX), DECK_Y, z(3)], undefined, `货叉 ${upper}`));

      // 卡车：停在**仓库北面**的出库缓存台后面装货（不再挤在主线走廊里），
      // 攒满一车（或出库带断流 dwell 秒）才沿 +Z 直线驶离，回来再装。
      //
      // 纵置停车：车尾朝南正对缓存台，车头朝北。6m 长边沿 Z（占 TRUCK_Z±3），
      // 2.2m 宽沿 X（占 truckX±1.1）。起步就是直行向北，不用先横移再拐 90°——
      // 之前是横置 + 侧向平移，加上 heading 算错 90°，看起来像车在横着飘。
      // 离场路线整段都在货架以北的空地，不压任何皮带。
      entities.push(
        truck(`truck-${tag}`, [x(truckX), 0, z(TRUCK_Z)], {
          label: `出库卡车 ${upper}`,
          color: CENTER.external,
          // 装货区取**出库缓存台**而不是车位本身：车位在 z=20、货在 z=16，
          // 以车位为圆心要 5m 半径才够得着队尾，容易越过 3.2m 的巷道间隔
          // 误装隔壁巷道的货。以台面中心为圆心，半径只需覆盖台面长度。
          dock: [x(dockX), 0, z(OUT_Z)],
          route: [
            [x(truckX), 0, z(TRUCK_Z)],
            [x(truckX), 0, z(28)],
          ],
          speed: 2.4,
          capacity: 4,
          // 装满 4 件要 3 个循环：A 42s / B 49.5s。窗口给 60s，保证是"装满才走"
          // 而不是"攒到一半超时发车"；真断货了也有兜底，不会永久趴窝。
          dwell: 60,
          awayTime: 20,
          loadRadius: (OUT_LANE_LEN / 2 + 1.4) * s,
        }),
      );
    }

    return entities;
  },
};

/** 把物流中心模板产出的实体组装成可直接喂给 `TwinWorld` 的场景。 */
export function buildCenterScene(params: CenterTemplateParams = {}): TwinScene {
  return {
    version: 1,
    id: 'logistics-center',
    name: '智能物流中心',
    entities: centerTemplate.build(params),
  };
}

// ─────────────────────────────────────────────────────────────────────────

export type { ConfigValue };
