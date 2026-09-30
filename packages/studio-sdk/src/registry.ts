import type { PluginHost } from '@twin-platform/plugin-sdk';
import type { TwinScene } from '@twin-platform/world-kernel';
import type { StudioPresentation } from './index';

/** 安装且激活的领域才能认领展示；按安装顺序匹配，拒绝含糊的双重认领。 */
export function selectPresentation(
  host: Pick<PluginHost, 'list'>,
  scene: TwinScene,
  presentations: readonly StudioPresentation[],
): StudioPresentation | undefined {
  let selected: StudioPresentation | undefined;
  for (const record of host.list()) {
    if (record.state !== 'active') continue;
    for (const presentation of presentations) {
      if (presentation.pluginId !== record.manifest.id || !presentation.matches(scene)) continue;
      if (selected) throw new Error(`场景展示重复认领：${selected.pluginId} / ${presentation.pluginId}`);
      const { tabs, defaultTab } = presentation.inspector;
      if (!tabs.some((tab) => tab.id === defaultTab) || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) {
        throw new Error(`插件 ${presentation.pluginId} 的检视页配置不合法。`);
      }
      selected = presentation;
    }
  }
  return selected;
}
