/**
 * 漂相动作：一口鱼在漂上"长什么样"。
 *
 * 纯函数、只做表现：输入漂相与这一口开始后的秒数，输出漂相对静止位的偏移。
 * 位置本身仍来自内核（fishingLayout），这里的偏移只加在浮漂模型的内层枢轴上，
 * 不写世界状态，所以不影响回放与方案对比。
 *
 * 幅度以"目"为单位（与 entityMeshes 里漂尾目节高度一致），读起来就是
 * "顿 1 目 / 顶 2 目 / 整支没入"。
 */

export type FloatSignalName = 'none' | 'nod' | 'lift' | 'sink' | 'run';

export interface FloatPose {
  /** 竖直偏移（米，正为上顶）。 */
  readonly dy: number;
  /** 横向偏移（米，走漂用）。 */
  readonly dx: number;
  /** 倾角（弧度，绕 Z）。 */
  readonly tilt: number;
}

/** 一目的高度（与 entityMeshes 的 FLOAT_MARK_H 相同）。 */
export const MARK = 0.08;
/** 一口的完整时长（秒）：动作 + 回位。 */
export const SIGNAL_DURATION = 1.6;

const REST: FloatPose = { dy: 0, dx: 0, tilt: 0 };
const ease = (x: number): number => x * x * (3 - 2 * x);
const clamp01 = (x: number): number => Math.min(Math.max(x, 0), 1);
/** 0→1 起、保持、1→0 落的包络。 */
const envelope = (t: number, rise: number, hold: number, fall: number): number => {
  if (t < rise) return ease(t / rise);
  if (t < rise + hold) return 1;
  return 1 - ease(clamp01((t - rise - hold) / fall));
};

export function floatSignalPose(signal: FloatSignalName, t: number): FloatPose {
  if (t < 0 || t >= SIGNAL_DURATION) return REST;
  switch (signal) {
    // 顿口：干脆地往下一顿约 1 目，稍停后慢慢回。
    case 'nod':
      return { dy: -MARK * envelope(t, 0.08, 0.25, 0.9), dx: 0, tilt: 0 };
    // 送漂：缓缓上顶 2 目，停住，再落回。
    case 'lift':
      return { dy: MARK * 2 * envelope(t, 0.5, 0.5, 0.5), dx: 0, tilt: 0 };
    // 黑漂：一口拉进水里，整支没入（漂尾 5 目 + 余量）。
    case 'sink':
      return { dy: -MARK * 7 * envelope(t, 0.2, 0.9, 0.45), dx: 0, tilt: 0 };
    // 走漂：横移并被线拉斜。
    case 'run': {
      const k = envelope(t, 0.5, 0.6, 0.45);
      return { dy: -MARK * 0.5 * k, dx: 0.25 * k, tilt: -0.3 * k };
    }
    default:
      return REST;
  }
}

/**
 * 漂最多被拉下去多少（米）：漂有浮力，鱼拖不动整副钓组——拖到这个深度就拖不动了，
 * 受力链据此缩短鱼的拖拽距离。顿口约 1 目多；黑漂整支没入（漂尾 + 漂身）；走漂以横移为主。
 */
export const MAX_FLOAT_DROP: Readonly<Record<FloatSignalName, number>> = {
  none: 0,
  nod: MARK * 1.2,
  lift: 0,
  sink: MARK * 7,
  run: MARK * 0.6,
};

/** 漂最多被横向拽开多少（米）：顿口 / 黑漂几乎只沉不走，走漂才横移。 */
export const MAX_FLOAT_SHIFT: Readonly<Record<FloatSignalName, number>> = {
  none: 0,
  nod: 0.02,
  lift: 0,
  sink: 0.05,
  run: 0.3,
};

export interface HookPull {
  /** 向外（远离另一只钩）的拖拽距离（米）。 */
  readonly out: number;
  /** 竖直偏移（米，正为上托）。 */
  readonly dy: number;
  /** 鱼甩头的抖动幅度（米），由调用方乘以高频正弦。 */
  readonly shake: number;
}

const NO_PULL: HookPull = { out: 0, dy: 0, shake: 0 };

/**
 * 同一口在水下的样子：鱼把被咬的那只钩（连饵）往哪拖——这是受力链（rigChain）的唯一驱动，
 * 漂的下顿 / 没入是被线拉出来的结果，不是自己动。与 floatSignalPose 同一时间轴，
 * 漂上的动作和钩上的动作一一对应：
 * - 顿口：鱼吸饵后往下 / 往外一拽 → 漂下顿；
 * - 送漂：鱼叼饵上浮，托起钩饵 → 子线松、漂上顶；
 * - 黑漂：鱼叼饵快速游走 → 钩被拉远、漂整支没入；
 * - 走漂：鱼叼饵横游 → 钩横向跟走。
 */
export function hookPullPose(signal: FloatSignalName, t: number): HookPull {
  if (t < 0 || t >= SIGNAL_DURATION) return NO_PULL;
  switch (signal) {
    case 'nod': {
      const k = envelope(t, 0.08, 0.25, 0.9);
      return { out: 0.35 * k, dy: 0.02 * k, shake: 0.012 * k };
    }
    case 'lift': {
      const k = envelope(t, 0.5, 0.5, 0.5);
      return { out: 0.04 * k, dy: 0.22 * k, shake: 0.006 * k };
    }
    case 'sink': {
      const k = envelope(t, 0.2, 0.9, 0.45);
      return { out: 1.1 * k, dy: 0.06 * k, shake: 0.02 * k };
    }
    case 'run': {
      const k = envelope(t, 0.5, 0.6, 0.45);
      return { out: 0.7 * k, dy: 0, shake: 0.01 * k };
    }
    default:
      return NO_PULL;
  }
}
