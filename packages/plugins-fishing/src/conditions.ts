import { num } from './values';

/**
 * 钓场情况（conditions）—— 钓着钓着会变的外部状况，和钓组参数分开。
 *
 * 场景模板把初值写在 rig 的 config 里；运行中"起风走水 / 小鱼闹窝 / 降温"
 * 这类变化写进 rig 的 **attrs**（可回放、可 seek、随快照恢复），读的时候
 * attrs 优先、config 兜底——老场景只有 config 也照常工作。
 */

export interface PondConditions {
  /** 走水：水流拉斜主线、漂走位，鱼口变少、信号变乱。 */
  readonly drift: boolean;
  /** 水温（℃）。 */
  readonly waterTemperature: number;
  /** 小鱼闹窝：口多但多是偷饵，中鱼率大跌。 */
  readonly smallFish: boolean;
  /** 已加铅抗流：走水的影响大幅减弱（代价是钓组更钝，见 applyFishingDecision）。 */
  readonly antiDrift: boolean;
  /** 窝料有效期至（仿真秒）；在此之前咬钩率上浮。 */
  readonly nestUntil: number;
}

/** 情况的 attrs 键（UI 注入情况时写这些键）。 */
export const CONDITION_ATTRS = ['drift', 'waterTemperature', 'smallFish', 'antiDrift', 'nestUntil'] as const;

const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

export function conditionsOf(entity: {
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly config?: Readonly<Record<string, unknown>>;
}): PondConditions {
  const attrs = entity.attrs ?? {};
  const config = entity.config ?? {};
  return {
    drift: flag(attrs.drift) ?? flag(config.drift) ?? false,
    waterTemperature: num(attrs.waterTemperature, num(config.waterTemperature, 20)),
    smallFish: flag(attrs.smallFish) ?? flag(config.smallFish) ?? false,
    antiDrift: flag(attrs.antiDrift) ?? false,
    nestUntil: num(attrs.nestUntil, 0),
  };
}

export interface ConditionMultipliers {
  readonly bite: number;
  readonly hook: number;
}

/**
 * 情况对鱼口的倍率。纯函数：
 * - 走水：口少、信号乱（没加铅时尤其明显）；
 * - 小鱼闹窝：口变多，但几乎都是偷饵；
 * - 窝料在效：诱鱼，口上浮。
 */
export function conditionMultipliers(conditions: PondConditions, time: number): ConditionMultipliers {
  let bite = 1;
  let hook = 1;
  if (conditions.drift) {
    bite *= conditions.antiDrift ? 0.9 : 0.55;
    hook *= conditions.antiDrift ? 0.95 : 0.7;
  }
  if (conditions.smallFish) {
    bite *= 1.7;
    hook *= 0.35;
  }
  if (time < conditions.nestUntil) bite *= 1.3;
  return { bite, hook };
}
