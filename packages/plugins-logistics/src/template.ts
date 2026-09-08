import type { ConfigValue, SceneTemplateDescriptor } from '@twin-platform/plugin-sdk';
import type { TwinEntity, TwinScene, TwinVector3 } from '@twin-platform/scene-schema';
import {
  asrsRack,
  bufferRack,
  conveyorSegment,
  inspectionStation,
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
 * 由入料输送线、检测站、缓存货架与若干循环包裹组成。包裹速度按序号递增，
 * 因此它们绕圈时机错开——积压与吞吐会自然波动，而不是齐刷刷地一起进一起出。
 */
export const lineTemplate: SceneTemplateDescriptor<LineTemplateParams> = {
  id: 'logistics-line',
  label: '物流输送线',
  build(params: LineTemplateParams = {}) {
    const count = params.parcels ?? 5;
    const length = params.length ?? 20;
    const base = params.baseSpeed ?? 1.6;
    const path: TwinVector3[] = [
      [-length / 2, 1.15, 0],
      [length / 2, 1.15, 0],
    ];

    const entities: TwinEntity[] = [
      conveyorSegment('belt-in', [-length / 2 - 1.5, 0.6, 0], { label: '入料输送线' }),
      inspectionStation('scan-01', [0, 0.9, 0], 1.6),
      bufferRack('buffer-01', [length / 2 + 1.5, 1, 0]),
    ];

    for (let index = 0; index < count; index += 1) {
      entities.push(parcel(`parcel-${index + 1}`, path, base + index * 0.12, { label: `在制物料 ${index + 1}` }));
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
    const mainPath: TwinVector3[] = [
      [x(-14), yLine, 0],
      [x(14), yLine, 0],
      [x(14), yLine, -5],
      [x(-14), yLine, -5],
    ];
    for (let i = 0; i < count; i += 1) {
      entities.push(
        parcel(`parcel-${i + 1}`, mainPath, 1.4 + i * 0.12, {
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

    /** 沿 X 铺一段输送线（长边给 X）。长度取绝对值，方向不影响实体。 */
    const beltX = (id: string, x0: number, x1: number, zAt: number, label: string, color = CENTER.belt): void => {
      entities.push(
        conveyorSegment(id, [x((x0 + x1) / 2), BELT_Y, z(zAt)], {
          label,
          color,
          size: [x(Math.abs(x1 - x0)), 0.6, 1.4],
        }),
      );
    };
    /** 沿 Z 铺一段输送线（长边给 Z）。 */
    const beltZ = (id: string, xAt: number, z0: number, z1: number, label: string, color = CENTER.belt): void => {
      entities.push(
        conveyorSegment(id, [x(xAt), BELT_Y, z((z0 + z1) / 2)], {
          label,
          color,
          size: [1.4, 0.6, z(Math.abs(z1 - z0))],
        }),
      );
    };

    // ── 主环线：入料 → 干线 → 右转载 → 回程 → 左转载，全程有皮带托着 ──
    //
    // 拐角处理：每个拐角只让"进去的那条"铺到角上，出来的那条让出 0.7（半个带宽），
    // 否则两段皮带在拐角同高度叠面，渲染时会 z-fighting 闪烁。
    // 出来的皮带让出的那 0.7，正好由拐角上那条补齐，所以物料不会掉进缝里。
    beltX('infeed-1', -15.3, -12, 2, '入料线 1');
    beltZ('belt-join', -12, 1.3, 0, '汇入段');
    beltX('belt-main-1', -11.3, -5, 0, '主输送段 1');
    beltX('belt-main-2', -5, 0, 0, '主输送段 2');
    beltX('sorter-1', 0, 3, 0, '分拣台', CENTER.sorter);
    beltX('belt-main-3', 3, 10, 0, '主输送段 3');
    beltX('belt-main-4', 10, 16, 0, '出库段');
    beltZ('belt-turn-r', 16, -0.7, -6, '右转载段');
    beltX('belt-back-1', 15.3, -2, -6, '回程段 1');
    beltX('belt-back-2', -2, -16, -6, '回程段 2');
    beltZ('belt-turn-l', -16, -5.3, 2, '左转载段');

    // 主环线折线：从直段中间起笔，首尾同点，拐角才会被倒圆。
    const mainCorners: TwinVector3[] = [
      [x(-8), DECK_Y, z(0)],
      [x(16), DECK_Y, z(0)],
      [x(16), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(-6)],
      [x(-16), DECK_Y, z(2)],
      [x(-12), DECK_Y, z(2)],
      [x(-12), DECK_Y, z(0)],
    ];
    for (let i = 0; i < mainCount; i += 1) {
      entities.push(
        parcel(`parcel-${i + 1}`, splitClosedLoop(mainCorners, i / mainCount), 1.3 + i * 0.1, {
          label: `在制物料 ${i + 1}`,
          color: CENTER.cargo[i % CENTER.cargo.length],
          // 圆角半径要小于拐角处皮带的覆盖半宽（0.7），倒角才不会切到没皮带的地方。
          cornerRadius: 0.5 * s,
        }),
      );
    }

    // ── 质检与拒收 ──
    entities.push(inspectionStation('scan-01', [x(-8.5), 0, z(0)], 1.8));
    entities.push(inspectionStation('scan-02', [x(6.5), 0, z(0)], 1.8));
    entities.push(withColor(bufferRack('reject-rack-1', [x(-6), 1, z(-3)]), CENTER.reject));
    entities.push(withColor(bufferRack('reject-rack-2', [x(6), 1, z(-3)]), CENTER.reject));
    entities.push(withColor(bufferRack('pack-01', [x(18.5), 1, z(2)]), CENTER.pack));

    // ── 立体仓库：巷道两侧各一排高层货架，巷道口接一段出入库环线 ──
    const RACK = { halfW: 0.9, height: 4.5, zFront: 4, zBack: 13 } as const;
    const rackZ = (RACK.zFront + RACK.zBack) / 2;
    const rackLen = RACK.zBack - RACK.zFront;
    const rackY = RACK.height / 2; // 货架实体 y 取半高，模型才落在地面上
    const aisleXs = aisles >= 2 ? [8, 14] : [8];

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

      // 出入库环线：主干线 → 巷道口 → 折回主干线，四边都有皮带。
      // 支线同样躲拐角：z 0~0.7 由主干线托着，1.9~2.6 由巷道口横段托着，
      // 中间 0.7~1.9 这两小段接驳，彼此只贴边不叠面。
      const inX = aisleX - 2.5;
      beltZ(`belt-io-${aisleX}-in`, aisleX, 0.7, 1.9, `入库接驳 ${upper}`);
      beltX(`belt-io-${aisleX}-top`, inX, aisleX, 2.6, `巷道口 ${upper}`);
      beltZ(`belt-io-${aisleX}-out`, inX, 0.7, 1.9, `出库接驳 ${upper}`);

      const ioCorners: TwinVector3[] = [
        [x(aisleX), DECK_Y, z(0)],
        [x(aisleX), DECK_Y, z(2.6)],
        [x(inX), DECK_Y, z(2.6)],
        [x(inX), DECK_Y, z(0)],
      ];
      for (let i = 0; i < asrsCount; i += 1) {
        entities.push(
          parcel(`asrs-${aisleX}-cargo-${i + 1}`, splitClosedLoop(ioCorners, i / asrsCount), 0.9 + i * 0.12, {
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
        parcel(`ext-cargo-${i + 1}`, splitClosedLoop(extCorners, 0), 1.0 + i * 0.08, {
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
