import { createSignal, For, Show, untrack } from 'solid-js';
import type { ScenarioDiff } from '@twin-platform/scenario-compare';

/**
 * 方案分叉对比面板。
 *
 * 输入分叉时刻、推演时长、方案 B 的检测区宽度，调用
 * `StudioSession.compare()`（内部走 `scenario-compare`）得到结构化差异，
 * 直接列出指标差与事件差。UI 只负责收参数、展示结果，不碰推演与指标算法。
 */
export default function ScenarioComparePanel(props: {
  currentTime?: number;
  onCompare: (forkAt: number, horizon: number, zoneB: number) => ScenarioDiff;
  onForkMark?: (forkAt: number) => void;
}) {
  const [forkAt, setForkAt] = createSignal(untrack(() => (props.currentTime !== undefined ? Math.floor(props.currentTime) : 0)));
  const [horizon, setHorizon] = createSignal(20);
  const [zoneB, setZoneB] = createSignal(4);
  const [diff, setDiff] = createSignal<ScenarioDiff>();

  const setNow = () => {
    if (props.currentTime !== undefined) {
      const now = Number(props.currentTime.toFixed(1));
      setForkAt(now);
      props.onForkMark?.(now);
    }
  };

  const run = () => {
    props.onForkMark?.(forkAt());
    setDiff(props.onCompare(forkAt(), horizon(), zoneB()));
  };

  return (
    <section aria-label="方案分叉对比" class="scenario-compare-panel">
      <div class="compare-intro">
        <p class="muted">
          从指定时刻分叉推演基准方案 A 与调整方案 B（如修改打包批量），对比推演周期内的指标 delta 与事件分布。
        </p>
      </div>

      <div class="compare-form">
        <label>
          <span class="compare-label-row">
            <span>分叉时刻 (s)</span>
            <Show when={props.currentTime !== undefined}>
              <button type="button" class="btn-text-action" onClick={setNow} title="设为时间轴当前时刻">
                取当前时刻 ({props.currentTime?.toFixed(1)}s)
              </button>
            </Show>
          </span>
          <input
            type="number"
            min="0"
            step="0.5"
            value={forkAt()}
            onInput={(event) => {
              const val = Number(event.currentTarget.value);
              setForkAt(val);
              props.onForkMark?.(val);
            }}
          />
        </label>
        <label>
          推演时长 (s)
          <input type="number" min="1" step="1" value={horizon()} onInput={(event) => setHorizon(Number(event.currentTarget.value))} />
        </label>
        <label>
          方案B打包批量 (个小件/托盘)
          <input type="number" min="1" step="1" value={zoneB()} onInput={(event) => setZoneB(Number(event.currentTarget.value))} />
        </label>
        <button type="button" class="btn-primary" onClick={run}>
          分叉推演对比
        </button>
      </div>

      <Show when={diff()}>
        {(result) => (
          <div class="compare-results">
            <h3>指标差（方案 B − 方案 A）</h3>
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

            <h3>事件差（方案 B − 方案 A）</h3>
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
          </div>
        )}
      </Show>
    </section>
  );
}
