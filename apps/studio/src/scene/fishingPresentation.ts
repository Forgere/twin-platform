import { fishingModeOf, LIFT_WINDOW, manualCastOf, rigPhaseOf } from '@twin-platform/plugins-fishing';
import { SIGNAL_DURATION, type FloatSignalName } from './floatSignal';
import type { HookKey, V3 } from './rigChain';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clamp = (value: number): number => Math.max(0, Math.min(1, value));

/** 只解释已发生的世界状态；不预测鱼口，也不记录“第一次渲染是在什么时候”。 */
export function fishingPresentation(attrs: Readonly<Record<string, unknown>>, time: number, castInterval = 3): {
  readonly stowed: boolean;
  readonly castProgress: number;
  readonly signal: FloatSignalName;
  readonly hook: HookKey;
  readonly biteAge: number;
} {
  const fishing = rigPhaseOf(attrs) === 'fishing';
  const sim = fishingModeOf(attrs) === 'sim';
  const manual = manualCastOf(attrs);
  const stowed = fishing && manual && attrs.inWater !== true;
  const interval = Math.max(0.5, finite(castInterval) ? castInterval : 3);
  const castDuration = Math.min(0.8, interval * 0.8); // 必须先入水，才到第一轮鱼口的时刻。
  const progress = fishing && manual && attrs.inWater === true && finite(attrs.castAt) && attrs.castAt >= 0
    ? clamp((time - attrs.castAt) / castDuration)
    : 1;
  const raw = attrs.signal;
  let signal: FloatSignalName = raw === 'nod' || raw === 'lift' || raw === 'sink' || raw === 'run' ? raw : 'none';
  let biteAge = SIGNAL_DURATION;
  if (signal !== 'none' && fishing && sim && !stowed) {
    // 交互式鱼口用截止时刻复原起点，seek 直接落在口中间也能呈现准确姿态。
    if (attrs.pendingBite === true && finite(attrs.biteUntil)) biteAge = time - (attrs.biteUntil - LIFT_WINDOW);
    // 自动模拟的旧场景已有 nextAt = 本竿时刻 + interval，不需要另添状态或遍历事件。
    else if (!manual && finite(attrs.nextAt) && attrs.nextAt > 0) biteAge = time - (attrs.nextAt - interval);
  }
  if (!fishing || !sim || stowed || biteAge < 0 || biteAge >= SIGNAL_DURATION) {
    signal = 'none';
    biteAge = SIGNAL_DURATION;
  }
  return {
    stowed,
    castProgress: progress * progress * (3 - 2 * progress),
    signal,
    hook: attrs.bitHook === 'upper' ? 'upper' : 'lower',
    biteAge,
  };
}

/** 入水是现有挂点的过渡，漂 / 铅 / 双钩同一份进度；线仍钉在这些点上。 */
export function castEntryPoint(point: V3, float: V3, rodTip: V3, surfaceY: number, progress: number): V3 {
  if (progress >= 1) return point;
  const start: V3 = [
    rodTip[0] + (point[0] - float[0]) * 0.1,
    surfaceY + 0.25 + (point[1] - float[1]) * 0.08,
    rodTip[2] + (point[2] - float[2]) * 0.1,
  ];
  return [
    start[0] + (point[0] - start[0]) * progress,
    start[1] + (point[1] - start[1]) * progress,
    start[2] + (point[2] - start[2]) * progress,
  ];
}
