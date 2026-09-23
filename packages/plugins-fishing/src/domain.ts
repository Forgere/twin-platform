import { validateAgainstActionSpace } from '@twin-platform/decision-core';
import type { DecisionDomain, Evaluator, Judge } from '@twin-platform/decision-core';
import { FISHING_ACTIONS, type FishingActionId } from './actionSpace';
import { ruleJudge } from './ruleJudge';
import type { FishingState } from './state';

/** 评分：优先读事后观测里的咬钩率（由 FishSim 或真实记录填入）。 */
const fishingEvaluator: Evaluator<FishingActionId> = {
  id: 'fishing-bite-rate',
  score(record) {
    const outcome = record.outcome;
    if (!outcome) return undefined;
    const biteRate = outcome.metrics['biteRate'];
    return biteRate;
  },
};

const fishingPolicy: DecisionDomain<FishingState, FishingActionId>['policy'] = {
  id: 'fishing-policy',
  validate: (_state, decision) => validateAgainstActionSpace(FISHING_ACTIONS, decision),
};

const fishingFallback: DecisionDomain<FishingState, FishingActionId>['fallback'] = (_state, reasonCode) => ({
  action: 'OBSERVE',
  params: { casts: 3 },
  confidence: 0.2,
  reasonCode: 'DEGRADED_' + reasonCode,
});

export const fishingDomain: DecisionDomain<FishingState, FishingActionId> = {
  id: 'fishing',
  actions: FISHING_ACTIONS,
  judge: ruleJudge,
  policy: fishingPolicy,
  evaluator: fishingEvaluator,
  fallback: fishingFallback,
};

/** 换一个 Judge（例如 Jev），其余保持不变——这就是"判断可替换"的接缝。 */
export function createFishingDomain(
  judge: Judge<FishingState, FishingActionId> = ruleJudge,
): DecisionDomain<FishingState, FishingActionId> {
  return { ...fishingDomain, judge };
}
