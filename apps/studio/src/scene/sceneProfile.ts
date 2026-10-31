import type { InspectorProfile, InspectorTab, StudioPresentation } from '@twin-platform/studio-sdk';

/** 通用检视页；领域页的名字、顺序与实现只由展示插件提供。 */
export type { InspectorTab } from '@twin-platform/studio-sdk';
export interface SceneProfile extends InspectorProfile {
  readonly id: string;
}

/* 检视栏只剩两页：挑实体、管插件。审计/事件/对比归时间轴透镜，
   场景切换归画布切换层，数据源与云端配置归「更多」弹窗——同一功能不留两份入口。 */
const BASE_TABS: readonly InspectorTab[] = [
  { id: 'entity', icon: 'cube', label: '实体' },
  { id: 'plugins', icon: 'plug', label: '插件' },
];
const LOGISTICS: SceneProfile = {
  id: 'logistics', defaultTab: 'entity',
  tabs: [...BASE_TABS],
};
const GENERIC: SceneProfile = {
  id: 'generic', defaultTab: 'entity',
  tabs: [...BASE_TABS],
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
