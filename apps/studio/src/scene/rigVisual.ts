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
  /** 向外（远离另一只钩）的拖拽距离（米）。 */
  readonly out: number;
  readonly dy: number;
  /** 躺倒程度 0~1：0 = 顺子线悬垂，1 = 平躺在底上。 */
  readonly lie: number;
  /** 抖动幅度（米），调用方乘高频正弦。 */
  readonly shake: number;
}

export interface RigVisualPose {
  /** 主线整体下移 / 上托量（米），铅坠与 8 字环跟着走。 */
  readonly mainDy: number;
  /** 铅坠躺倒程度 0~1（走铅时平躺在底上）。 */
  readonly sinkerLie: number;
  readonly hooks: { readonly upper: HookVisual; readonly lower: HookVisual };
  /** 饵的竖向比例：躺底被压扁、被鱼吸入变小。 */
  readonly baits: { readonly upper: number; readonly lower: number };
  /** 这一口的强度 0~1（咬钩的鱼据此出现 / 离开）。 */
  readonly bite: number;
  /** 子线弯曲 0~1（被咬那根会被拉直）。 */
  readonly bend: { readonly upper: number; readonly lower: number };
}

const LIE: Readonly<Record<ContactState, number>> = { suspended: 0, touching: 0.35, on_bottom: 1 };
const SQUASH: Readonly<Record<ContactState, number>> = { suspended: 1, touching: 0.85, on_bottom: 0.6 };

const contactOf = (posture: RigPosture, part: 'hookUpper' | 'hookLower' | 'baitUpper' | 'baitLower'): ContactState => {
  const code = posture.parts.find((item) => item.part === part)?.code;
  return code === 'touching' || code === 'on_bottom' ? code : 'suspended';
};

/** 零件能跟主线走多少：悬着的全跟；贴底的只能被往上提，不能再往下钻。 */
const follow = (contact: ContactState, dy: number): number => (contact === 'suspended' || dy > 0 ? dy : 0);

export function rigVisualPose(posture: RigPosture, signal: FloatSignalName, t: number): RigVisualPose {
  const active = t >= 0 && t < SIGNAL_DURATION;
  const floatDy = active ? floatSignalPose(signal, t).dy : 0;
  const pull = active ? hookPullPose(signal, t) : { out: 0, dy: 0, shake: 0 };
  // 这一口的强度 0~1：拖拽越狠，子线越直、饵越被吸进去、躺着的钩越被提起来。
  const bite = Math.min(1, (Math.abs(pull.out) + Math.abs(pull.dy)) / 0.1);

  // 主线传力：走铅（铅坠躺底）时往下拽不动主线，只能被托起来。
  // 插件里铅坠的 touching 只表示"底上已有承重"，铅坠本身仍悬着——只有 on_bottom 才算躺底。
  const sinkerGrounded = posture.sinker.code === 'on_bottom';
  const mainDy = follow(sinkerGrounded ? 'on_bottom' : 'suspended', floatDy * (floatDy > 0 ? 0.8 : 1));
  const sinkerLie = sinkerGrounded ? Math.max(0, 1 - Math.max(0, mainDy) / 0.1) : 0;

  const hookUpperContact = contactOf(posture, 'hookUpper');
  const hookLowerContact = contactOf(posture, 'hookLower');

  return {
    bite,
    mainDy,
    sinkerLie,
    hooks: {
      upper: { out: 0, dy: follow(hookUpperContact, mainDy), lie: LIE[hookUpperContact], shake: 0 },
      lower: {
        out: pull.out,
        dy: follow(hookLowerContact, mainDy) + pull.dy,
        lie: LIE[hookLowerContact] * (1 - bite),
        shake: pull.shake,
      },
    },
    baits: {
      upper: SQUASH[contactOf(posture, 'baitUpper')],
      lower: SQUASH[contactOf(posture, 'baitLower')] * (1 - bite) + 0.55 * bite,
    },
    bend: {
      upper: posture.subLineUpper.bend,
      lower: posture.subLineLower.bend * (1 - bite),
    },
  };
}
