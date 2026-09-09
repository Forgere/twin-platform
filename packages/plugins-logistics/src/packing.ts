import type { BehaviorContext, WorldBehavior, WorldEntityState } from '@twin-platform/world-kernel';

/**
 * 装盒行为：小盒子到达 pack（装盒/等待）工位时，被"装盒"成大箱子。
 *
 * 内核是纯运动学（沿 path 搬运），没有"到终点被消费、并生成新实体"的语义；
 * 之前 pack-01 只是 buffer-fill 的堆积可视化（看起来像大箱），但小盒子本身
 * 仍在闭环上绕圈（"回去"）。本行为把"装盒"提升为一等公民：进入 pack 工位即
 * 标记 `boxed=true` 并发 `parcel:packed`，供渲染层放大成"大箱子"与 HUD/指标消费。
 *
 * 配合产线改成开放路径（loop:'none'、终点停在 pack-01），小盒子到达即停、不再绕回。
 * 真正的"小箱消失、大箱另起一条出料线"需要内核在 BehaviorContext 暴露
 * addEntity/removeEntity（当前未暴露）；此处先用"标记 + 事件"建模装盒语义。
 *
 * 纯确定性：只读位置，不碰 rng / 挂钟。
 */

export interface PackingConfig {
  /** 视为装盒工位的能力标记，默认 `pack`。 */
  packCapability?: string;
  /** 包裹实体的能力标记，默认 `parcel`。 */
  parcelCapability?: string;
  /** 以装盒工位中心为原点的检测半径（米），默认 2.4。 */
  radius?: number;
}

export function createPackingBehavior(config: PackingConfig = {}): WorldBehavior {
  const packCap = config.packCapability ?? 'pack';
  const parcelCap = config.parcelCapability ?? 'parcel';
  const radius = config.radius ?? 2.4;

  return {
    id: 'packing',
    step(ctx: BehaviorContext): void {
      const stations: WorldEntityState[] = [];
      const parcels: WorldEntityState[] = [];
      for (const entity of ctx.entities) {
        if (entity.capabilities.includes(packCap)) stations.push(entity);
        else if (entity.capabilities.includes(parcelCap)) parcels.push(entity);
      }
      if (stations.length === 0) return;

      const r2 = radius * radius;
      for (const parcel of parcels) {
        if (parcel.attrs.boxed === true) continue; // 已装盒，跳过（避免每步重复发事件）
        const px = parcel.transform.position[0];
        const pz = parcel.transform.position[2];
        const hit = stations.some((s) => {
          const dx = px - s.transform.position[0];
          const dz = pz - s.transform.position[2];
          return dx * dx + dz * dz <= r2;
        });
        if (hit) {
          ctx.setAttr(parcel.id, 'boxed', true);
          ctx.emit('parcel:packed', { entityId: parcel.id, station: stations[0]!.id });
        }
      }
    },
  };
}
