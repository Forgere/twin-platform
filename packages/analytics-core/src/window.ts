import type { WorldEvent } from '@twin-platform/world-kernel';

/**
 * 窗口聚合。
 *
 * 全部是**纯函数**：输入一串事件，输出一串桶。不读挂钟、不看世界状态，
 * 所以同一批事件在浏览器、服务端回放任务里算出来的桶完全一致——
 * 指标如果算两遍不一样，"对比两个方案"就失去意义了。
 *
 * 桶边界用 `floor(t / bucketSize)`，与 `storage-postgres` 的 `metric_rollups`
 * 同一套定义，落库和重算的结果可以直接对齐。
 */

export interface MetricBucket {
  start: number;
  end: number;
  /** 桶内累计值。 */
  value: number;
  /** 桶内事件条数。 */
  count: number;
}

export interface MetricSeries {
  id: string;
  bucketSize: number;
  buckets: MetricBucket[];
}

export const bucketIndexOf = (time: number, bucketSize: number): number => Math.floor(time / bucketSize);

export function emptySeries(id: string, bucketSize: number): MetricSeries {
  return { id, bucketSize, buckets: [] };
}

/** 造一串覆盖 [0, until) 的空桶；`until` 落在桶边界上也算一个桶。 */
export function emptyBuckets(bucketSize: number, until: number): MetricBucket[] {
  const count = Math.max(0, Math.ceil((until + Number.EPSILON) / bucketSize));
  return Array.from({ length: count }, (_, index) => ({
    start: index * bucketSize,
    end: (index + 1) * bucketSize,
    value: 0,
    count: 0,
  }));
}

function ensureBuckets(series: MetricSeries, until: number): MetricBucket[] {
  if (series.buckets.length === 0) series.buckets = emptyBuckets(series.bucketSize, until);
  while (series.buckets.length * series.bucketSize < until + Number.EPSILON) {
    const index = series.buckets.length;
    series.buckets.push({ start: index * series.bucketSize, end: (index + 1) * series.bucketSize, value: 0, count: 0 });
  }
  return series.buckets;
}

function bucketAt(series: MetricSeries, time: number): MetricBucket {
  const index = bucketIndexOf(time, series.bucketSize);
  // 桶序列长度由 `until` 决定，事件绝不延伸它：落在 `until` 边界上的事件
  // （如 t === until）夹进最后一个桶。这是 [start, end) 半开区间约定的闭环——
  // 否则一次观测窗口末端的事件会被推到不存在的下一个桶里，60 秒窗口内的
  // 出口件数会被算少。
  const buckets = ensureBuckets(series, series.bucketSize);
  const clamped = Math.min(index, buckets.length - 1);
  const bucket = buckets[clamped];
  if (!bucket) throw new Error('桶分配失败：桶数不足。');
  return bucket;
}

export interface SeriesOptions {
  bucketSize: number;
  /** 只统计这些事件类型；不给则全部。 */
  types?: readonly string[];
  /** 桶要覆盖到的时间；缺省取最后一条事件。 */
  until?: number;
}

const matches = (event: WorldEvent, types: readonly string[] | undefined): boolean =>
  types === undefined || types.includes(event.type);

const horizonOf = (events: readonly WorldEvent[], until: number | undefined): number =>
  until ?? (events.length === 0 ? 0 : Math.max(...events.map((event) => event.occurredAt)));

/** 计数序列：每个事件算 1。吞吐就是它除以时长。 */
export function countSeries(id: string, events: readonly WorldEvent[], options: SeriesOptions): MetricSeries {
  const series = emptySeries(id, options.bucketSize);
  const until = horizonOf(events, options.until);
  ensureBuckets(series, until);
  for (const event of events) {
    if (!matches(event, options.types)) continue;
    const bucket = bucketAt(series, event.occurredAt);
    bucket.value += 1;
    bucket.count += 1;
  }
  return series;
}

/** 求和序列：累加 `payload[valueKey]`（非数字按 0 计）。 */
export function sumSeries(id: string, events: readonly WorldEvent[], options: SeriesOptions & { valueKey: string }): MetricSeries {
  const series = emptySeries(id, options.bucketSize);
  ensureBuckets(series, horizonOf(events, options.until));
  for (const event of events) {
    if (!matches(event, options.types)) continue;
    const raw = event.payload?.[options.valueKey];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    const bucket = bucketAt(series, event.occurredAt);
    bucket.value += value;
    bucket.count += 1;
  }
  return series;
}

/**
 * 阶梯序列：进入 +1、离开 -1，桶值取**桶结束时的在制数量**（积压）。
 *
 * 积压不是"这一分钟发生了几件事"，而是"这一分钟结束时还有多少没走"，
 * 所以必须按事件顺序累加，不能逐桶独立统计。
 */
export function stepSeries(
  id: string,
  events: readonly WorldEvent[],
  options: SeriesOptions & { enterTypes: readonly string[]; exitTypes: readonly string[] },
): MetricSeries {
  const series = emptySeries(id, options.bucketSize);
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  ensureBuckets(series, horizonOf(ordered, options.until));

  // 先算水位变化时间线，再让每个桶取"桶结束时"的水位。
  const changes: { time: number; level: number }[] = [];
  let level = 0;
  for (const event of ordered) {
    const delta = options.enterTypes.includes(event.type) ? 1 : options.exitTypes.includes(event.type) ? -1 : 0;
    if (delta === 0) continue;
    level += delta;
    changes.push({ time: event.occurredAt, level });
  }

  let pointer = 0;
  let current = 0;
  for (const bucket of series.buckets) {
    while (pointer < changes.length && (changes[pointer] as { time: number }).time < bucket.end) {
      current = (changes[pointer] as { level: number }).level;
      pointer += 1;
    }
    bucket.value = current;
  }

  // count 记本桶内的进出事件数，用于判断"这个桶到底有没有动静"
  for (const event of ordered) {
    const isEnter = options.enterTypes.includes(event.type);
    const isExit = options.exitTypes.includes(event.type);
    if (!isEnter && !isExit) continue;
    bucketAt(series, event.occurredAt).count += 1;
  }
  return series;
}

/** 把计数序列换算成"每分钟"速率，桶值更贴近人读的吞吐。 */
export function ratePerMinute(series: MetricSeries): MetricSeries {
  const factor = 60 / series.bucketSize;
  return {
    id: series.id,
    bucketSize: series.bucketSize,
    buckets: series.buckets.map((bucket) => ({ ...bucket, value: bucket.value * factor })),
  };
}

export function seriesTotal(series: MetricSeries): number {
  return series.buckets.reduce((sum, bucket) => sum + bucket.value, 0);
}

export function seriesPeak(series: MetricSeries): number {
  return series.buckets.reduce((max, bucket) => Math.max(max, bucket.value), 0);
}

/** 最后一个非空桶的值——"当前积压"这类指标读它。 */
export function seriesLatest(series: MetricSeries): number {
  for (let i = series.buckets.length - 1; i >= 0; i -= 1) {
    const bucket = series.buckets[i];
    if (bucket && bucket.value !== 0) return bucket.value;
  }
  return 0;
}

export function countByType(events: readonly WorldEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of events) out[event.type] = (out[event.type] ?? 0) + 1;
  return out;
}

export function sumByKey(events: readonly WorldEvent[], key: string): number {
  let total = 0;
  for (const event of events) {
    const raw = event.payload?.[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) total += raw;
  }
  return total;
}
