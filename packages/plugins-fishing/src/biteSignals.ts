import type { RigZone } from './fishingCore';
import type { FishId } from './loadout';
import type { FloatSignal } from './rigPosture';

/**
 * 漂相权重模型（biteSignals）—— 有口的那一口"长什么样"，由状态算出来，不再等概率。
 *
 * 分工：`rigPosture` 定义漂相是什么（类型与文案），这里定义**什么时候出什么漂相**。
 * FishSim 每次咬钩用 `ctx.rng.weighted()` 按权重取一个——与原来的等概率 pick
 * 消耗同样一次随机数，回放兼容性不变（同种子仍逐帧一致）。
 *
 * 台钓常识（量级正确，不是实验室数据；出处见 `references/rig-spec.md`）：
 * - **顿口（nod）**：灵区信号被放大，短促下顿——好看但窗口短，空竿多；
 * - **黑漂（sink）**：钝区或大鱼沉稳拉动，整支没入——窗口长，等得起；
 * - **送漂（lift）**：钩饵离底后鱼上浮带线——离底流派（off_bottom）的信号；
 * - **移漂（run）**：走水把主线拉斜，漂横着走——**只有走水时才会出现**，
 *   因为"没有抗流铅时鱼口和走漂混在一起"正是走水最烦人的地方。
 *
 * 鱼种修正（台钓经验，量级）：鲫鱼口轻灵敏（顿口多）、鲤鱼口大沉稳（黑漂多）、
 * 草鱼个大（顿口黑漂都多）、罗非抢口猛（顿口与移漂多）。
 */

/** 全部候选漂相。权重为 0 的项不会被 weighted() 选中。 */
export const BITE_SIGNAL_POOL: readonly FloatSignal[] = ['nod', 'lift', 'sink', 'run'];

/** 参与加权的漂相（none 不是漂相，是"没有口"）。 */
export type BiteSignal = Exclude<FloatSignal, 'none'>;

/**
 * 分区基础权重。run 在静水（不走水）时恒为 0——移漂是走水的专属信号。
 * 走水时另见 `signalWeight`：run 被拉起，其余信号被"糊"掉（信号乱）。
 */
const ZONE_SIGNAL_WEIGHTS: Readonly<Record<RigZone, Readonly<Record<BiteSignal, number>>>> = {
  off_bottom: { nod: 0.2, lift: 1.6, sink: 0.2, run: 0 },
  sensitive: { nod: 1.6, lift: 0.5, sink: 0.3, run: 0 },
  neutral: { nod: 1.0, lift: 1.0, sink: 1.0, run: 0 },
  blunt: { nod: 0.4, lift: 0.5, sink: 1.6, run: 0 },
  sinker_on_bottom: { nod: 0.2, lift: 0.2, sink: 1.6, run: 0 },
};

/** 鱼种修正倍率（乘在分区权重上）。 */
const SPECIES_SIGNAL_BIAS: Readonly<Record<FishId, Partial<Readonly<Record<BiteSignal, number>>>>> = {
  crucian: { nod: 1.3 }, // 口轻灵敏：顿口多
  carp: { sink: 1.6 }, // 口大沉稳：黑漂多
  grass_carp: { nod: 1.2, sink: 1.2 }, // 个大：顿口、黑漂都多
  tilapia: { nod: 1.2, run: 1.2 }, // 抢口猛：顿口、移漂多
};

/** 走水时移漂的权重：没加铅抗流时很重，加了铅轻一些（线还是斜，但稳了）。 */
const DRIFT_RUN_WEIGHT = 2.6;
const ANTI_DRIFT_RUN_WEIGHT = 1.2;

/** 走水时其余漂相被打糊的系数——信号乱，顿口也顿不干脆。 */
const DRIFT_MUDDY = 0.7;

export interface SignalSituation {
  readonly zone: RigZone;
  readonly fish: FishId;
  /** 走水（未抗流时移漂主导）。 */
  readonly drift: boolean;
  /** 已加铅抗流：移漂变轻，其余信号恢复大半。 */
  readonly antiDrift: boolean;
}

/** 单个漂相在给定局势下的权重（0 = 不可能出现；none 恒为 0）。 */
export function signalWeight(signal: FloatSignal, situation: SignalSituation): number {
  if (signal === 'none') return 0;
  const base = ZONE_SIGNAL_WEIGHTS[situation.zone][signal];
  const bias = SPECIES_SIGNAL_BIAS[situation.fish][signal] ?? 1;
  if (situation.drift) {
    if (signal === 'run') {
      return situation.antiDrift ? ANTI_DRIFT_RUN_WEIGHT : DRIFT_RUN_WEIGHT;
    }
    return base * bias * DRIFT_MUDDY;
  }
  return base * bias;
}

/** 完整权重表（测试与 UI 读它展示"这一口可能是什么口"）。 */
export function biteSignalWeights(situation: SignalSituation): Readonly<Record<FloatSignal, number>> {
  return {
    none: 0,
    nod: signalWeight('nod', situation),
    lift: signalWeight('lift', situation),
    sink: signalWeight('sink', situation),
    run: signalWeight('run', situation),
  };
}

/**
 * 提竿窗口（仿真秒）：漂相决定了"这口能等多久"。
 *
 * 顿口短促——漂动完了还没提就错过；黑漂慢——等得起。
 * `none` 给默认值（自动结算的老路径不用它，手动模式有口必有漂相）。
 */
export function liftWindowOf(signal: FloatSignal): number {
  switch (signal) {
    case 'nod':
      return 1.1; // 短促下顿：窗口最短
    case 'lift':
      return 1.4;
    case 'run':
      return 1.6;
    case 'sink':
      return 1.9; // 黑漂慢：窗口最长
    default:
      return 1.6;
  }
}
