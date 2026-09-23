import { FISHING_ACTION_IDS, type FishingActionId } from './actionSpace';
import type { FishingObservation, FishingState } from './state';

/**
 * Jev 接入的第一层：把领域状态**归纳成类别**，再提出封闭的 typed 问题。
 *
 * 关键约束（来自 Jev 的能力边界）：
 * - Jev 不擅长数值比较与算术。所以底承重、灵钝、空竿率这些"需要比较数字"的
 *   判断全部由 fishingCore 先算成类别（zone / bucket），只把类别结果交给 Jev；
 * - Jev 不产出自由文本。选项与问题都在代码里定死，Jev 只在选项中选择；
 * - **幅度类数值由代码兜底**：Jev 只选方向/类别，具体步长在代码里取保守值。
 * - 交互语言用中文（JEV_LANGUAGE=zh-CN）；但 answer 里的 action id 仍是英文，
 *   因为它们是与动作空间对齐的稳定标识。
 *
 * 这一层是纯函数、可单测；HTTP 调用在 `jevClient.ts`，判断装配在 `judges/jev.ts`。
 */

export type JevQuestion =
  | { readonly kind: 'choice'; readonly id: string; readonly prompt: string; readonly options: readonly string[] }
  | { readonly kind: 'noul'; readonly id: string; readonly prompt: string }
  | { readonly kind: 'score'; readonly id: string; readonly prompt: string; readonly levels: readonly string[] };

export interface JevRequest {
  /** 已归纳过的类别事实：键值都是字符串，不留给 Jev 做数值比较的空间。 */
  readonly state: Readonly<Record<string, string>>;
  readonly questions: readonly JevQuestion[];
}

export type EmptyHookBucket = 'no_signal' | 'low' | 'medium' | 'high';

/** 空竿率分桶：比较发生在这里（本地代码），Jev 只看到 low/medium/high。 */
export function emptyHookBucket(observation: FishingObservation): EmptyHookBucket {
  const total = observation.catches + observation.emptyHooks;
  if (total <= 0) return 'no_signal';
  const ratio = observation.emptyHooks / total;
  if (ratio >= 0.6) return 'high';
  if (ratio <= 0.3) return 'low';
  return 'medium';
}

/** 把台钓状态整理成"类别 state + 封闭问题"。 */
export function toJevRequest(state: FishingState): JevRequest {
  return {
    state: {
      // 全部是 fishingCore 已经判定好的类别，不再出现 B / w / d 这类需要比较的数值。
      zone: state.rig.zone,
      hook_state: state.rig.hookState,
      bait_state: state.rig.baitState,
      intent: state.intent,
      drift: state.drift ? 'yes' : 'no',
      empty_hook_rate: emptyHookBucket(state.observation),
      target_fish: state.targetFish ?? 'unknown',
    },
    questions: [
      {
        kind: 'choice',
        id: 'next_action',
        prompt: '综合当前钓组状态与观察，下一步优先尝试哪个动作？',
        options: FISHING_ACTION_IDS,
      },
      {
        kind: 'choice',
        id: 'float_direction',
        prompt: '如果要调整浮漂，应该往哪个方向调？',
        options: ['sensitive', 'blunt'],
      },
      {
        kind: 'choice',
        id: 'bait_target',
        prompt: '如果要换饵，优先换哪一类？',
        options: ['flavor', 'state', 'size'],
      },
      {
        kind: 'noul',
        id: 'needs_observe',
        prompt: '当前信息是否不足以支撑调整、应当先继续观察？',
      },
      {
        kind: 'score',
        id: 'urgency',
        prompt: '当下问题的紧迫程度如何？',
        levels: ['none', 'low', 'medium', 'high'],
      },
    ],
  };
}

/** 把 Jev 选中的 action 收敛回封闭动作空间；越界返回 undefined 交给 Policy 降级。 */
export function actionFromChoice(choice: string | undefined): FishingActionId | undefined {
  return FISHING_ACTION_IDS.find((id) => id === choice);
}
