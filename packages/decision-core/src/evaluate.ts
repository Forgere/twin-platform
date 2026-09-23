import type { DecisionDomain } from './ports';
import type { DecisionRecord, DecisionState } from './types';

export interface DecisionSummary {
  readonly total: number;
  readonly accepted: number;
  readonly degraded: number;
  readonly byAction: Readonly<Record<string, number>>;
  readonly meanConfidence: number;
}

/** 一段决策日志的结构化摘要：不需要领域知识，直接读日志。 */
export function summarizeDecisions<A extends string>(records: readonly DecisionRecord<A>[]): DecisionSummary {
  const byAction: Record<string, number> = {};
  let accepted = 0;
  let confidence = 0;
  for (const record of records) {
    byAction[record.decision.action] = (byAction[record.decision.action] ?? 0) + 1;
    if (record.accepted) accepted += 1;
    confidence += record.decision.confidence;
  }
  return {
    total: records.length,
    accepted,
    degraded: records.length - accepted,
    byAction,
    meanConfidence: records.length === 0 ? 0 : confidence / records.length,
  };
}

export interface JudgeComparison {
  readonly states: number;
  readonly agreed: number;
  readonly agreement: number;
  readonly aOnly: Readonly<Record<string, number>>;
  readonly bOnly: Readonly<Record<string, number>>;
}

/**
 * 两个判断者的对比（例如规则 vs Jev）。
 *
 * 只比动作，不比文案——"谁更适合这个问题"要能跑、能量、能回放，
 * 而不是靠讨论。
 */
export async function compareJudges<S extends DecisionState, A extends string>(
  domainA: DecisionDomain<S, A>,
  domainB: DecisionDomain<S, A>,
  states: readonly S[],
): Promise<JudgeComparison> {
  let agreed = 0;
  const aOnly: Record<string, number> = {};
  const bOnly: Record<string, number> = {};
  for (const state of states) {
    const a = await domainA.judge.judge(state, { now: 0 });
    const b = await domainB.judge.judge(state, { now: 0 });
    if (a.action === b.action) {
      agreed += 1;
    } else {
      aOnly[a.action] = (aOnly[a.action] ?? 0) + 1;
      bOnly[b.action] = (bOnly[b.action] ?? 0) + 1;
    }
  }
  return {
    states: states.length,
    agreed,
    agreement: states.length === 0 ? 0 : agreed / states.length,
    aOnly,
    bOnly,
  };
}
