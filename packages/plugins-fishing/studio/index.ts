import type { StudioPresentation } from '@twin-platform/studio-sdk';
import { createFishingWorkspace } from './workspace';
import { createFishingScenePresentation } from './scene/FishingScenePresentation';

/** 钓场的浏览器实现；纯仿真入口不引用本模块。 */
export const fishingPresentation: StudioPresentation = {
  pluginId: 'fishing',
  matches: (scene) => scene.entities.some((entity) => entity.id === 'rig-01' && entity.kind === 'rig'),
  // 只声明本插件真能渲染的页：事件流归时间轴透镜、场景切换归画布切换层。
  inspector: {
    tabs: [
      { id: 'rig', icon: 'rod', label: '钓组' },
      { id: 'entity', icon: 'cube', label: '实体' },
      { id: 'plugins', icon: 'plug', label: '插件' },
    ],
    defaultTab: 'rig',
    label: '钓组 / 面板',
  },
  createWorkspace: createFishingWorkspace,
  createScene: createFishingScenePresentation,
};
