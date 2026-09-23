import type { Decision, Judge } from '@twin-platform/decision-core';
import type { FishingActionId } from '../actionSpace';
import type { JevClient, JevDecision } from '../jevClient';
import { actionFromChoice, toJevRequest } from '../jevQuestions';
import type { FishingState } from '../state';

/**
 * Jev Judge —— 与规则基线同一个 `Judge` 端口。
 *
 * 边界（与第 16 节一致）：
 * - Jev 只**提议**动作与方向；结果仍要过 `Policy`，越界一律降级；
 * - 幅度（调几目、补多少窝）由代码给保守缺省，不让 Jev 做数值判断；
 * - 请求失败绝不"猜一个动作"，而是退到"继续观察"；
 * - 不可映射的返回会变成一个动作空间之外的提议，让 `Policy` 明确拒绝，
 *   而不是在这里替 Policy 做决定。
 */

const OBSERVE_CASTS = 3;
const OBSERVE_THRESHOLD = 0.6;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const pick = (value: string | undefined, allowed: readonly string[], fallback: string): string =>
  value !== undefined && allowed.includes(value) ? value : fallback;

const observe = (confidence: number, reasonCode: string): Decision<FishingActionId> => ({
  action: 'OBSERVE',
  params: { casts: OBSERVE_CASTS },
  confidence: clamp01(confidence),
  reasonCode,
});

/** 未明确说方向时，用灵钝状态给一个保守缺省（钝则往灵，其余往钝）。 */
function defaultFloatDirection(state: FishingState): 'sensitive' | 'blunt' {
  return state.rig.zone === 'blunt' || state.rig.zone === 'sinker_on_bottom' ? 'sensitive' : 'blunt';
}

/** 幅度类参数一律代码兜底：Jev 只选类别，不给数值。 */
function paramsFor(action: FishingActionId, decision: JevDecision, state: FishingState): Record<string, number | string> {
  switch (action) {
    case 'ADJUST_FLOAT':
      return { direction: pick(decision.floatDirection, ['sensitive', 'blunt'], defaultFloatDirection(state)), steps: 1 };
    case 'CHANGE_BAIT':
      return { target: pick(decision.baitTarget, ['flavor', 'state', 'size'], 'state') };
    case 'OBSERVE':
      return { casts: OBSERVE_CASTS };
    case 'ADD_LEAD':
      return { amount: 'medium' };
    case 'CHANGE_LAYER':
      return { direction: 'down', band: 1 };
    case 'REFILL_NEST':
      return { amount: 'normal' };
    case 'REBUILD_RIG':
      return { target: 'hook' };
    case 'CHANGE_SPOT':
      return { urgency: 'later' };
    case 'NO_CHANGE':
      return {};
  }
}

export interface JevJudgeOptions {
  /** needs_observe 概率达到它就直接要求继续观察。 */
  readonly observeThreshold?: number;
}

export function createJevJudge(client: JevClient, options: JevJudgeOptions = {}): Judge<FishingState, FishingActionId> {
  const threshold = options.observeThreshold ?? OBSERVE_THRESHOLD;

  return {
    id: 'jev',
    async judge(state: FishingState): Promise<Decision<FishingActionId>> {
      let decision: JevDecision;
      try {
        decision = await client.decide(toJevRequest(state));
      } catch {
        return observe(0, 'JEV_UNAVAILABLE');
      }

      if (decision.observeProbability >= threshold) return observe(decision.observeProbability, 'JEV_NEEDS_OBSERVE');

      const action = actionFromChoice(decision.action);
      if (!action) {
        // 动作空间之外的提议：交给 Policy 拒绝并降级。
        return { action: 'JEV_UNMAPPED' as FishingActionId, params: {}, confidence: 0, reasonCode: 'JEV_UNMAPPED_CHOICE' };
      }

      return { action, params: paramsFor(action, decision, state), confidence: clamp01(decision.actionConfidence), reasonCode: 'JEV_' + action };
    },
  };
}
