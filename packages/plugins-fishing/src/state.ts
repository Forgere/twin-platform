import type { DecisionState } from '@twin-platform/decision-core';
import type { RigState } from './fishingCore';

/** 用户当下在问什么。 */
export type FishingIntent = 'none' | 'no_bite' | 'bite_no_catch' | 'drift';

export interface FishingObservation {
  readonly bites: number;
  readonly catches: number;
  readonly emptyHooks: number;
}

/** 决策内核看到的台钓状态。 */
export interface FishingState extends DecisionState {
  readonly kind: 'fishing';
  readonly rig: RigState;
  readonly intent: FishingIntent;
  readonly drift: boolean;
  readonly observation: FishingObservation;
  readonly targetFish?: string;
}

export interface FishingContextInput {
  readonly intent?: FishingIntent;
  readonly drift?: boolean;
  readonly observation?: Partial<FishingObservation>;
  readonly targetFish?: string;
}

/** 把计算结果与观察拼成内核状态。纯函数、可序列化。 */
export function toFishingState(rig: RigState, input: FishingContextInput = {}): FishingState {
  return {
    kind: 'fishing',
    rig,
    intent: input.intent ?? 'none',
    drift: input.drift ?? false,
    observation: {
      bites: input.observation?.bites ?? 0,
      catches: input.observation?.catches ?? 0,
      emptyHooks: input.observation?.emptyHooks ?? 0,
    },
    ...(input.targetFish === undefined ? {} : { targetFish: input.targetFish }),
  };
}
