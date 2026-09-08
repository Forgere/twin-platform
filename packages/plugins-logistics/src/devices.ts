import type { TwinEntity, TwinVector3 } from '@twin-platform/scene-schema';

/**
 * 物流设备实体工厂。
 *
 * 这里只产出"声明"（TwinEntity），不产逻辑——逻辑全在 `behavior.ts`。
 * 设备语义被拆成三类能力：`move`（输送）、`inspect`（检测）、`store`/`buffer`（缓存）、
 * `sort`（分拣）。内核不认这些词，只认 `capabilities` 数组，所以加一种新设备
 * 不必动内核，只在这里加一个工厂。
 */

export interface ConveyorOptions {
  label?: string;
  color?: string;
  size?: TwinVector3;
}

/** 一段静态输送线（无自身运动，只作视觉与设备占位）。 */
export function conveyorSegment(id: string, position: TwinVector3, options: ConveyorOptions = {}): TwinEntity {
  return {
    id,
    kind: 'transport',
    transform: { position },
    capabilities: ['move'],
    visual: { kind: 'box', color: options.color ?? '#22c55e', size: options.size ?? [3, 0.6, 1.4] },
    config: { label: options.label ?? id },
  };
}

/** 视觉检测站：有 `zoneHalfWidth` 表示它"罩"住中心线两侧多远。 */
export function inspectionStation(id: string, position: TwinVector3, zoneHalfWidth = 1.6): TwinEntity {
  return {
    id,
    kind: 'inspect',
    transform: { position },
    capabilities: ['inspect'],
    visual: { kind: 'box', color: '#38bdf8', size: [1.6, 1.6, 1.6] },
    config: { label: id, zoneHalfWidth },
  };
}

/** 缓存货架：能存料，没有覆盖区（不占中心线）。 */
export function bufferRack(id: string, position: TwinVector3): TwinEntity {
  return {
    id,
    kind: 'buffer',
    transform: { position },
    capabilities: ['store', 'buffer'],
    visual: { kind: 'box', color: '#f59e0b', size: [2.2, 2, 1.8] },
    config: { label: id },
  };
}

export interface ParcelOptions {
  label?: string;
  color?: string;
  size?: TwinVector3;
  /** 折角圆角半径：闭环路径给 0.2~0.8 才能拐出圆角，0 是尖角。 */
  cornerRadius?: number;
}

/**
 * 在制物料：沿 `path` 以 `speed` m/s 循环前进（内核按 `loop: 'repeat'` 自动搬运）。
 * 行为插件靠检测"绕回起点"来发 `parcel:enter` / `parcel:exit`。
 *
 * 注意：`path` 必须首尾闭合（最后一个点等于第一个点），否则 `loop: 'repeat'`
 * 会让物料从终点瞬移回起点——那看起来就是"货物脱线乱飞"。
 */
export function parcel(id: string, path: TwinVector3[], speed: number, options: ParcelOptions = {}): TwinEntity {
  return {
    id,
    kind: 'parcel',
    transform: { position: path[0] ?? [0, 0, 0] },
    capabilities: ['parcel'],
    visual: { kind: 'box', color: options.color ?? '#f97316', size: options.size ?? [0.6, 0.6, 0.6] },
    motion: { points: path, speed, loop: 'repeat', cornerRadius: options.cornerRadius ?? 0 },
    config: { label: options.label ?? id },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 立体仓库（AS/RS）
// ─────────────────────────────────────────────────────────────────────────

export interface AsrsRackOptions {
  label?: string;
  color?: string;
  /** 货位层数，默认 5。 */
  levels?: number;
  /** 沿长边的货位数，默认按长度推。 */
  bays?: number;
}

/**
 * 高层货架：一座立体仓库的货架排。`size` 为 [宽(X), 高(Y), 长(Z)]，
 * 长边即货架延伸方向（巷道在它侧面）。
 *
 * 只声明几何与能力，不声明运动——它不动，动的是堆垛机。
 */
export function asrsRack(
  id: string,
  position: TwinVector3,
  size: TwinVector3,
  options: AsrsRackOptions = {},
): TwinEntity {
  return {
    id,
    kind: 'asrs',
    transform: { position },
    capabilities: ['rack'],
    visual: { kind: 'box', color: options.color ?? '#B5EAD7', size },
    config: {
      label: options.label ?? id,
      levels: options.levels ?? 5,
      bays: options.bays ?? Math.max(2, Math.round(Math.max(size[0], size[2]) / 1.8)),
    },
  };
}

/** 堆垛机运行循环参数，全部放在 config 里，行为只读不写。 */
export interface StackerCycleConfig {
  /** 巷道中心线 X。 */
  aisleX: number;
  /** 出入库交接点 Z（巷道口）。 */
  ioZ: number;
  /** 交接高度 Y（与输送线台面齐平）。 */
  ioY: number;
  /** 货架区起止 Z。 */
  zMin: number;
  zMax: number;
  /** 可取货位高度（Y）。 */
  levels: number[];
  /** 目标列数（沿 Z 均分）。 */
  columns: number;
  /** 一个完整存取循环的秒数。 */
  cycle: number;
  /** 相位偏移 0~1，用来让两台堆垛机错开。 */
  phase: number;
  /** 货叉最大伸出距离。 */
  reach: number;
  /** 左/右两侧货架的货位 X。 */
  forkX: [number, number];
}

export interface StackerOptions {
  label?: string;
  color?: string;
  cycle: StackerCycleConfig;
}

/** 堆垛机门架：沿巷道（Z）行走，高度固定，载货台与货叉由行为单独驱动。 */
export function stackerCrane(id: string, position: TwinVector3, options: StackerOptions): TwinEntity {
  return {
    id,
    kind: 'stacker',
    transform: { position },
    capabilities: ['stacker'],
    visual: { kind: 'box', color: options.color ?? '#C4B5E0', size: [1, 5.4, 1.6] },
    config: { label: options.label ?? id, ...options.cycle },
  };
}

/** 载货台：跟着门架走 Z，同时沿立柱升到货位高度。 */
export function stackerCarriage(id: string, position: TwinVector3, color?: string, label?: string): TwinEntity {
  return {
    id,
    kind: 'carriage',
    transform: { position },
    capabilities: ['carriage'],
    visual: { kind: 'box', color: color ?? '#C4B5E0', size: [0.92, 0.34, 1.2] },
    config: { label: label ?? id },
  };
}

/** 货叉：跟着载货台升降，并沿 X 伸进货架取放。 */
export function stackerFork(id: string, position: TwinVector3, color?: string, label?: string): TwinEntity {
  return {
    id,
    kind: 'fork',
    transform: { position },
    capabilities: ['fork'],
    visual: { kind: 'box', color: color ?? '#8BD3C7', size: [1.1, 0.14, 0.9] },
    config: { label: label ?? id },
  };
}

/** 堆垛机上的托盘/料箱：取货时贴在货叉上，空程时停在巷道口的交接位。 */
export function pallet(id: string, position: TwinVector3, color?: string, label?: string): TwinEntity {
  return {
    id,
    kind: 'pallet',
    transform: { position },
    capabilities: ['pallet'],
    visual: { kind: 'box', color: color ?? '#FFDAC1', size: [0.8, 0.56, 1] },
    config: { label: label ?? id },
  };
}
