import type { DecisionLog } from './log';
import type { Feedback } from './types';

/**
 * 把一次用户反馈（👍/👎）落到决策日志。
 *
 * 反馈是"结果信号"的一种：evaluator 的自动评分能跑仿真，但只有用户知道
 * "这次调整在真实水边管不管用"。两者写进同一条记录，评分时用户反馈优先。
 */
export function applyFeedback<A extends string>(log: DecisionLog<A>, feedback: Feedback): boolean {
  const record = log.find(feedback.decisionId);
  if (!record) return false;
  record.feedback = feedback;
  record.score = feedback.useful ? 1 : 0;
  return true;
}
