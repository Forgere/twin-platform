import type { ConfigValue, SceneTemplateDescriptor } from '@twin-platform/plugin-sdk';
import type { TwinEntity, TwinScene, TwinVector3 } from '@twin-platform/scene-schema';
import {
  asrsRack,
  bufferRack,
  conveyorCorner,
  conveyorSegment,
  inspectionStation,
  liftTransfer,
  liftTransferCassette,
  pallet,
  parcel,
  stackerCarriage,
  stackerCrane,
  stackerFork,
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
      conveyorSegment('belt-top', [0, 0.6, 0], { label: '输送线上行', size: [length, 0.6, 1.4] }),
      conveyorSegment('belt-bottom', [0, 0.6, DEPTH], { label: '输送线下行', size: [length, 0.6, 1.4] }),
      conveyorSegment('belt-left', [-w, 0.6, DEPTH / 2], { label: '输送线左转', size: [1.4, 0.6, DEPTH] }),
      conveyorSegment('belt-right', [w, 0.6, DEPTH / 2], { label: '输送线右转', size: [1.4, 0.6, DEPTH] }),
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
      conveyorSegment('infeed-1', [x(-14), 0.6, -2], { label: '入料线 1', color: PASTEL.conveyor }),
      conveyorSegment('infeed-2', [x(-14), 0.6, 2], { label: '入料线 2', color: PASTEL.conveyor }),
      conveyorSegment('belt-main-1', [x(-9), 0.6, 0], { label: '主输送段 1', color: PASTEL.conveyor }),
      conveyorSegment('belt-main-2', [x(-2), 0.6, 0], { label: '主输送段 2', color: PASTEL.conveyor }),
      conveyorSegment('belt-main-3', [x(9), 0.6, 0], { label: '主输送段 3', color: PASTEL.conveyor }),
      conveyorSegment('outfeed-1', [x(14), 0.6, 0], { label: '出料线', color: PASTEL.conveyor }),
      withColor(inspectionStation('scan-01', [x(-5), 0.9, 0], 1.6), PASTEL.inspection),
      withColor(inspectionStation('scan-02', [x(5), 0.9, 0], 1.6), PASTEL.inspection),
      withColor(bufferRack('reject-rack-1', [x(-5), 1, 3]), PASTEL.reject),
      withColor(bufferRack('reject-rack-2', [x(5), 1, 3]), PASTEL.reject),
      conveyorSegment('sorter-1', [x(1.5), 0.6, 0], { label: '分拣台', color: PASTEL.conveyor }),
      withColor(bufferRack('pack-01', [x(12), 1, 0]), PASTEL.pack),
      // 外部车道沿 Z 铺设（长边给 Z），间距 4 > 长度 3.2，彼此不重叠。
      ...Array.from({ length: lanes }, (_, i) =>
        conveyorSegment(`ext-${i + 1}`, [x(16), 0.6, -6 + i * 4], {
          label: `外部车道 ${i + 1}`,
          color: PASTEL.external,
          size: [1.4, 0.6, 3.2],
        }),
      ),
    ];

    // 主环线：左入料 → 右出料 → 下 → 回到左侧，构成闭环矩形。
    // 同一条连续皮带 → 所有包裹同速（MAIN_SPEED）。靠 splitClosedLoop 把起步点
    // 错开在环上，既不会互相超车、也不会叠在一起。
    const mainPath: TwinVector3[] = [
      [x(-14), yLine, 0],
      [x(14), yLine, 0],
      [x(14), yLine, -5],
      [x(-14), yLine, -5],
    ];
    const MAIN_SPEED = 1.4;
    for (let i = 0; i < count; i += 1) {
      entities.push(
        parcel(`parcel-${i + 1}`, splitClosedLoop(mainPath, i / count), MAIN_SPEED, {
          label: `在制物料 ${i + 1}`,
          color: PASTEL.cargo[i % PASTEL.cargo.length],
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
  /** 立库出入库环步速。 */
  asrs: 0.9,
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

export interface CenterTemplateParams {
  /** 主环线在制物料数，默认 10。 */
  parcels?: number;
  /** 每个立库出入库环的物料数，默认 3。 */
  asrsParcels?: number;
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
    const mainCount = params.parcels ?? 10;
    const asrsCount = params.asrsParcels ?? 3;
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
    // 立库巷道（两条要隔 ≥5.8，否则两侧货架互撞）；出入库环宽 2.5、环顶 z=2.6。
    const aisleXs = aisles >= 2 ? [7, 13] : [7];
    const IO_TOP = 2.6;
    const ioInX = (aisleX: number): number => aisleX - 2.5;
    // 分流移栽机放在两巷道之间的空档（T@7 右缘 7.8 ~ T@10.5 左缘 9.7，共 1.9m）。
    const transferX = 8.75;
    // 分流支线：南行到 z=-2.6，西行回主线；回程接口选西侧长直段 x=1.0。
    const BRANCH_Z = -2.6;
    const branchBackX = 1.0;

    // 箭头方向按"物料实际行进方向"填：主线东行 +1、回程西行 -1；
    // 沿 Z 的段注意 local +X = 世界 -Z（往 -Z 走填 +1，往 +Z 走填 -1）。
    // 入料/回程线抬到 z=3，让 (-12) 那一对转角之间留出 1.6m 接驳段，不再是 0.6m 的缝。
    beltX('infeed-1', -16 + HALF_C, -12 - HALF_C, 3, '入料线 1', CENTER.belt, 1);
    beltZ('belt-join', -12, 3 - HALF_C, 0 + HALF_C, '汇入段', CENTER.belt, 1);
    beltX('belt-main-1', -12 + HALF_C, -5, 0, '主输送段 1', CENTER.belt, 1);
    beltX('belt-main-2', -5, branchBackX - HALF_C, 0, '主输送段 2', CENTER.belt, 1);
    // 分拣台：紧贴分流支线回程接口往东，铺到第一条巷道的接口移栽机为止。
    const firstAisle = aisleXs[0]!;
    const lastAisle = aisleXs[aisleXs.length - 1]!;
    // 分拣台：紧贴分流支线回程接口往东，铺到第一条巷道的接口移栽机为止。
    beltX('sorter-1', branchBackX + HALF_C, ioInX(firstAisle) - HALF_T, 0, '分拣台', CENTER.sorter, 1);
    // 每条巷道的两个接口移栽机之间，主线让位后剩下的一小段接驳皮带。
    // 由巷道位置推出来，不写死数字——改巷道位置时不会漏改。
    aisleXs.forEach((aisleX, index) => {
      const tag = String.fromCharCode(97 + index);
      beltX(`belt-io-${tag}-join`, ioInX(aisleX) + HALF_T, aisleX - HALF_T, 0, `主线接驳 ${tag.toUpperCase()}`, CENTER.belt, 1);
    });
    beltX('belt-outfeed', lastAisle + HALF_T, 16 - HALF_C, 0, '出库段', CENTER.belt, 1);
    beltZ('belt-turn-r', 16, 0 - HALF_C, -6 + HALF_C, '右转载段', CENTER.belt, 1);
    beltX('belt-back-1', 16 - HALF_C, -2, -6, '回程段 1', CENTER.belt, -1);
    beltX('belt-back-2', -2, -16 + HALF_C, -6, '回程段 2', CENTER.belt, -1);
    beltZ('belt-turn-l', -16, -6 + HALF_C, 3 - HALF_C, '左转载段', CENTER.belt, -1);

    // 90° 转角模块：直行皮带按"让到模块边"的约定铺，转角正好补上缺口，输送线在这真正拐弯。
    const corner = (id: string, xAt: number, zAt: number, color = CENTER.belt): void => {
      entities.push(
        conveyorCorner(id, [x(xAt), BELT_Y, z(zAt)], { label: '转角', color, size: [1.4, 0.6, 1.4] }),
      );
    };
    corner('corner-1', 16, 0);
    corner('corner-2', 16, -6);
    corner('corner-3', -16, -6);
    corner('corner-4', -16, 3);
    corner('corner-5', -12, 3);
    corner('corner-6', -12, 0);

    // 主环线折线：从直段中间起笔，首尾同点，拐角才会被倒圆。
    const mainCorners: TwinVector3[] = [
      [x(-8), DECK_Y, z(0)],
      [x(16), DECK_Y, z(0)],
      [x(16), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(3)],
      [x(-12), DECK_Y, z(3)],
      [x(-12), DECK_Y, z(0)],
    ];
    // 主环线是一条连续皮带 → 所有包裹同速（LINE_SPEED.main）。靠 splitClosedLoop
    // 把起步点错开在环上不同位置来维持间距，既不会互相超车、也不会叠在一起。
    for (let i = 0; i < mainCount; i += 1) {
      entities.push(
        parcel(`parcel-${i + 1}`, splitClosedLoop(mainCorners, i / mainCount), LINE_SPEED.main, {
          label: `在制物料 ${i + 1}`,
          color: CENTER.cargo[i % CENTER.cargo.length],
          // 圆角半径要小于拐角处皮带的覆盖半宽（0.7），倒角才不会切到没皮带的地方。
          cornerRadius: 0.5 * s,
        }),
      );
    }

    // ── 顶升移栽机 + 分流支线 ──
    // 移栽机嵌在主线上（两巷道之间的空档），直行货直接滚过去；
    // 指定货 divert-cargo-1 到跟前会被顶起、垂直接入南侧支线绕一圈再汇回主线。
    // 这里是"不转弯的垂直移动"，所以主线在移栽机处断开（两侧各留 0.15 缝）。
    // 支线三面铺皮带 + 三个 90° 转角，货物不会脱线。
    // 分流环走向：主线东行到移栽机 → 顶起南行 → 西行 → 北行 → 回主线东行。
    beltZ('belt-branch-a', transferX, 0 - HALF_C, BRANCH_Z + HALF_C, '分流支线（南行）', CENTER.belt, 1);
    beltX('belt-branch-b', branchBackX + HALF_C, transferX - HALF_C, BRANCH_Z, '分流支线（西行）', CENTER.belt, -1);
    beltZ('belt-branch-c', branchBackX, 0 - HALF_C, BRANCH_Z + HALF_C, '分流支线（北行）', CENTER.belt, -1);

    entities.push(
      liftTransfer('transfer-1', [x(transferX), BELT_Y, z(0)], {
        label: '顶升移栽机 1',
        color: CENTER.sorter,
        divertIds: ['divert-cargo-1'],
        liftHeight: 0.13,
      }),
    );
    entities.push(liftTransferCassette('transfer-1-cassette', [x(transferX), BELT_Y, z(0)], CENTER.pack, '移栽托举座'));

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

    // 分流支线转角：只有真正拐弯的三处（回主线接口 + 支线两角）。
    // 注意主线上不再放 corner-d1 —— 原来那个压在主线皮带上，纯属叠面。
    corner('corner-d2', transferX, BRANCH_Z);
    corner('corner-d3', branchBackX, BRANCH_Z);
    corner('corner-d4', branchBackX, 0);

    // ── 质检与拒收 ──
    // 检测站是跨在皮带上方的拱门，不占皮带，所以直接架在主干线上。
    entities.push(inspectionStation('scan-01', [x(-8.5), 0, z(0)], 1.8));
    entities.push(inspectionStation('scan-02', [x(-2), 0, z(0)], 1.8));
    // 拒收货架挪到 z=-4.5：让开分流支线(z=-2.6)与回程线(z=-6)之间的唯一空档。
    entities.push(withColor(bufferRack('reject-rack-1', [x(-6), 1, z(-4.5)]), CENTER.reject));
    entities.push(withColor(bufferRack('reject-rack-2', [x(6), 1, z(-4.5)]), CENTER.reject));
    entities.push(withColor(bufferRack('pack-01', [x(18.5), 1, z(2)]), CENTER.pack));

    // ── 立体仓库：巷道两侧各一排高层货架，巷道口接一段出入库环线 ──
    const RACK = { halfW: 0.9, height: 4.5, zFront: 4, zBack: 13 } as const;
    const rackZ = (RACK.zFront + RACK.zBack) / 2;
    const rackLen = RACK.zBack - RACK.zFront;
    const rackY = RACK.height / 2; // 货架实体 y 取半高，模型才落在地面上

    for (const aisleX of aisleXs) {
      const tag = aisleXs.indexOf(aisleX) === 0 ? 'a' : 'b';
      const upper = tag.toUpperCase();
      for (const [suffix, offset] of [
        ['1', -2],
        ['2', 2],
      ] as const) {
        entities.push(
          asrsRack(`rack-${tag}${suffix}`, [x(aisleX + offset), rackY, z(rackZ)], [1.8, RACK.height, rackLen], {
            label: `货架 ${upper}${suffix}`,
            color: CENTER.rack,
          }),
        );
      }

      // 出入库环线：主线 →(顶升移栽机垂直接入)→ 巷道 → 环顶 →(顶升移栽机)→ 回主线。
      // 出库/入库都是"不转弯的垂直移动"（相对主线流向是垂直的），所以按规则用移栽机
      // 并把主线断开；环顶那两处是真拐弯，仍然用 90° 转角模块。
      // 环线走向：沿巷道北上(+Z) → 西行到 inX(-X) → 南下回主线(-Z) → 沿主线东行回巷道口。
      const inX = ioInX(aisleX);
      const ioCargoIds = Array.from({ length: asrsCount }, (_, i) => `asrs-${aisleX}-cargo-${i + 1}`);
      // 竖向接驳段：移栽机台面(z ±0.7)到环顶转角(z 2.6±0.7)之间那 1.2m。
      beltZ(`belt-io-${aisleX}-in`, aisleX, HALF_T, IO_TOP - HALF_C, `入库接驳 ${upper}`, CENTER.belt, -1);
      beltX(`belt-io-${aisleX}-top`, inX + HALF_C, aisleX - HALF_C, IO_TOP, `巷道口 ${upper}`, CENTER.belt, 1);
      beltZ(`belt-io-${aisleX}-out`, inX, HALF_T, IO_TOP - HALF_C, `出库接驳 ${upper}`, CENTER.belt, 1);

      const ioCorners: TwinVector3[] = [
        [x(aisleX), DECK_Y, z(0)],
        [x(aisleX), DECK_Y, z(IO_TOP)],
        [x(inX), DECK_Y, z(IO_TOP)],
        [x(inX), DECK_Y, z(0)],
      ];

      // 环顶两处 90° 转角（真拐弯）；主线上的两个接口改用顶升移栽机垂直接入。
      corner(`corner-io-${aisleX}-2`, aisleX, IO_TOP);
      corner(`corner-io-${aisleX}-3`, inX, IO_TOP);
      for (const [suffix, atX] of [
        ['1', aisleX],
        ['4', inX],
      ] as const) {
        entities.push(
          liftTransfer(`transfer-io-${aisleX}-${suffix}`, [x(atX), BELT_Y, z(0)], {
            label: `出入库移栽机 ${upper}${suffix}`,
            color: CENTER.sorter,
            divertIds: ioCargoIds,
            liftHeight: 0.13,
          }),
        );
        entities.push(
          liftTransferCassette(
            `transfer-io-${aisleX}-${suffix}-cassette`,
            [x(atX), BELT_Y, z(0)],
            CENTER.pack,
            `移栽托举座 ${upper}${suffix}`,
          ),
        );
      }
      for (let i = 0; i < asrsCount; i += 1) {
        entities.push(
          parcel(`asrs-${aisleX}-cargo-${i + 1}`, splitClosedLoop(ioCorners, i / asrsCount), LINE_SPEED.asrs, {
            label: `立库物料 ${aisleX}-${i + 1}`,
            color: CENTER.cargo[(i + 1) % CENTER.cargo.length],
            cornerRadius: 0.35 * s,
          }),
        );
      }

      // 堆垛机三件套：门架走 Z、载货台升降 Y、货叉伸 X，全部由 asrs-cycle 行为驱动。
      const cycle = tag === 'a' ? 14 : 16.5;
      const phase = tag === 'a' ? 0 : 0.38;
      entities.push(
        stackerCrane(`stacker-${tag}`, [x(aisleX), 0, z(3)], {
          label: `堆垛机 ${upper}`,
          color: CENTER.stacker,
          cycle: {
            aisleX: x(aisleX),
            ioZ: z(3),
            ioY: DECK_Y,
            zMin: z(RACK.zFront + 0.4),
            zMax: z(RACK.zBack - 0.4),
            levels: [1.35, 2.5, 3.65],
            columns: 5,
            cycle,
            phase,
            reach: x(1.35),
            forkX: [x(aisleX - 1.35), x(aisleX + 1.35)],
          },
        }),
      );
      entities.push(
        stackerCarriage(`stacker-${tag}-carriage`, [x(aisleX), DECK_Y, z(3)], CENTER.stacker, `载货台 ${upper}`),
      );
      entities.push(stackerFork(`stacker-${tag}-fork`, [x(aisleX), DECK_Y, z(3)], undefined, `货叉 ${upper}`));
      entities.push(
        pallet(`stacker-${tag}-load`, [x(aisleX), DECK_Y, z(2.1)], CENTER.pack, `托盘 ${upper}`),
      );
    }

    // ── 外部数字孪生车道：各自一小圈环线 ──
    for (let i = 0; i < lanes; i += 1) {
      const zCenter = -3 + i * 4.5;
      entities.push(
        conveyorSegment(`ext-${i + 1}`, [x(20.6), BELT_Y, z(zCenter)], {
          label: `外部车道 ${i + 1}`,
          color: CENTER.external,
          size: [1.2, 0.6, z(2.6)],
        }),
      );
      const extCorners: TwinVector3[] = [
        [x(20.3), DECK_Y, z(zCenter - 1.3)],
        [x(20.9), DECK_Y, z(zCenter - 1.3)],
        [x(20.9), DECK_Y, z(zCenter + 1.3)],
        [x(20.3), DECK_Y, z(zCenter + 1.3)],
      ];
      entities.push(
        parcel(`ext-cargo-${i + 1}`, splitClosedLoop(extCorners, 0), LINE_SPEED.ext, {
          label: `外部物料 ${i + 1}`,
          color: CENTER.cargo[(i + 2) % CENTER.cargo.length],
          cornerRadius: 0.2 * s,
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

export type { ConfigValue };
