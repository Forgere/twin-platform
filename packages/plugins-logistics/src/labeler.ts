import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';
import { bucketEntities, neighborsWithinRadius, num, str } from './geometry';

/**
 * 打标机：输送线**经过式**工位——货从龙门底下过一次就贴一张标签。
 *
 * 只做两件事，都是"读位置 → 写状态"，不碰位姿，所以和驱动托盘的行为
 * （打包出料带上由 `asrs-cycle` 的 advanceConveying 写位姿）不打架。
 *
 * 每块货只贴一次：`labeled` 一旦打上就不再触发，避免货在工位附近来回时
 * 反复贴标。货被卡车拉走（despawn）后新货有新的 id，会重新走一遍这个流程。
 *
 * 确定性：只看实体位置与 attrs，不碰 `ctx.rng`、不读挂钟。
 */

export interface LabelerConfig {
  /** 打标机的能力标记，默认 `labeler`。 */
  labelerCapability?: string;
  /** 贴标事件类型，默认 `label:applied`。 */
  applyType?: string;
}

export function createLabelerBehavior(config: LabelerConfig = {}): WorldBehavior {
  const labelerCap = config.labelerCapability ?? 'labeler';
  const applyType = config.applyType ?? 'label:applied';

  return {
    id: 'labeler-cycle',
    step(ctx: BehaviorContext): void {
      const machines = ctx.entities.filter((entity) => entity.capabilities.includes(labelerCap));
      if (machines.length === 0) return;

      // 网格 cell 取所有打标机里最大的认领半径：保证任一台机查邻桶时不会漏掉
      // 半径内的货（同时把相距数百米的其它副本实体隔在远处桶里，O(N²) → O(N)）。
      let maxRadius = 1.2;
      for (const machine of machines) {
        maxRadius = Math.max(maxRadius, Math.max(0.1, num(machine.config?.radius, 1.2)));
      }
      const grid = bucketEntities(ctx.entities, maxRadius);

      for (const machine of machines) {
        const conf = machine.config ?? {};
        const radius = Math.max(0.1, num(conf.radius, 1.2));
        const cargoCap = str(conf.cargoCapability, 'pallet');
        // 只看 XZ 平面距离：打标机罩在皮带上方，货物高度随托盘/皮带变，不算进去。
        const mx = machine.transform.position[0];
        const mz = machine.transform.position[2];

        for (const cargo of neighborsWithinRadius(grid, mx, mz, maxRadius, radius)) {
          if (!cargo.capabilities.includes(cargoCap)) continue;
          if (cargo.attrs.labeled === true) continue;
          ctx.setAttr(cargo.id, 'labeled', true);
          ctx.setAttr(cargo.id, 'labelBy', machine.id);
          ctx.emit(applyType, { entityId: machine.id, payload: { cargo: cargo.id } });
        }
      }
    },
  };
}
