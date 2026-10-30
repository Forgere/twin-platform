import type { InspectorProfile, InspectorTab, StudioPresentation } from '@twin-platform/studio-sdk';

/** 通用检视页；领域页的名字、顺序与实现只由展示插件提供。 */
export type { InspectorTab } from '@twin-platform/studio-sdk';
export interface SceneProfile extends InspectorProfile {
  readonly id: string;
}

const TABS: Readonly<Record<string, InspectorTab>> = {
  entity: { id: 'entity', icon: '🧩', label: '实体' },
  audit: { id: 'audit', icon: '🛡️', label: '审计' },
  metrics: { id: 'metrics', icon: '📊', label: '指标' },
  compare: { id: 'compare', icon: '⚖️', label: '对比' },
  data: { id: 'data', icon: '📡', label: '数据' },
  scene: { id: 'scene', icon: '🗂️', label: '场景' },
  events: { id: 'events', icon: '📜', label: '事件' },
  plugins: { id: 'plugins', icon: '🔌', label: '插件' },
};

const tabs = (ids: readonly string[]): InspectorTab[] => ids.map((id) => TABS[id]!);
/** 物流画像：默认页就是审计——工厂示例打开第一眼看到的是"契约过不过"，不是模型好不好看。 */
const LOGISTICS: SceneProfile = {
  id: 'logistics', defaultTab: 'audit',
  tabs: tabs(['entity', 'audit', 'metrics', 'compare', 'data', 'events', 'scene', 'plugins']),
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
