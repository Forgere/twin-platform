import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';
import type { TwinVector3 } from '@twin-platform/scene-schema';
import { calculateRigState, type RigState, type RigZone, type TaidiaoInput } from './fishingCore';
import { num, str } from './values';

/**
 * FishSim —— 钓场的确定性鱼口模型。
 *
 * 它同时是教学沙盒的底层与决策评测的环境：
 * - 每次"抛竿"按当前灵钝与水温结算咬钩 / 中鱼；
 * - 全部随机取自 `ctx.rng`，计数写在实体 attrs 里（随快照恢复），所以可回放、可 seek；
 * - 位置是"当前状态"的纯函数，`seek()` 到任意帧都画得对。
 *
 * 模型被刻意设计成"偏好不灵不钝"：灵区有口但空竿多，钝区口少，未到底几乎没口。
 * 这样规则 Judge 的建议（有口不中 -> 往钝）在仿真里真的能改善结果，
 * 评测闭环才有意义。
 */

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const ZONE_BITE: Readonly<Record<RigZone, number>> = {
  off_bottom: 0.1,
  sensitive: 0.28,
  neutral: 0.4,
  blunt: 0.22,
  sinker_on_bottom: 0.12,
};

/** 中鱼率：灵区信号被放大，空竿多；不灵不钝最好。 */
const ZONE_HOOK: Readonly<Record<RigZone, number>> = {
  off_bottom: 0.5,
  sensitive: 0.42,
  neutral: 0.7,
  blunt: 0.55,
  sinker_on_bottom: 0.45,
};

/** 水温活跃度：18~24 度最高，两侧线性衰减。纯函数、无随机。 */
export function temperatureFactor(waterTemperature: number): number {
  if (!Number.isFinite(waterTemperature)) return 0.5;
  if (waterTemperature <= 4 || waterTemperature >= 34) return 0.2;
  if (waterTemperature < 18) return 0.2 + (0.8 * (waterTemperature - 4)) / 14;
  if (waterTemperature <= 24) return 1;
  return 1 - (0.8 * (waterTemperature - 24)) / 10;
}

export function biteProbability(zone: RigZone, waterTemperature = 20): number {
  return clamp01(ZONE_BITE[zone] * temperatureFactor(waterTemperature));
}

export function hookProbability(zone: RigZone, waterTemperature = 20): number {
  return clamp01(ZONE_HOOK[zone] * (0.6 + 0.4 * temperatureFactor(waterTemperature)));
}

export interface FishingLayout {
  readonly float: TwinVector3;
  readonly sinker: TwinVector3;
  readonly upperHook: TwinVector3;
  readonly lowerHook: TwinVector3;
  readonly upperBait: TwinVector3;
  readonly lowerBait: TwinVector3;
}

/**
 * 简化布局：水面在 `surfaceY`，水底在 `surfaceY - depth`。
 * 不追求物理精确——2D 剖面与 3D 场景读的是同一份布局，只有一个真相。
 */
export function fishingLayout(
  input: TaidiaoInput,
  state: RigState,
  options: { surfaceY?: number; depth?: number; hookGap?: number } = {},
): FishingLayout {
  const surfaceY = options.surfaceY ?? 0;
  const depth = Math.max(0.2, options.depth ?? 2);
  const hookGap = Math.max(0.05, options.hookGap ?? 0.2);
  const bottomY = surfaceY - depth;
  const maxLoad = state.H + 2 * state.w;
  const supported = maxLoad <= 0 ? 0 : clamp01(state.bottomLoad / maxLoad);
  const floatY = surfaceY - 0.02 * input.d;
  const sinkerY = bottomY + 0.45 - 0.3 * supported;
  const lowerHookY = bottomY + 0.12 + 0.33 * (1 - supported);
  const upperHookY = lowerHookY + hookGap;
  return {
    float: [0, floatY, 0],
    sinker: [0, sinkerY, 0],
    lowerHook: [0, lowerHookY, 0],
    lowerBait: [0, lowerHookY, 0],
    upperHook: [0, upperHookY, 0],
    upperBait: [0, upperHookY, 0],
  };
}

export interface FishSimConfig {
  /** 抛竿结算间隔（秒），实体没声明时用它。 */
  castInterval?: number;
}

const SLOTS = ['float', 'sinker', 'upperHook', 'lowerHook', 'upperBait', 'lowerBait'] as const;

function writeLayout(ctx: BehaviorContext, rigId: string, input: TaidiaoInput, state: RigState, config: Record<string, unknown>): void {
  const layout = fishingLayout(input, state, {
    surfaceY: num(config.surfaceY, 0),
    depth: num(config.depth, 2),
    hookGap: num(config.hookGap, 0.2),
  });
  for (const entity of ctx.entities) {
    const slot = str(entity.config?.slot, '');
    if (str(entity.config?.rigId, '') !== rigId) continue;
    const position = SLOTS.find((candidate) => candidate === slot);
    if (!position) continue;
    const target = layout[position];
    ctx.setTransform(entity.id, { ...entity.transform, position: [target[0], target[1], target[2]] });
  }
}

export function createFishSimBehavior(config: FishSimConfig = {}): WorldBehavior {
  const defaultInterval = Math.max(0.5, config.castInterval ?? 3);

  return {
    id: 'fish-sim',
    step(ctx: BehaviorContext): void {
      for (const entity of ctx.entities) {
        if (!entity.capabilities.includes('rig')) continue;

        const worldConfig = entity.config ?? {};
        const input: TaidiaoInput = {
          t0: num(entity.attrs.t0, 4),
          t: num(entity.attrs.t, 2),
          w: num(entity.attrs.w, 1),
          d: num(entity.attrs.d, 2),
        };
        const result = calculateRigState(input);
        if (!result.ok) continue;

        // 位姿每步刷新（seek 到任意帧都画得对），与是否结算无关。
        writeLayout(ctx, entity.id, input, result.state, worldConfig);

        const waterTemperature = num(worldConfig.waterTemperature, 20);
        const interval = Math.max(0.5, num(worldConfig.castInterval, defaultInterval));
        const nextAt = num(entity.attrs.nextAt, 0);
        if (ctx.time + 1e-9 < nextAt) continue;

        const casts = num(entity.attrs.casts, 0) + 1;
        const bit = ctx.rng.bool(biteProbability(result.state.zone, waterTemperature));
        const hooked = bit && ctx.rng.bool(hookProbability(result.state.zone, waterTemperature));

        ctx.setAttr(entity.id, 'casts', casts);
        ctx.setAttr(entity.id, 'bites', num(entity.attrs.bites, 0) + (bit ? 1 : 0));
        ctx.setAttr(entity.id, 'catches', num(entity.attrs.catches, 0) + (hooked ? 1 : 0));
        ctx.setAttr(entity.id, 'emptyHooks', num(entity.attrs.emptyHooks, 0) + (bit && !hooked ? 1 : 0));
        ctx.setAttr(entity.id, 'zone', result.state.zone);
        ctx.setAttr(entity.id, 'bottomLoad', result.state.bottomLoad);
        ctx.setAttr(entity.id, 'nextAt', ctx.time + interval);
        ctx.emit('fish:cast', {
          entityId: entity.id,
          payload: { cast: casts, zone: result.state.zone, bite: bit, caught: hooked },
        });
      }
    },
  };
}
