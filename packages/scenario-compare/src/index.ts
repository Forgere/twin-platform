import type { TwinScene, WorldBehavior, WorldEvent } from '@twin-platform/world-kernel';
import { TwinWorld } from '@twin-platform/world-kernel';
import type { LineMetrics } from '@twin-platform/analytics-core';
import { lineMetrics, seriesLatest, seriesTotal } from '@twin-platform/analytics-core';

/**
 * 方案分叉与结果比对。
 *
 * 从同一个快照（某个时刻的世界状态）长出两条推演路径，用不同参数各跑一段，
 * 再把两段历史的指标差、事件差结构化地摊开——人比的是"这个改动让吞吐涨了多少、
 * 哪类事件变多了"，不是去翻两万条原始事件。
 *
 * 全程确定性：同样的输入（场景 + 分叉点 + 时长 + 两套行为 + 种子）必然得到
 * 逐字节一致的 diff，所以它可以放进回放任务里自动跑、可以落库、可以 CI 比。
 */

export interface ScenarioVariant {
  id: string;
  label?: string;
  behaviors: WorldBehavior[];
}

export interface CompareInput {
  scene: TwinScene;
  /** 分叉时刻（秒）：两路推演从这里共享同一份世界状态。 */
  forkAt: number;
  /** 分叉后推演时长（秒）。 */
  horizon: number;
  /** 固定步长，默认 1/60。 */
  step?: number;
  seed?: number;
  /** 恰好两个方案。 */
  variants: [ScenarioVariant, ScenarioVariant];
}

export interface VariantResult {
  id: string;
  label?: string;
  events: readonly WorldEvent[];
  metrics: LineMetrics;
  /** 可比较的标量摘要，diff 就基于它。 */
  summary: ScenarioSummary;
}

export interface ScenarioSummary {
  /** 总出口件数（吞吐累计）。 */
  throughput: number;
  /** 末态在制数量（积压）。 */
  backlog: number;
  /** 设备累计忙碌时长（秒）。 */
  busy: number;
  /** 设备累计停机时长（秒）。 */
  downtime: number;
}

export interface MetricDelta {
  id: string;
  a: number;
  b: number;
  /** b − a：正表示方案 B 更优（按该指标语义）。 */
  delta: number;
}

export interface ScenarioDiff {
  forkAt: number;
  horizon: number;
  variants: [VariantResult, VariantResult];
  metricDeltas: MetricDelta[];
  eventDeltas: MetricDelta[];
}

const summarize = (metrics: LineMetrics): ScenarioSummary => ({
  throughput: seriesTotal(metrics.throughput),
  backlog: seriesLatest(metrics.backlog),
  busy: metrics.utilization.reduce((sum, row) => sum + row.busy, 0),
  downtime: metrics.downtime.reduce((sum, row) => sum + row.downtime, 0),
});

const METRIC_KEYS: (keyof ScenarioSummary)[] = ['throughput', 'backlog', 'busy', 'downtime'];

const diffSummaries = (a: ScenarioSummary, b: ScenarioSummary): MetricDelta[] =>
  METRIC_KEYS.map((key) => ({ id: key, a: a[key], b: b[key], delta: b[key] - a[key] }));

const diffEvents = (a: readonly WorldEvent[], b: readonly WorldEvent[]): MetricDelta[] => {
  const count = (events: readonly WorldEvent[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const event of events) out[event.type] = (out[event.type] ?? 0) + 1;
    return out;
  };
  const ca = count(a);
  const cb = count(b);
  const types = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort();
  return types.map((type) => {
    const va = ca[type] ?? 0;
    const vb = cb[type] ?? 0;
    return { id: type, a: va, b: vb, delta: vb - va };
  });
};

function advanceTo(world: TwinWorld, target: number, step: number): void {
  let guard = 0;
  const limit = 5_000_000;
  while (world.time < target - 1e-9 && guard < limit) {
    world.step(step);
    guard += 1;
  }
}

export function compareScenarios(input: CompareInput): ScenarioDiff {
  const step = input.step ?? 1 / 60;
  const seed = input.seed ?? 1;
  const maxStepsPerAdvance = 4096;
  const [variantA, variantB] = input.variants;
  if (!variantA || !variantB) throw new Error('必须提供恰好两个方案变体。');

  // 1) 用方案 A 推到分叉点，取快照——两路从此共享同一份世界状态。
  const base = new TwinWorld(input.scene, {
    seed,
    step,
    behaviors: variantA.behaviors,
    maxStepsPerAdvance,
  });
  advanceTo(base, input.forkAt, step);
  const snapshot = base.snapshot();

  const runVariant = (variant: ScenarioVariant): VariantResult => {
    const world = new TwinWorld(input.scene, {
      seed,
      step,
      behaviors: variant.behaviors,
      maxStepsPerAdvance,
    });
    world.restoreFrom(snapshot);
    advanceTo(world, input.forkAt + input.horizon, step);
    const events = world.getEventLog();
    const metrics = lineMetrics(events, {
      bucketSize: Math.max(step, (input.forkAt + input.horizon) / 20),
      enterTypes: ['parcel:enter'],
      exitTypes: ['parcel:exit'],
      busyStatuses: ['busy'],
      downStatuses: ['down'],
      until: world.time,
    });
    return { id: variant.id, label: variant.label, events, metrics, summary: summarize(metrics) };
  };

  const a = runVariant(variantA);
  const b = runVariant(variantB);

  return {
    forkAt: input.forkAt,
    horizon: input.horizon,
    variants: [a, b],
    metricDeltas: diffSummaries(a.summary, b.summary),
    eventDeltas: diffEvents(a.events, b.events),
  };
}
