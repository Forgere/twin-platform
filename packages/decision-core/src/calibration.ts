import type { DecisionRecord } from './types';

export interface CalibrationBucket {
  readonly lo: number;
  readonly hi: number;
  readonly decisions: number;
  readonly succeeded: number;
  /** 该置信度区间内的真实命中率；样本为 0 时是 0，调用方要靠 decisions 判断是否可信。 */
  readonly rate: number;
}

export interface CalibrationTable {
  readonly methodId: string;
  /** 全部记录数。 */
  readonly total: number;
  /** 有明确成败、真正参与校准的记录数。 */
  readonly decided: number;
  readonly buckets: readonly CalibrationBucket[];
}

export interface CalibrationOptions<A extends string = string> {
  readonly methodId: string;
  /** 判成败由领域决定；返回 undefined 表示这次决策还没有结果。 */
  readonly success: (record: DecisionRecord<A>) => boolean | undefined;
  readonly buckets?: number;
}

/**
 * 置信度校准表：说 80% 的时候，真实命中率是不是接近 80%。
 *
 * 没有它，Decision.confidence 只是装饰。规则 Judge 与 Jev Judge 要分开统计，
 * 这样"谁更可信"才是量出来的，不是争出来的。
 */
export function buildCalibration<A extends string>(
  records: readonly DecisionRecord<A>[],
  options: CalibrationOptions<A>,
): CalibrationTable {
  const count = Math.max(1, Math.floor(options.buckets ?? 5));
  const width = 1 / count;
  const decisions = new Array<number>(count).fill(0);
  const succeeded = new Array<number>(count).fill(0);
  let decided = 0;

  for (const record of records) {
    const success = options.success(record);
    if (success === undefined) continue;
    decided += 1;
    const confidence = Math.min(Math.max(record.decision.confidence, 0), 1);
    const index = confidence >= 1 ? count - 1 : Math.floor(confidence / width);
    const bucket = Math.min(Math.max(index, 0), count - 1);
    decisions[bucket] = (decisions[bucket] ?? 0) + 1;
    if (success) succeeded[bucket] = (succeeded[bucket] ?? 0) + 1;
  }

  const buckets: CalibrationBucket[] = [];
  for (let index = 0; index < count; index += 1) {
    const total = decisions[index] ?? 0;
    const wins = succeeded[index] ?? 0;
    buckets.push({
      lo: index * width,
      hi: (index + 1) * width,
      decisions: total,
      succeeded: wins,
      rate: total === 0 ? 0 : wins / total,
    });
  }

  return { methodId: options.methodId, total: records.length, decided, buckets };
}
