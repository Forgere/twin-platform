import { For, Show } from 'solid-js';
import type { PluginHost } from '@twin-platform/plugin-sdk';
import { PLUGIN_CATALOG } from '../plugins/catalog';

/**
 * 插件面板：既能看状态，也能切换插件集。
 *
 * 切换走的是"重建会话"而不是热插拔——行为在 TwinWorld 构造时固定，且插件集
 * 属于回放输入，运行中换行为会让回放复现不出同一串事件。
 *
 * 领域包（能提供场景的）互斥单选；其余能力插件可多选叠加，方便同时开发
 * 多个数字孪生插件。
 */
export default function PluginsPanel(props: {
  host: PluginHost;
  activeIds: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const records = () => props.host.list();
  const errors = () => props.host.errors;
  const isActive = (id: string) => props.activeIds.includes(id);
  const domainIds = PLUGIN_CATALOG.filter((entry) => entry.buildScene).map((entry) => entry.id);

  const toggle = (id: string): void => {
    const entry = PLUGIN_CATALOG.find((item) => item.id === id);
    if (isActive(id)) {
      props.onChange(props.activeIds.filter((item) => item !== id));
      return;
    }
    // 选领域包时先摘掉别的领域包，避免把互不匹配的场景与决策混在一起。
    const base = entry?.buildScene ? props.activeIds.filter((item) => !domainIds.includes(item)) : [...props.activeIds];
    props.onChange([...base, id]);
  };

  return (
    <section aria-label="插件状态">
      <h2>插件</h2>
      <div class="plugin-switch">
        <For each={PLUGIN_CATALOG}>
          {(entry) => (
            <label class="plugin-toggle">
              <input
                type="checkbox"
                checked={isActive(entry.id)}
                onChange={() => toggle(entry.id)}
              />
              <span>{entry.label}</span>
              <Show when={entry.buildScene}>
                <em class="plugin-kind">领域包</em>
              </Show>
            </label>
          )}
        </For>
      </div>
      <p class="plugin-note">切换插件会重建会话（插件集是回放输入的一部分，不能热插拔）。</p>

      <div class="plugin-list">
        <For each={records()}>
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
                行为 {record.instance?.behaviors?.length ?? 0} · 指标 {record.instance?.metrics?.length ?? 0} · 决策域{' '}
                {record.instance?.decisions?.length ?? 0} · 模板 {record.instance?.templates?.length ?? 0}
              </p>
            </article>
          )}
        </For>
      </div>
      <Show when={errors().length > 0}>
        <div class="plugin-errors" role="alert">
          <For each={errors()}>{(error) => <p>{error.pluginId}：{error.message}</p>}</For>
        </div>
      </Show>
    </section>
  );
}
