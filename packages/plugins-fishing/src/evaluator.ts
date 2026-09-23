import type { DecisionRecord } from '@twin-platform/decision-core';

/**
 * 一次台钓决策算不算"成功"。
 *
 * 优先用用户反馈（真实水边管不管用）；没有反馈时退到仿真/记录里的中鱼率达标。
 * 返回 undefined = 还没有结果，**不参与校准**——别把"未知"当成"失败"。
 */
export const CATCH_RATE_TARGET = 0.2;

export function fishingSuccess<A extends string>(record: DecisionRecord<A>): boolean | undefined {
  if (record.feedback) return record.feedback.useful;
  const outcome = record.outcome;
  if (!outcome) return undefined;
  const catchRate = outcome.metrics['catchRate'];
  return typeof catchRate === 'number' ? catchRate >= CATCH_RATE_TARGET : undefined;
}
