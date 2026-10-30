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

export interface CalibrationReportOptions<A extends string = string> extends CalibrationOptions<A> {
  /** 每个有样本的桶至少要有这么多条，才认为结论可信。 */
  readonly minSamples?: number;
}

export interface CalibrationReport extends CalibrationTable {
  /** Brier 分数：mean((confidence - outcome)^2)，0 最好、1 最差。 */
  readonly brier: number;
  readonly meanConfidence: number;
  readonly successRate: number;
  /** 样本是否足够下结论；不足时调用方应显示"样本不足"，而不是展示比率。 */
  readonly trustworthy: boolean;
}

/**
 * 校准报告：在分桶表之上加两个能直接比较判断者的标量。
 *
 * Brier 同时惩罚"过度自信"和"不够自信"，是"说 80% 是不是真的 80%"的可比较版本；
 * trustworthy 是诚实性开关——样本不够就别拿比率当结论。
 */
export function calibrationReport<A extends string>(
  records: readonly DecisionRecord<A>[],
  options: CalibrationReportOptions<A>,
): CalibrationReport {
  const minSamples = Math.max(1, Math.floor(options.minSamples ?? 5));
  const table = buildCalibration(records, options);
  let decided = 0;
  let brierSum = 0;
  let confidenceSum = 0;
  let successSum = 0;

  for (const record of records) {
    const success = options.success(record);
    if (success === undefined) continue;
    decided += 1;
    const confidence = Math.min(Math.max(record.decision.confidence, 0), 1);
    const actual = success ? 1 : 0;
    brierSum += (confidence - actual) * (confidence - actual);
    confidenceSum += confidence;
    successSum += actual;
  }

  const populated = table.buckets.filter((bucket) => bucket.decisions > 0);
  return {
    ...table,
    brier: decided === 0 ? 0 : brierSum / decided,
    meanConfidence: decided === 0 ? 0 : confidenceSum / decided,
    successRate: decided === 0 ? 0 : successSum / decided,
    trustworthy: decided > 0 && populated.every((bucket) => bucket.decisions >= minSamples),
  };
}
