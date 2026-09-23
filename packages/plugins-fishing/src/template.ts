import type { SceneTemplateDescriptor } from '@twin-platform/plugin-sdk';
import type { TwinEntity, TwinScene, TwinVector3 } from '@twin-platform/scene-schema';
import type { TaidiaoInput } from './fishingCore';

/**
 * 台钓钓场场景模板。
 *
 * 一个 `rig` 逻辑实体（干净、可调、可回放） + 一处水面 + 六个只读布局实体
 * （浮漂 / 铅坠 / 上钩 / 下钩 / 上饵 / 下饵）。布局实体没有自己的逻辑，位置
 * 每步由 fish-sim 按当前调钓算出来。
 */

export type LayoutSlot = 'float' | 'sinker' | 'upperHook' | 'lowerHook' | 'upperBait' | 'lowerBait';

export interface FishingTemplateParams {
  readonly rig?: Partial<TaidiaoInput>;
  readonly label?: string;
  readonly waterTemperature?: number;
  readonly depth?: number;
  readonly castInterval?: number;
  readonly targetFish?: string;
}

const RIG_ID = 'rig-01';

const layoutEntity = (
  id: string,
  kind: string,
  slot: LayoutSlot,
  position: TwinVector3,
  visual: { color: string; size: TwinVector3 },
): TwinEntity => ({
  id,
  kind,
  transform: { position },
  capabilities: [kind],
  visual: { kind, color: visual.color, size: visual.size },
  config: { rigId: RIG_ID, slot },
});

export const fishingTemplate: SceneTemplateDescriptor<FishingTemplateParams> = {
  id: 'fishing-pond',
  label: '台钓钓场（漂语）',
  build(params: FishingTemplateParams = {}): TwinEntity[] {
    const depth = Math.max(0.5, params.depth ?? 2);
    // 水底贴地：Studio 的地面平面在 y=0，水必须从 0 往上长到 depth。
    // 放在 0 以下会被那块 64×64 的实心地面挡住，切到钓场就什么都看不到。
    const surfaceY = depth;
    const waterTemperature = params.waterTemperature ?? 20;
    const castInterval = Math.max(0.5, params.castInterval ?? 3);
    const rig = params.rig ?? {};

    return [
      {
        id: 'pond-01',
        kind: 'water',
        transform: { position: [0, surfaceY - depth / 2, 0] },
        capabilities: ['water'],
        visual: { kind: 'water', color: '#2E86AB', size: [12, depth, 8] },
        config: { depth, waterTemperature },
      },
      {
        id: RIG_ID,
        kind: 'rig',
        transform: { position: [0, surfaceY, 0] },
        capabilities: ['rig'],
        visual: { kind: 'rig', color: '#c9b79c', size: [0.1, 0.1, 0.1] },
        config: {
          label: params.label ?? '我的钓组',
          depth,
          surfaceY,
          hookGap: 0.2,
          waterTemperature,
          castInterval,
          targetFish: params.targetFish ?? '鲫鱼',
        },
        attrs: {
          t0: rig.t0 ?? 4,
          t: rig.t ?? 2,
          w: rig.w ?? 1,
          d: rig.d ?? 2,
          casts: 0,
          bites: 0,
          catches: 0,
          emptyHooks: 0,
          nextAt: 0,
          zone: 'neutral',
        },
      },
      layoutEntity('float-01', 'float', 'float', [0, surfaceY, 0], { color: '#ff7a3c', size: [0.1, 0.42, 0.1] }),
      layoutEntity('sinker-01', 'sinker', 'sinker', [0, surfaceY - 1, 0], { color: '#4a4a4a', size: [0.06, 0.07, 0.06] }),
      layoutEntity('hook-upper-01', 'hook', 'upperHook', [0, surfaceY - 0.6, 0], { color: '#c9ccd1', size: [0.06, 0.07, 0.06] }),
      layoutEntity('hook-lower-01', 'hook', 'lowerHook', [0, surfaceY - 0.8, 0], { color: '#c9ccd1', size: [0.06, 0.07, 0.06] }),
      layoutEntity('bait-upper-01', 'bait', 'upperBait', [0, surfaceY - 0.6, 0], { color: '#e07a5f', size: [0.06, 0.06, 0.06] }),
      layoutEntity('bait-lower-01', 'bait', 'lowerBait', [0, surfaceY - 0.8, 0], { color: '#e07a5f', size: [0.06, 0.06, 0.06] }),
    ];
  },
};

export function buildFishingScene(params: FishingTemplateParams = {}): TwinScene {
  return {
    version: 1,
    id: 'fishing-pond',
    name: '台钓钓场（漂语）',
    entities: fishingTemplate.build(params),
  };
}
