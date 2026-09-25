import type { SceneTemplateDescriptor } from '@twin-platform/plugin-sdk';
import type { TwinEntity, TwinScene, TwinVector3 } from '@twin-platform/scene-schema';
import { calculateRigState, type TaidiaoInput } from './fishingCore';
import { fishingLayout, type FishingLayout } from './fishSim';

/**
 * 台钓钓场场景模板。
 *
 * 一个 `rig` 逻辑实体（干净、可调、可回放） + 一处水面 + 七个只读布局实体
 * （浮漂 / 铅坠 / **8 字环** / 上钩 / 下钩 / 上饵 / 下饵）。布局实体没有自己的
 * 逻辑，位置每步由 fish-sim 按当前调钓算出来。
 *
 * 实体之间的**连线不是模板的事**：拓扑在 `rigPosture.RIG_LINKS` 里（唯一真相），
 * 3D 由 studio 的 buildRigMarker 读它生成，2D 剖面同理。
 *
 * 布局实体的**初始位置也用 fishingLayout 计算**——以前是手写估值，世界还没
 * 推进第一帧时剖面沙盒的"图与 FishSim 写入一致"核对会报 0.9m 级偏差。
 * 模板与行为共用同一份布局函数，首帧即一致。
 *
 * 另有一批**装饰实体**（鱼竿 / 水底 / 水草 / 鱼影）：没有 slot、不参与布局
 * 与仿真，只负责让画面读起来是"一个钓场"而不是几个悬浮几何体。
 */

export type LayoutSlot = 'float' | 'sinker' | 'swivel' | 'upperHook' | 'lowerHook' | 'upperBait' | 'lowerBait';

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

/** 装饰实体：无 rigId / 无 slot，布局行为与剖面核对都会跳过它。 */
const decorEntity = (
  id: string,
  kind: string,
  position: TwinVector3,
  color: string,
  size: TwinVector3,
): TwinEntity => ({
  id,
  kind,
  transform: { position },
  capabilities: [kind],
  visual: { kind, color, size },
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
    const input: TaidiaoInput = {
      t0: rig.t0 ?? 4,
      t: rig.t ?? 2,
      w: rig.w ?? 1,
      d: rig.d ?? 2,
    };

    // 初始布局与 fish-sim 每步写入用同一份函数；参数非法（外部传入乱值）时
    // 退回水面附近的一组安全估值，至少保证场景能打开。
    const rigResult = calculateRigState(input);
    const layout: FishingLayout = rigResult.ok
      ? fishingLayout(input, rigResult.state, { surfaceY, depth, hookGap: 0.2 })
      : {
          float: [0, surfaceY, 0],
          sinker: [0, surfaceY - 1, 0],
          swivel: [0, surfaceY - 1.1, 0],
          lowerHook: [0, surfaceY - 1.3, 0],
          lowerBait: [0, surfaceY - 1.3, 0],
          upperHook: [0, surfaceY - 1.1, 0],
          upperBait: [0, surfaceY - 1.1, 0],
        };

    // 鱼竿两端：握把搁在岸上钓箱旁，竿梢伸到水面上方（主线从这里出发）。
    // 朝向不烘死在模型里：这里给出"竿梢相对竿中心的偏移"，studio 的 buildRod 照它摆，
    // 模板与模型共用同一组端点，不会各画一套。
    const rodTip: TwinVector3 = [0.85, surfaceY + 0.32, 0.5];
    const rodGrip: TwinVector3 = [2.5, 0.55, 1.75];
    const rodCenter: TwinVector3 = [
      (rodTip[0] + rodGrip[0]) / 2,
      (rodTip[1] + rodGrip[1]) / 2,
      (rodTip[2] + rodGrip[2]) / 2,
    ];
    const rodTipOffset: TwinVector3 = [
      (rodTip[0] - rodGrip[0]) / 2,
      (rodTip[1] - rodGrip[1]) / 2,
      (rodTip[2] - rodGrip[2]) / 2,
    ];

    return [
      {
        id: 'pond-01',
        kind: 'water',
        transform: { position: [0, surfaceY - depth / 2, 0] },
        capabilities: ['water'],
        visual: { kind: 'water', color: '#2E86AB', size: [8, depth, 5] },
        config: { depth, waterTemperature },
      },
      // 水底泥沙：贴地薄板，透过半透明水体看得见，钓场才有"底"。
      decorEntity('bottom-01', 'pondBottom', [0, 0.04, 0], '#d9c49a', [8, 0.08, 5]),
      // 岸坡垫片：比水体大一圈，池子嵌在岸里而不是悬在网格上。
      decorEntity('shore-01', 'shore', [0, 0.025, 0], '#d8c69b', [9.6, 0.05, 6.6]),
      // 钓台（钓箱）在岸边、鱼竿从它后面斜指水面。
      decorEntity('platform-01', 'platform', [2.75, 0, 1.85], '#c94f3d', [0.62, 0.34, 0.45]),
      {
        id: 'rod-01',
        kind: 'rod',
        transform: { position: rodCenter },
        capabilities: ['rod'],
        visual: { kind: 'rod', color: '#8a5a2b', size: [0.07, 2.7, 0.07] },
        config: { tipOffset: rodTipOffset },
      },
      // 竿梢导线环：主线（RIG_LINKS 第一段）的起点，位置就是上面那个端点。
      decorEntity('rod-tip-01', 'rodTip', rodTip, '#c9ccd1', [0.06, 0.06, 0.06]),
      // 岸边芦苇两丛、水里水草两丛、鱼影三条：位置固定（装饰不做行为，避免破坏确定性回放）。
      // 鱼影避开钓组所在的中间一列（x∈[−1, 1.5]）：钩被拖向 +X、V 字向两侧张，别让装饰挡住钩。
      decorEntity('reed-01', 'reed', [-3.6, 0, 2.4], '#8a6a45', [0.5, 1.0, 0.2]),
      decorEntity('reed-02', 'reed', [3.8, 0, -2.2], '#8a6a45', [0.45, 0.9, 0.2]),
      decorEntity('weed-01', 'weed', [-1.5, 0.18, 0.9], '#4c7a3f', [0.5, 0.36, 0.3]),
      decorEntity('weed-02', 'weed', [1.9, 0.16, -0.7], '#5d8a4a', [0.4, 0.32, 0.28]),
      decorEntity('fish-01', 'fish', [-1.9, 0.55, -0.6], '#5c6b73', [0.42, 0.16, 0.1]),
      decorEntity('fish-02', 'fish', [2.4, 0.45, -1.2], '#6b7a83', [0.34, 0.13, 0.09]),
      decorEntity('fish-03', 'fish', [-2.6, 0.75, 1.2], '#57666f', [0.28, 0.11, 0.08]),
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
          t0: input.t0,
          t: input.t,
          w: input.w,
          d: input.d,
          casts: 0,
          bites: 0,
          catches: 0,
          emptyHooks: 0,
          nextAt: 0,
          zone: 'neutral',
        },
      },
      layoutEntity('float-01', 'float', 'float', [...layout.float] as TwinVector3, { color: '#ff7a3c', size: [0.1, 0.42, 0.1] }),
      layoutEntity('sinker-01', 'sinker', 'sinker', [...layout.sinker] as TwinVector3, { color: '#4a4a4a', size: [0.06, 0.07, 0.06] }),
      // 8 字环：主线与两根子线的分叉点。模板没有专属造型，复用金属球即可，
      // 真正"环"的样子交给 3D 渲染层的 buildSwivel（torus）。
      layoutEntity('swivel-01', 'swivel', 'swivel', [...layout.swivel] as TwinVector3, { color: '#b08d57', size: [0.05, 0.05, 0.05] }),
      layoutEntity('hook-upper-01', 'hook', 'upperHook', [...layout.upperHook] as TwinVector3, { color: '#c9ccd1', size: [0.06, 0.07, 0.06] }),
      layoutEntity('hook-lower-01', 'hook', 'lowerHook', [...layout.lowerHook] as TwinVector3, { color: '#c9ccd1', size: [0.06, 0.07, 0.06] }),
      layoutEntity('bait-upper-01', 'bait', 'upperBait', [...layout.upperBait] as TwinVector3, { color: '#e07a5f', size: [0.06, 0.06, 0.06] }),
      layoutEntity('bait-lower-01', 'bait', 'lowerBait', [...layout.lowerBait] as TwinVector3, { color: '#e07a5f', size: [0.06, 0.06, 0.06] }),
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
