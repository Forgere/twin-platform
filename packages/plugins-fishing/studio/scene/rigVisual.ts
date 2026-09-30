import type { ContactState, RigPosture } from '@twin-platform/plugins-fishing';
import { floatSignalPose, hookPullPose, SIGNAL_DURATION, type FloatSignalName } from './floatSignal';

/**
 * 整副钓组的渲染姿态：浮漂以下每个零件"现在该是什么样"。
 *
 * 两个来源叠加：
 * 1. **调钓状态**（静态）：由 `rigPosture`（插件里的唯一真相）给出谁悬着 / 轻触底 / 躺底、
 *    子线弯多少——灵、钝、走铅在水下看起来必须不一样；
 * 2. **这一口**（动态）：漂相动作沿主线传下去——顿口 / 黑漂整条主线下移、送漂托起，
 *    被咬的下钩连饵被鱼拖走，它那根子线被拉直，饵被吸进鱼嘴。
 *
 * 纯函数、只做表现，不写世界状态；位置基准仍是内核的 fishingLayout。
 */

export interface HookVisual {
  /** 静止位竖直偏移（米）：送漂时随主线被托起。 */
  readonly dy: number;
  /** 躺倒程度 0~1：0 = 顺子线悬垂，1 = 平躺在底上。 */
  readonly lie: number;
}

export interface RigVisualPose {
  /** 这一口的强度 0~1（咬钩的鱼据此出现 / 离开）。 */
  readonly bite: number;
  /**
   * 送漂：鱼托起钩饵、铅坠的重量被卸掉一部分，漂上浮、主线随之上移（米，≥ 0）。
   * 顿口 / 黑漂不在这里——它们是鱼拖钩、经受力链（rigChain）拉下来的。
   */
  readonly floatLift: number;
  readonly mainLift: number;
  /**
   * 走水：主线倾角的正切（0 = 静水）。漂座以下每个点按 `flowOffset` 往下游推，越深推得越远；
   * 加铅（antiDrift）后倾角减半。
   */
  readonly flowTan: number;
  /** 铅坠躺倒程度 0~1（走铅时平躺在底上）。 */
  readonly sinkerLie: number;
  readonly hooks: { readonly upper: HookVisual; readonly lower: HookVisual };
  /** 鱼把被咬的钩往哪拖：向外（米）/ 向上（米）/ 甩头抖动幅度（米）。受力链的唯一驱动。 */
  readonly drag: { readonly out: number; readonly dy: number; readonly shake: number };
  /** 饵的竖向比例：躺底被压扁、被鱼吸入变小。 */
  readonly baits: { readonly upper: number; readonly lower: number };
  /** 静止时的子线弯曲 0~1（来自调钓状态）；被拖时的弯曲由受力链按弧长守恒解出。 */
  readonly bend: { readonly upper: number; readonly lower: number };
}

const LIE: Readonly<Record<ContactState, number>> = { suspended: 0, touching: 0.35, on_bottom: 1 };
const SQUASH: Readonly<Record<ContactState, number>> = { suspended: 1, touching: 0.85, on_bottom: 0.6 };

const contactOf = (posture: RigPosture, part: 'hookUpper' | 'hookLower' | 'baitUpper' | 'baitLower'): ContactState => {
  const code = posture.parts.find((item) => item.part === part)?.code;
  return code === 'touching' || code === 'on_bottom' ? code : 'suspended';
};

/** 走水时某一深度的点被推向下游多远（米）：漂座以上不动，以下按深度线性增加。 */
export function flowOffset(anchorY: number, y: number, flowTan: number): number {
  return Math.max(0, anchorY - y) * flowTan;
}

/**
 * 走水时漂的晃动（米）：几路不成倍数的正弦叠加，读起来像水流乱推，不像规则摆动；
 * 偶尔叠出一次"假口"般的下沉——插件里"走水信号乱"在画面上的样子。
 * 用渲染时钟、不用随机数，同一时刻总是同一姿态。
 */
export function driftWobble(time: number, flowTan: number): { readonly dx: number; readonly dy: number } {
  if (flowTan <= 0) return { dx: 0, dy: 0 };
  const k = Math.min(1, flowTan * 4);
  const dx = 0.035 * k * (Math.sin(time * 0.9) + 0.6 * Math.sin(time * 2.3 + 1.1));
  const surge = Math.max(0, Math.sin(time * 0.37 + 0.4)) ** 12;
  const dy = k * (0.012 * Math.sin(time * 1.7 + 0.5) - 0.06 * surge);
  return { dx, dy };
}

export function rigVisualPose(
  posture: RigPosture,
  signal: FloatSignalName,
  t: number,
  env: { readonly antiDrift?: boolean; readonly bitten?: 'upper' | 'lower' } = {},
): RigVisualPose {
  const active = t >= 0 && t < SIGNAL_DURATION;
  const pull = active ? hookPullPose(signal, t) : { out: 0, dy: 0, shake: 0 };
  // 这一口的强度 0~1：拖得越狠，躺着的钩越被提起来、饵越被吸进去。
  const bite = Math.min(1, (Math.abs(pull.out) + Math.abs(pull.dy)) / 0.1);
  // 只有送漂是"往上"的：钩饵被托起，漂失去一部分负重上浮。
  const floatLift = active && signal === 'lift' ? Math.max(0, floatSignalPose(signal, t).dy) : 0;
  const mainLift = floatLift * 0.8;

  // 插件里铅坠的 touching 只表示"底上已有承重"，铅坠本身仍悬着——只有 on_bottom 才算躺底。
  const sinkerGrounded = posture.sinker.code === 'on_bottom';
  const sinkerLie = sinkerGrounded ? Math.max(0, 1 - mainLift / 0.1) : 0;
  const hookUpperContact = contactOf(posture, 'hookUpper');
  const hookLowerContact = contactOf(posture, 'hookLower');

  // 被咬的那只钩（默认下钩）：躺着的被提起、饵被吸入；另一只不受这一口直接影响。
  const bitten = env.bitten ?? 'lower';
  const biteOn = (hook: 'upper' | 'lower'): number => (hook === bitten ? bite : 0);
  const flowTan = Math.tan((posture.mainLine.tiltDeg * (env.antiDrift ? 0.5 : 1) * Math.PI) / 180);

  return {
    bite,
    flowTan,
    floatLift,
    mainLift,
    sinkerLie,
    hooks: {
      upper: { dy: hookUpperContact === 'suspended' ? mainLift : 0, lie: LIE[hookUpperContact] * (1 - biteOn('upper')) },
      lower: { dy: hookLowerContact === 'suspended' ? mainLift : 0, lie: LIE[hookLowerContact] * (1 - biteOn('lower')) },
    },
    drag: pull,
    baits: {
      upper: SQUASH[contactOf(posture, 'baitUpper')] * (1 - biteOn('upper')) + 0.55 * biteOn('upper'),
      lower: SQUASH[contactOf(posture, 'baitLower')] * (1 - biteOn('lower')) + 0.55 * biteOn('lower'),
    },
    bend: { upper: posture.subLineUpper.bend, lower: posture.subLineLower.bend },
  };
}
