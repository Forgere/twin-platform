import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';

/**
 * 顶升移栽机的顶升循环行为。
 *
 * 和 `asrs-cycle` 的分工不同：那条是时间的纯函数（自己造运动），
 * 这条是**事件驱动**的——它读内核搬出来的货物位置，判断"该不该顶"。
 *
 * 判据来自场景模板声明的 `divertIds`：只有表里的货到跟前才顶升，
 * 其余货物直着滚过去。这样"谁拐弯"这件事由场景说了算，行为不用猜。
 *
 * 检测区沿来料方向（-X）前伸一段，货物还没上台面就开始顶，
 * 否则等它已经拐弯了才抬，看着像被拽过去的。
 */

export interface TransferBehaviorConfig {
  /** 移栽机实体的能力标记，默认 `transfer`。 */
  capability?: string;
  /** 托举座实体的 id 后缀，默认 `-cassette`。 */
  cassetteSuffix?: string;
  /** 分流事件类型。 */
  divertType?: string;
  /** 检测区沿来料方向前伸的距离（米），用于提前顶升。 */
  lead?: number;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const strList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

export function createTransferBehavior(config: TransferBehaviorConfig = {}): WorldBehavior {
  const capability = config.capability ?? 'transfer';
  const cassetteSuffix = config.cassetteSuffix ?? '-cassette';
  const divertType = config.divertType ?? 'transfer:divert';
  const defaultLead = config.lead ?? 0.7;

  return {
    id: 'transfer-cycle',
    step(ctx: BehaviorContext): void {
      for (const unit of ctx.entities) {
        if (!unit.capabilities.includes(capability)) continue;

        const conf = unit.config ?? {};
        const liftHeight = num(conf.liftHeight, 0.13);
        const upTime = Math.max(1e-3, num(conf.upTime, 0.18));
        const downTime = Math.max(1e-3, num(conf.downTime, 0.18));
        const divertIds = strList(conf.divertIds);
        if (divertIds.length === 0) continue;

        const [ux, uy, uz] = unit.transform.position;
        const size = unit.visual?.size ?? [1.6, 0.6, 1.4];
        const halfX = (size[0] ?? 1.6) / 2;
        const halfZ = (size[2] ?? 1.4) / 2;

        // 检测区：台面沿来料方向前伸 lead，货物还在皮带上就开始顶升。
        let diverting: string | undefined;
        for (const id of divertIds) {
          const parcel = ctx.entity(id);
          if (!parcel) continue;
          const [px, , pz] = parcel.transform.position;
          if (px < ux - halfX - defaultLead || px > ux + halfX) continue;
          if (Math.abs(pz - uz) > halfZ) continue;
          diverting = id;
          break;
        }

        // 顶升高度 0→1 匀速趋近目标，启停不瞬跳。
        const lift = num(unit.attrs.__lift, 0);
        const target = diverting ? 1 : 0;
        const rate = ctx.dt / (target > lift ? upTime : downTime);
        const next =
          lift < target ? Math.min(target, lift + rate) : lift > target ? Math.max(target, lift - rate) : lift;
        ctx.setAttr(unit.id, '__lift', next);

        const cassette = ctx.entity(`${unit.id}${cassetteSuffix}`);
        if (cassette) {
          ctx.setTransform(cassette.id, { position: [ux, uy + next * liftHeight, uz] });
        }

        ctx.setStatus(unit.id, next > 0.5 ? 'busy' : 'idle');

        // 每次"顶到位"只发一次，落到原位后重新武装。
        const armed = unit.attrs.__armed !== false;
        if (next >= 0.999 && armed && diverting) {
          ctx.emit(divertType, {
            entityId: unit.id,
            payload: { parcelId: diverting, height: liftHeight, lift: next },
          });
          ctx.setAttr(unit.id, '__armed', false);
        }
        if (next <= 0.001 && !armed) ctx.setAttr(unit.id, '__armed', true);
      }
    },
  };
}
