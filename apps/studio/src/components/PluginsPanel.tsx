import { For, Show } from 'solid-js';
import type { PluginHost } from '@twin-platform/plugin-sdk';

/**
 * 插件加载状态面板。
 *
 * 只读 `PluginHost` 的注册表：装了哪些、各自状态、贡献了什么能力。
 * 故障隔离的结果也在这里暴露——某个插件 `failed` 时其它插件照常跑，
 * 这里把它标红而不是让整页崩溃。
 */
export default function PluginsPanel(props: { host: PluginHost }) {
  const records = props.host.list();
  const errors = props.host.errors;

  return (
    <section aria-label="插件状态">
      <h2>插件</h2>
      <div class="plugin-list">
        <For each={records}>
          {(record) => (
            <article class={`plugin-card ${record.state === 'active' ? 'ok' : 'bad'}`}>
              <header>
                <strong>{record.manifest.name ?? record.manifest.id}</strong>
                <span class="plugin-version">v{record.manifest.version}</span>
              </header>
              <p class="plugin-state">{record.state}</p>
              <ul class="capability-tags">
                <For each={record.manifest.capabilities}>{(capability) => <li>{capability}</li>}</For>
              </ul>
              <p class="plugin-contrib">
                行为 {record.instance?.behaviors?.length ?? 0} · 指标 {record.instance?.metrics?.length ?? 0} · 模板{' '}
                {record.instance?.templates?.length ?? 0}
              </p>
            </article>
          )}
        </For>
      </div>
      <Show when={errors.length > 0}>
        <div class="plugin-errors" role="alert">
          <For each={errors}>{(error) => <p>{error.pluginId}：{error.message}</p>}</For>
        </div>
      </Show>
    </section>
  );
}
