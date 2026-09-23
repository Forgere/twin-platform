import type { Decision, Judge } from '@twin-platform/decision-core';
import type { FishingActionId } from './actionSpace';
import type { FishingState } from './state';

/**
 * 规则 Judge —— 决策基线。
 *
 * 它是"可以验证的基线"：只有它先跑通，才能回答"规则 vs Jev 谁更适合这个问题"。
 * 置信度给的是诚实的固定值，不假装已经校准过；校准留给 decision-core 的校准表。
 *
 * 顺序即优先级：走水优先（其它调整在走水里都不成立），其次 intent，
 * 最后无信号时明确要求继续观察。
 */
export const ruleJudge: Judge<FishingState, FishingActionId> = {
  id: 'rule',
  judge(state: FishingState): Decision<FishingActionId> {
    const { rig, intent, drift } = state;

    if (drift) {
      return { action: 'ADD_LEAD', params: { amount: 'heavy' }, confidence: 0.6, reasonCode: 'DRIFT_DETECTED' };
    }

    if (intent === 'bite_no_catch') {
      if (rig.zone === 'sensitive' || rig.zone === 'neutral') {
        return {
          action: 'ADJUST_FLOAT',
          params: { direction: 'blunt', steps: 1 },
          confidence: 0.7,
          reasonCode: 'BITE_NO_CATCH_TOO_SENSITIVE',
        };
      }
      return { action: 'CHANGE_BAIT', params: { target: 'state' }, confidence: 0.5, reasonCode: 'BITE_NO_CATCH_BAIT_STATE' };
    }

    if (intent === 'no_bite') {
      if (rig.zone === 'off_bottom') {
        return {
          action: 'ADJUST_FLOAT',
          params: { direction: 'blunt', steps: 2 },
          confidence: 0.6,
          reasonCode: 'NO_BITE_NOT_ON_BOTTOM',
        };
      }
      if (rig.zone === 'blunt' || rig.zone === 'sinker_on_bottom') {
        return {
          action: 'CHANGE_LAYER',
          params: { direction: 'down', band: 1 },
          confidence: 0.45,
          reasonCode: 'NO_BITE_TRY_DEEPER',
        };
      }
      return { action: 'CHANGE_BAIT', params: { target: 'flavor' }, confidence: 0.4, reasonCode: 'NO_BITE_TRY_FLAVOR' };
    }

    return { action: 'OBSERVE', params: { casts: 3 }, confidence: 0.3, reasonCode: 'INSUFFICIENT_SIGNAL' };
  },
};
