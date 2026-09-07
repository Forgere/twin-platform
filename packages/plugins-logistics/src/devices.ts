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
}

/**
 * 在制物料：沿 `path` 以 `speed` m/s 循环前进（内核按 `loop: 'repeat'` 自动搬运）。
 * 行为插件靠检测"绕回起点"来发 `parcel:enter` / `parcel:exit`。
 */
export function parcel(id: string, path: TwinVector3[], speed: number, options: ParcelOptions = {}): TwinEntity {
  return {
    id,
    kind: 'parcel',
    transform: { position: path[0] ?? [0, 0, 0] },
    capabilities: ['parcel'],
    visual: { kind: 'box', color: options.color ?? '#f97316', size: options.size ?? [0.6, 0.6, 0.6] },
    motion: { points: path, speed, loop: 'repeat', cornerRadius: 0 },
    config: { label: options.label ?? id },
  };
}
