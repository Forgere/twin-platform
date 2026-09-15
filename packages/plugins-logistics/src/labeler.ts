import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';
import { num, str } from './geometry';

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
      for (const machine of ctx.entities) {
        if (!machine.capabilities.includes(labelerCap)) continue;
        const conf = machine.config ?? {};
        const radius = Math.max(0.1, num(conf.radius, 1.2));
        const cargoCap = str(conf.cargoCapability, 'pallet');
        // 只看 XZ 平面距离：打标机罩在皮带上方，货物高度随托盘/皮带变，不算进去。
        const mx = machine.transform.position[0];
        const mz = machine.transform.position[2];

        for (const cargo of ctx.entities) {
          if (!cargo.capabilities.includes(cargoCap)) continue;
          if (cargo.attrs.labeled === true) continue;
          const dx = cargo.transform.position[0] - mx;
          const dz = cargo.transform.position[2] - mz;
          if (dx * dx + dz * dz > radius * radius) continue;
          ctx.setAttr(cargo.id, 'labeled', true);
          ctx.setAttr(cargo.id, 'labelBy', machine.id);
          ctx.emit(applyType, { entityId: machine.id, payload: { cargo: cargo.id } });
        }
      }
    },
  };
}
