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

export interface RecordedMethodStats {
  readonly methodId: string;
  readonly decided: number;
  readonly brier: number;
  readonly successRate: number;
}

export interface RecordedComparison {
  readonly a: RecordedMethodStats;
  readonly b: RecordedMethodStats;
  /** 样本不足时不给结论——这里就是"别用 3 个样本证明自己"的护栏。 */
  readonly winner: 'a' | 'b' | 'tie' | 'insufficient';
}

export interface RecordedComparisonOptions<A extends string = string> {
  readonly success: (record: DecisionRecord<A>) => boolean | undefined;
  readonly minSamples?: number;
}

function methodStats<A extends string>(
  methodId: string,
  records: readonly DecisionRecord<A>[],
  success: RecordedComparisonOptions<A>['success'],
): RecordedMethodStats {
  let decided = 0;
  let brierSum = 0;
  let successSum = 0;
  for (const record of records) {
    const outcome = success(record);
    if (outcome === undefined) continue;
    decided += 1;
    const confidence = Math.min(Math.max(record.decision.confidence, 0), 1);
    const actual = outcome ? 1 : 0;
    brierSum += (confidence - actual) * (confidence - actual);
    successSum += actual;
  }
  return {
    methodId,
    decided,
    brier: decided === 0 ? 0 : brierSum / decided,
    successRate: decided === 0 ? 0 : successSum / decided,
  };
}

/**
 * 用**结果**比较两个判断者（不是比动作是否一致）。
 *
 * `compareJudges` 回答"它们判断一样吗"，这里回答"谁更准"。后者才是选型依据。
 */
export function compareRecorded<A extends string>(
  a: { readonly methodId: string; readonly records: readonly DecisionRecord<A>[] },
  b: { readonly methodId: string; readonly records: readonly DecisionRecord<A>[] },
  options: RecordedComparisonOptions<A>,
): RecordedComparison {
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? 10));
  const statsA = methodStats(a.methodId, a.records, options.success);
  const statsB = methodStats(b.methodId, b.records, options.success);
  let winner: RecordedComparison['winner'];
  if (statsA.decided < minSamples || statsB.decided < minSamples) winner = 'insufficient';
  else if (Math.abs(statsA.brier - statsB.brier) < 1e-9) winner = 'tie';
  else winner = statsA.brier < statsB.brier ? 'a' : 'b';
  return { a: statsA, b: statsB, winner };
}
