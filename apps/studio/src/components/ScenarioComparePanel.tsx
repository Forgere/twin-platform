import { createSignal, For, Show } from 'solid-js';
import type { ScenarioDiff } from '@twin-platform/scenario-compare';

/**
 * 方案分叉对比面板。
 *
 * 输入分叉时刻、推演时长、方案 B 的检测区宽度，调用
 * `StudioSession.compare()`（内部走 `scenario-compare`）得到结构化差异，
 * 直接列出指标差与事件差。UI 只负责收参数、展示结果，不碰推演与指标算法。
 */
export default function ScenarioComparePanel(props: {
  onCompare: (forkAt: number, horizon: number, zoneB: number) => ScenarioDiff;
}) {
  const [forkAt, setForkAt] = createSignal(0);
  const [horizon, setHorizon] = createSignal(20);
  const [zoneB, setZoneB] = createSignal(0.5);
  const [diff, setDiff] = createSignal<ScenarioDiff>();

  const run = () => setDiff(props.onCompare(forkAt(), horizon(), zoneB()));

  return (
    <section aria-label="方案分叉对比">
      <h2>方案对比</h2>
      <div class="compare-form">
        <label>
          分叉时刻 (s)
          <input type="number" min="0" step="1" value={forkAt()} onInput={(event) => setForkAt(Number(event.currentTarget.value))} />
        </label>
        <label>
          推演时长 (s)
          <input type="number" min="1" step="1" value={horizon()} onInput={(event) => setHorizon(Number(event.currentTarget.value))} />
        </label>
        <label>
          方案B检测区 (m)
          <input type="number" min="0.1" step="0.1" value={zoneB()} onInput={(event) => setZoneB(Number(event.currentTarget.value))} />
        </label>
        <button type="button" onClick={run}>
          分叉对比
        </button>
      </div>

      <Show when={diff()}>
        {(result) => (
          <>
            <h3>指标差（B − A）</h3>
            <ul class="metric-rows">
              <For each={result().metricDeltas}>
                {(metric) => (
                  <li>
                    <span>{metric.id}</span>
                    <span class={metric.delta === 0 ? 'muted' : metric.delta > 0 ? 'up' : 'down'}>
                      {metric.delta > 0 ? '+' : ''}
                      {metric.delta.toFixed(2)}
                    </span>
                    <span class="muted">A {metric.a.toFixed(1)} / B {metric.b.toFixed(1)}</span>
                  </li>
                )}
              </For>
            </ul>

            <h3>事件差（B − A）</h3>
            <ul class="metric-rows">
              <For each={result().eventDeltas}>
                {(metric) => (
                  <li>
                    <span>{metric.id}</span>
                    <span class={metric.delta === 0 ? 'muted' : metric.delta > 0 ? 'up' : 'down'}>
                      {metric.delta > 0 ? '+' : ''}
                      {metric.delta}
                    </span>
                    <span class="muted">A {metric.a} / B {metric.b}</span>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>
    </section>
  );
}
