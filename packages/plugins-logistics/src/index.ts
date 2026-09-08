import type { PluginInstance, SceneTemplateDescriptor, TwinPlugin } from '@twin-platform/plugin-sdk';
import { PLUGIN_SDK_VERSION } from '@twin-platform/plugin-sdk';
import { createLogisticsBehavior } from './behavior';
import { createAsrsBehavior } from './asrs';
import { createTransferBehavior } from './transfer';
import { lineMetricsDescriptors } from './metrics';
import { lineTemplate, factoryTemplate, centerTemplate } from './template';

/**
 * `logistics` 插件：把"输送线"这门领域语义装进世界，而不改一行内核。
 *
 * 装好之后，宿主（Studio / 回放任务）得到三样东西：
 * - 行为 `logistics-flow`：包裹流转事件 + 设备忙闲状态；
 * - 行为 `asrs-cycle`：堆垛机行走 / 起升 / 货叉伸缩 + 出入库事件；
 * - 行为 `transfer-cycle`：顶升移栽机顶升/分流，只抬该拐弯的货，其余直着滚过去；
 * - 指标 `throughput` / `busy-duration`（其余四项由 analytics-core 的 lineMetrics 直接算）；
 * - 场景模板 `logistics-line` / `logistics-factory` / `logistics-center`。
 */

export const logisticsPlugin: TwinPlugin = {
  manifest: {
    id: 'logistics',
    version: '0.2.0',
    sdkVersion: '^0.1.0',
    name: '物流（输送线 · 工厂 · 立库）',
    description:
      '输送线、检测、缓存、分拣、立体仓库、顶升移栽的领域语义：包裹流转事件 + 设备忙闲状态 + 堆垛机存取循环 + 顶升分流 + 产线/工厂指标。含 logistics-line、logistics-factory、logistics-center 三个场景模板。',
    capabilities: ['behavior', 'analytics', 'scene-template'],
  },
  activate(): PluginInstance {
    return {
      behaviors: [createLogisticsBehavior(), createAsrsBehavior(), createTransferBehavior()],
      metrics: lineMetricsDescriptors,
      templates: [
        lineTemplate as unknown as SceneTemplateDescriptor,
        factoryTemplate as unknown as SceneTemplateDescriptor,
        centerTemplate as unknown as SceneTemplateDescriptor,
      ],
    };
  },
};

export { createLogisticsBehavior } from './behavior';
export { createAsrsBehavior } from './asrs';
export { createTransferBehavior } from './transfer';
export { buildLineScene, lineTemplate, type LineTemplateParams } from './template';
export { buildFactoryScene, factoryTemplate, type FactoryTemplateParams } from './template';
export { buildCenterScene, centerTemplate, splitClosedLoop, type CenterTemplateParams } from './template';
export { lineMetricsDescriptors } from './metrics';
export {
  asrsRack,
  bufferRack,
  conveyorSegment,
  inspectionStation,
  liftTransfer,
  liftTransferCassette,
  pallet,
  parcel,
  stackerCarriage,
  stackerCrane,
  stackerFork,
} from './devices';
