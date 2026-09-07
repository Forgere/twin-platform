import { createSignal, For, Show } from 'solid-js';
import type { CsvLoadResult } from '../scene/studioSession';
import { SAMPLE_CSV } from '../scene/studioSession';

/**
 * 数据源面板：把一张 CSV 表接成外部数据（hybrid 模式）。
 *
 * CSV 里出现过的实体被标成"听外部数据"，其余设备继续用内核推演——
 * 这是真实工厂最常见的形态：只有部分设备有数据。
 */
export default function DataSourcePanel(props: { onLoad: (text: string) => CsvLoadResult; onReset: () => void }) {
  const [text, setText] = createSignal(SAMPLE_CSV);
  const [result, setResult] = createSignal<CsvLoadResult>();
  const [mode, setMode] = createSignal<'sim' | 'hybrid'>('sim');

  const load = () => {
    setResult(props.onLoad(text()));
    setMode('hybrid');
  };

  const reset = () => {
    props.onReset();
    setResult(undefined);
    setMode('sim');
  };

  return (
    <section class="data-source">
      <h2>外部数据源</h2>
      <p class="data-source-mode">
        当前模式：<strong>{mode() === 'sim' ? 'sim（内核推演）' : 'hybrid（CSV 驱动 + 其余推演）'}</strong>
      </p>
      <textarea
        value={text()}
        onInput={(event) => setText(event.currentTarget.value)}
        rows={6}
        spellcheck={false}
        aria-label="CSV 数据源"
      />
      <div class="button-row">
        <button type="button" onClick={load}>
          载入 CSV
        </button>
        <button type="button" onClick={reset}>
          回到纯仿真
        </button>
      </div>

      <Show when={result()}>
        {(loaded) => (
          <div class="data-source-result">
            <p>
              解析 {loaded().frames} 帧 · 时长 {loaded().duration.toFixed(1)}s · 外部实体 {loaded().entities.join('、') || '无'}
            </p>
            <Show when={loaded().issues.length > 0}>
              <ul class="data-source-issues">
                <For each={loaded().issues}>{(issue) => <li>第 {issue.line} 行：{issue.message}</li>}</For>
              </ul>
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}
