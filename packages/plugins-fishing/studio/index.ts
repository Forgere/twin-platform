import type { StudioPresentation } from '@twin-platform/studio-sdk';
import { createFishingWorkspace } from './workspace';
import { createFishingScenePresentation } from './scene/FishingScenePresentation';

/** 钓场的浏览器实现；纯仿真入口不引用本模块。 */
export const fishingPresentation: StudioPresentation = {
  pluginId: 'fishing',
  matches: (scene) => scene.entities.some((entity) => entity.id === 'rig-01' && entity.kind === 'rig'),
  inspector: {
    tabs: [
      { id: 'rig', icon: '🎣', label: '钓组' },
      { id: 'entity', icon: '🧩', label: '实体' },
      { id: 'events', icon: '📜', label: '事件' },
      { id: 'scene', icon: '🗂️', label: '场景' },
      { id: 'plugins', icon: '🔌', label: '插件' },
    ],
    defaultTab: 'rig',
    label: '钓组 / 面板',
  },
  createWorkspace: createFishingWorkspace,
  createScene: createFishingScenePresentation,
};
