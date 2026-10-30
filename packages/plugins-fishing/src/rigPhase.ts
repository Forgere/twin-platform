import type { FishingLayout } from './fishSim';
import { num, str } from './values';

/**
 * 钓组阶段（rig attrs.rigPhase）—— 线组此刻"实际挂成什么样"。
 *
 * 开钓向导的每一步对应真实调漂动作，线组的样子不一样：
 *   measure_t0   铅坠找底后推到半水、**不挂钩**：漂尾露出 t0 目
 *   measure_t    半水、**挂上双钩**（不挂饵）：露出 t 目
 *   measure_w    半水、双钩、**单钩挂一颗饵**：露出 t − w 目
 *   find_bottom  双饵到底、按钓目 d 摆放（和作钓时同一布局）
 *   setup        还没配好钓组（向导没走完）：线组挂着，但不抛竿
 *   fishing      正在钓：FishSim 按灵钝结算鱼口
 *
 * 只有 `fishing` 才抛竿结算；其余阶段只刷新布局。缺省视为 `fishing`，
 * 旧场景与不走向导的仿真（评测、方案对比）行为不变。
 */
export type RigPhase = 'setup' | 'measure_t0' | 'measure_t' | 'measure_w' | 'find_bottom' | 'fishing';

const PHASES: readonly RigPhase[] = ['setup', 'measure_t0', 'measure_t', 'measure_w', 'find_bottom', 'fishing'];

export function rigPhaseOf(attrs: Readonly<Record<string, unknown>> | undefined): RigPhase {
  const raw = str(attrs?.rigPhase, 'fishing');
  return (PHASES as readonly string[]).includes(raw) ? (raw as RigPhase) : 'fishing';
}

/** 测量阶段：线组吊在半水，按钓目摆放的布局不适用。 */
export const isMeasurePhase = (phase: RigPhase): boolean => phase === 'measure_t0' || phase === 'measure_t' || phase === 'measure_w';

/** 这一阶段线组上实际挂着什么——渲染据此决定显示哪些零件。 */
export interface RigParts {
  readonly hooks: boolean;
  readonly upperBait: boolean;
  readonly lowerBait: boolean;
}

export function rigPartsOf(phase: RigPhase): RigParts {
  if (phase === 'measure_t0') return { hooks: false, upperBait: false, lowerBait: false };
  if (phase === 'measure_t') return { hooks: true, upperBait: false, lowerBait: false };
  if (phase === 'measure_w') return { hooks: true, upperBait: false, lowerBait: true };
  return { hooks: true, upperBait: true, lowerBait: true };
}

const MARK_HEIGHT = 0.02; // 与 fishingLayout 一致：漂尾一目 ≈ 2cm
const LEAD_TO_SWIVEL = 0.1;
const SUBLINE_SHORT = 0.22;

/**
 * 测量阶段的布局：铅坠吊在半水，8 字环、双钩顺着重力笔直垂下；
 * 漂尾露出 `marks` 目（向导里用户当前点选的那一目，未点时按阶段给的参考值）。
 * 没挂的钩 / 饵收在 8 字环处，由渲染按 rigPartsOf 隐藏。
 */
export function measureLayout(
  marks: number,
  parts: RigParts,
  options: { surfaceY?: number; depth?: number; hookGap?: number } = {},
): FishingLayout {
  const surfaceY = options.surfaceY ?? 0;
  const depth = Math.max(0.2, options.depth ?? 2);
  const hookGap = Math.max(0.05, options.hookGap ?? 0.2);
  const scale = Math.min(1, depth / 2.2);
  const sinkerY = surfaceY - depth / 2;
  const swivelY = sinkerY - LEAD_TO_SWIVEL * scale;
  const upperHookY = parts.hooks ? swivelY - SUBLINE_SHORT * scale : swivelY;
  const lowerHookY = parts.hooks ? upperHookY - hookGap * scale : swivelY;
  const floatY = surfaceY - 0.1 + MARK_HEIGHT * Math.max(0, marks);
  return {
    float: [0, floatY, 0],
    sinker: [0, sinkerY, 0],
    swivel: [0, swivelY, 0],
    upperHook: [0, upperHookY, 0],
    lowerHook: [0, lowerHookY, 0],
    upperBait: [0, upperHookY, 0],
    lowerBait: [0, lowerHookY, 0],
  };
}

/** 测量阶段漂尾露出目数：向导写的 setupMarks 优先，否则按已知参数推出参考值。 */
export function measureMarks(phase: RigPhase, attrs: Readonly<Record<string, unknown>>): number {
  const t0 = num(attrs.t0, 4);
  const t = num(attrs.t, 2);
  const w = num(attrs.w, 1);
  const fallback = phase === 'measure_t0' ? t0 : phase === 'measure_t' ? t : t - w;
  return num(attrs.setupMarks, fallback);
}
