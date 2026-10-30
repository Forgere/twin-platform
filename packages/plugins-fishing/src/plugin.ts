import type {
  DecisionDomainDescriptor,
  PluginInstance,
  SceneTemplateDescriptor,
  TwinPlugin,
} from '@twin-platform/plugin-sdk';
import { fishingDomain } from './domain';
import { createFishSimBehavior } from './fishSim';
import { fishingTemplate } from './template';

/**
 * 台钓决策域的内核描述符。
 *
 * 把领域决策域（FishingState -> FishingAction）交给插件宿主。判断者可以是规则
 * 基线，也可以是 Jev —— 宿主只看到 DecisionDomain 这个端口。
 */
export const fishingDecisionDescriptor: DecisionDomainDescriptor = {
  ...fishingDomain,
  label: '台钓（漂语）',
};

/**
 * fishingPlugin —— 台钓领域插件。
 *
 * 贡献三样东西：
 * - `decision`：调钓状态 -> 可校验、带置信度的下一步动作；
 * - `behavior`：`fish-sim` 确定性鱼口模型（可回放、可 seek）；
 * - `scene-template`：`fishing-pond` 钓场场景。
 */
export const fishingPlugin: TwinPlugin = {
  manifest: {
    id: 'fishing',
    version: '0.2.0',
    sdkVersion: '^0.1.0',
    name: '台钓（漂语）',
    description:
      '台钓调钓计算、封闭动作空间与规则决策域，外加确定性鱼口模型（fish-sim）与钓场场景模板（fishing-pond）。',
    capabilities: ['decision', 'behavior', 'scene-template'],
  },
  activate(): PluginInstance {
    return {
      decisions: [fishingDecisionDescriptor],
      behaviors: [createFishSimBehavior()],
      templates: [fishingTemplate as unknown as SceneTemplateDescriptor],
    };
  },
};
