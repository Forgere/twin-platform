import type { PluginInstance, SceneTemplateDescriptor, TwinPlugin } from '@twin-platform/plugin-sdk';
import { PLUGIN_SDK_VERSION } from '@twin-platform/plugin-sdk';
import { createLogisticsBehavior } from './behavior';
import { lineMetricsDescriptors } from './metrics';
import { lineTemplate } from './template';

/**
 * `logistics` 插件：把"输送线"这门领域语义装进世界，而不改一行内核。
 *
 * 装好之后，宿主（Studio / 回放任务）得到三样东西：
 * - 行为 `logistics-flow`：包裹流转事件 + 设备忙闲状态；
 * - 指标 `throughput` / `busy-duration`（其余四项由 analytics-core 的 lineMetrics 直接算）；
 * - 场景模板 `logistics-line`：一键生成一段可仿真产线。
 */

export const logisticsPlugin: TwinPlugin = {
  manifest: {
    id: 'logistics',
    version: '0.1.0',
    sdkVersion: '^0.1.0',
    name: '物流输送线',
    description: '输送线、检测、缓存的领域语义：包裹流转事件 + 设备忙闲状态 + 产线指标。',
    capabilities: ['behavior', 'analytics', 'scene-template'],
  },
  activate(): PluginInstance {
    return {
      behaviors: [createLogisticsBehavior()],
      metrics: lineMetricsDescriptors,
      templates: [lineTemplate as unknown as SceneTemplateDescriptor],
    };
  },
};

export { createLogisticsBehavior } from './behavior';
export { buildLineScene, lineTemplate, type LineTemplateParams } from './template';
export { lineMetricsDescriptors } from './metrics';
export { bufferRack, conveyorSegment, inspectionStation, parcel } from './devices';
