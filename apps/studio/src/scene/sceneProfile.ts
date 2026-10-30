import type { InspectorProfile, InspectorTab, StudioPresentation } from '@twin-platform/studio-sdk';

/** 通用检视页；领域页的名字、顺序与实现只由展示插件提供。 */
export type { InspectorTab } from '@twin-platform/studio-sdk';
export interface SceneProfile extends InspectorProfile {
  readonly id: string;
}

const TABS: Readonly<Record<string, InspectorTab>> = {
  entity: { id: 'entity', icon: '🧩', label: '实体' },
  metrics: { id: 'metrics', icon: '📊', label: '指标' },
  compare: { id: 'compare', icon: '⚖️', label: '对比' },
  data: { id: 'data', icon: '📡', label: '数据' },
  scene: { id: 'scene', icon: '🗂️', label: '场景' },
  events: { id: 'events', icon: '📜', label: '事件' },
  plugins: { id: 'plugins', icon: '🔌', label: '插件' },
};

const tabs = (ids: readonly string[]): InspectorTab[] => ids.map((id) => TABS[id]!);
const LOGISTICS: SceneProfile = {
  id: 'logistics', defaultTab: 'entity',
  tabs: tabs(['entity', 'metrics', 'compare', 'data', 'events', 'scene', 'plugins']),
};
const GENERIC: SceneProfile = {
  id: 'generic', defaultTab: 'entity',
  tabs: tabs(['entity', 'events', 'data', 'scene', 'plugins']),
};

export function sceneProfileOf(input: {
  readonly plugins: readonly string[];
  readonly presentation?: StudioPresentation;
}): SceneProfile {
  if (input.presentation) return { id: input.presentation.pluginId, ...input.presentation.inspector };
  return input.plugins.includes('logistics') ? LOGISTICS : GENERIC;
}

export const inspectorTabs = (profile: SceneProfile): readonly InspectorTab[] => profile.tabs;
export const defaultTab = (profile: SceneProfile): string => profile.defaultTab;
