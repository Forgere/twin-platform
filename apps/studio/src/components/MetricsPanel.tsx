import { For, Show } from 'solid-js';
import { seriesLatest, seriesTotal, type LineMetrics } from '@twin-platform/analytics-core';

/**
 * 产线指标看板。
 *
 * 不自己算指标——`StudioSession.metrics()` 已经调用 `analytics-core` 把
 * `LineMetrics` 算好传进来，这里只负责把四个口径（吞吐 / 积压 / 利用率 / 停机）
 * 陈列出来。改指标口径只动 analytics-core，不用碰 UI。
 */
export default function MetricsPanel(props: { metrics: LineMetrics }) {
  const throughput = () => seriesTotal(props.metrics.throughput);
  const backlog = () => seriesLatest(props.metrics.backlog);

  return (
    <section aria-label="产线指标">
      <h2>指标</h2>
      <div class="metric-cards">
        <div class="metric-card">
          <span class="metric-value">{throughput().toFixed(0)}</span>
          <span class="metric-label">吞吐（件）</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{backlog().toFixed(0)}</span>
          <span class="metric-label">积压（件）</span>
        </div>
      </div>

      <Show when={props.metrics.utilization.length > 0} fallback={<p class="muted">暂无设备利用率数据。</p>}>
        <h3>设备利用率</h3>
        <ul class="metric-rows">
          <For each={props.metrics.utilization}>
            {(row) => (
              <li>
                <span>{row.entityId}</span>
                <span>{(row.utilization * 100).toFixed(1)}%</span>
                <span class="muted">忙 {row.busy.toFixed(1)}s</span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={props.metrics.downtime.length > 0}>
        <h3>停机</h3>
        <ul class="metric-rows">
          <For each={props.metrics.downtime}>
            {(row) => (
              <li>
                <span>{row.entityId}</span>
                <span>{row.downtime.toFixed(1)}s</span>
                <span class="muted">{row.occurrences} 次</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
