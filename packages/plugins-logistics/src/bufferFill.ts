import type { BehaviorContext, WorldBehavior, WorldEntityState } from '@twin-platform/world-kernel';
import { bucketEntities, neighborsWithinRadius } from './geometry';

/**
 * 缓存货架填充行为（P1 的"货物等待"可视化来源）。
 *
 * 内核只管搬运，本行为负责把"哪台缓存架前堆了多少货"算成一个 0..1 的 `fill`，
 * 由渲染层按 `fill` 点亮对应数量的货位（见 entityMeshes.ts 的 `buildRack`）。
 *
 * 设计要点：
 * - 纯确定性：只读实体位置，不碰 `ctx.rng`、不读挂钟；
 * - 不主动发事件，只写 `attrs.fill`，避免和流转/忙闲事件抢日志；
 * - 量化成 8 档（与渲染层货位数量一致），只有档位变化才写，避免每步刷帧差量；
 * - 把"等待"从抽象指标变成看得见的堆货——这正是 vivid-factory 那套
 *   "状态进渲染"的打法，原来 twin-platform 缺的就是这一环。
 */

export interface BufferFillConfig {
  /** 视为缓存架的能力标记，默认 `buffer`。 */
  bufferCapability?: string;
  /** 包裹实体的能力标记，默认 `parcel`。 */
  parcelCapability?: string;
  /** 以缓存架中心为原点的检测半径（米）。 */
  radius?: number;
  /** 满架对应的包裹数（= 渲染层货位数），默认 8。 */
  capacity?: number;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export function createBufferFillBehavior(config: BufferFillConfig = {}): WorldBehavior {
  const bufferCap = config.bufferCapability ?? 'buffer';
  const parcelCap = config.parcelCapability ?? 'parcel';
  const radius = config.radius ?? 2.4;
  const capacity = config.capacity ?? 8;
  const steps = capacity;

  return {
    id: 'buffer-fill',
    step(ctx: BehaviorContext): void {
      const buffers: WorldEntityState[] = [];
      const parcels: WorldEntityState[] = [];
      for (const entity of ctx.entities) {
        if (entity.capabilities.includes(bufferCap)) buffers.push(entity);
        else if (entity.capabilities.includes(parcelCap) || entity.kind === 'parcel') parcels.push(entity);
      }
      if (buffers.length === 0) return;

      // 按位置把货物哈希进网格（cell = 检测半径）：每台缓存架只查自己附近的货，
      // 不再扫全部货物（buffers × parcels = O(N²)，副本翻倍时平方级恶化）。
      const grid = bucketEntities(parcels, radius);

      for (const buffer of buffers) {
        const bx = buffer.transform.position[0];
        const bz = buffer.transform.position[2];
        let count = 0;
        for (const parcel of neighborsWithinRadius(grid, bx, bz, radius, radius)) {
          count += 1;
        }
        // 量化成 capacity 档：只有档位变了才写，避免每步产生帧差量。
        const fill = Math.min(count, capacity) / capacity;
        const quantized = Math.round(fill * steps) / steps;
        if (num(buffer.attrs.__fill, -1) !== quantized) {
          ctx.setAttr(buffer.id, 'fill', quantized);
          ctx.setAttr(buffer.id, '__fill', quantized);
        }
      }
    },
  };
}
