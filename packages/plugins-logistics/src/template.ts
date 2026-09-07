import type { ConfigValue, SceneTemplateDescriptor } from '@twin-platform/plugin-sdk';
import type { TwinEntity, TwinScene, TwinVector3 } from '@twin-platform/scene-schema';
import { bufferRack, conveyorSegment, inspectionStation, parcel } from './devices';

export interface LineTemplateParams {
  /** 同时在线包裹数，默认 5。 */
  parcels?: number;
  /** 产线中心线长度（米），默认 20。 */
  length?: number;
  /** 包裹基础速度（m/s），默认 1.6。 */
  baseSpeed?: number;
}

/**
 * "一段物流输送线"场景模板：把可复用的产线片段参数化成实体列表。
 *
 * 由入料输送线、检测站、缓存货架与若干循环包裹组成。包裹速度按序号递增，
 * 因此它们绕圈时机错开——积压与吞吐会自然波动，而不是齐刷刷地一起进一起出。
 */
export const lineTemplate: SceneTemplateDescriptor<LineTemplateParams> = {
  id: 'logistics-line',
  label: '物流输送线',
  build(params: LineTemplateParams = {}) {
    const count = params.parcels ?? 5;
    const length = params.length ?? 20;
    const base = params.baseSpeed ?? 1.6;
    const path: TwinVector3[] = [
      [-length / 2, 1.15, 0],
      [length / 2, 1.15, 0],
    ];

    const entities: TwinEntity[] = [
      conveyorSegment('belt-in', [-length / 2 - 1.5, 0.6, 0], { label: '入料输送线' }),
      inspectionStation('scan-01', [0, 0.9, 0], 1.6),
      bufferRack('buffer-01', [length / 2 + 1.5, 1, 0]),
    ];

    for (let index = 0; index < count; index += 1) {
      entities.push(parcel(`parcel-${index + 1}`, path, base + index * 0.12, { label: `在制物料 ${index + 1}` }));
    }
    return entities;
  },
};

/** 把模板产出的实体组装成可直接喂给 `TwinWorld` 的场景。 */
export function buildLineScene(params: LineTemplateParams = {}): TwinScene {
  return {
    version: 1,
    id: 'logistics-line',
    name: '物流输送线',
    entities: lineTemplate.build(params),
  };
}

export type { ConfigValue };
