import type { BehaviorContext, WorldBehavior } from '@twin-platform/world-kernel';
import type { TwinVector3 } from '@twin-platform/scene-schema';
import { calculateRigState, type RigState, type RigZone, type TaidiaoInput } from './fishingCore';
import { BITE_SIGNALS, subLineBend, type FloatSignal } from './rigPosture';
import { conditionMultipliers, conditionsOf } from './conditions';
import { loadoutEffects, loadoutFromAttrs } from './loadout';
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
  /** 8 字环：主线与两根子线的分叉点。 */
  readonly swivel: TwinVector3;
  readonly upperHook: TwinVector3;
  readonly lowerHook: TwinVector3;
  readonly upperBait: TwinVector3;
  readonly lowerBait: TwinVector3;
}

/**
 * 链上间距（米），以 2.2m 水深为基准；浅水按 `scale` 整体缩小，免得线组捅出水面。
 * 顺序按真实线组自下而上：下钩 → 上钩（钩距）→ 8 字环（短子线）→ 铅皮座。
 */
const HOOK_CLEARANCE = 0.1; // 下钩完全到底时离底的高度（钩有大小，不可能压进泥里）
const HOVER_LIFT = 0.35; // 完全离底时下钩离底的高度
const SUBLINE_SHORT = 0.22; // 短子线：8 字环 → 上钩（长子线 = 短子线 + 钩距）
const SWIVEL_SINK = 0.14; // 钝到头时 8 字环额外下沉量——下钩已到底，多出来的线只能弯
const LEAD_TO_SWIVEL = 0.1; // 铅皮座 → 8 字环
const MARK_HEIGHT = 0.02; // 漂尾一目 ≈ 2cm

/**
 * 钓组布局：**自上而下一条链**，与 `RIG_LINKS` 的拓扑一致。
 *
 * - 下钩离底高度由"底承托了多少"决定：底托得越多，线组整体越往下沉到贴底；
 * - 8 字环在下钩到底后还会继续下沉（子线起弯，见 `subLineBend`）——这就是
 *   "钝"的样子：钩不动、线松了，信号传不上来；
 * - 浮漂露出 d 目 → 漂身随之上移（d 越大水线越长、钩饵越到底）。
 *
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
  const bend = subLineBend(state, 'lower');
  const scale = Math.min(1, depth / 2.2);

  const lowerHookY = bottomY + (HOOK_CLEARANCE + HOVER_LIFT * (1 - supported)) * scale;
  const upperHookY = lowerHookY + hookGap * scale;
  const swivelY = upperHookY + (SUBLINE_SHORT - SWIVEL_SINK * bend) * scale;
  const sinkerY = swivelY + LEAD_TO_SWIVEL * scale;

  // 浅水兜底：整条链必须留在水里，且保持"上钩在 8 字环下方、8 字环在铅坠下方"。
  const sinkerYc = Math.min(sinkerY, surfaceY - 0.28 * scale);
  const swivelYc = Math.min(swivelY, sinkerYc - LEAD_TO_SWIVEL * scale);
  const upperHookYc = Math.min(upperHookY, swivelYc - 0.06 * scale);
  const lowerHookYc = Math.min(lowerHookY, Math.max(bottomY + 0.03, upperHookYc - hookGap * scale));
  const floatY = surfaceY - 0.1 + MARK_HEIGHT * input.d;

  return {
    float: [0, floatY, 0],
    sinker: [0, sinkerYc, 0],
    swivel: [0, swivelYc, 0],
    lowerHook: [0, lowerHookYc, 0],
    lowerBait: [0, lowerHookYc, 0],
    upperHook: [0, upperHookYc, 0],
    upperBait: [0, upperHookYc, 0],
  };
}

export interface FishSimConfig {
  /** 抛竿结算间隔（秒），实体没声明时用它。 */
  castInterval?: number;
}

const SLOTS = ['float', 'sinker', 'swivel', 'upperHook', 'lowerHook', 'upperBait', 'lowerBait'] as const;

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

/**
 * 把子线弯曲量写进 attrs（渲染读它决定子线鼓多少）。
 * 四位小数够画了，也避免浮点抖动每帧都算一次"变化"。
 */
function writeBend(ctx: BehaviorContext, rigId: string, state: RigState): void {
  const entity = ctx.entities.find((item) => item.id === rigId);
  if (!entity) return;
  for (const [attr, value] of [
    ['bendLower', subLineBend(state, 'lower')],
    ['bendUpper', subLineBend(state, 'upper')],
  ] as const) {
    const rounded = Math.round(value * 1e4) / 1e4;
    if (num(entity.attrs[attr], -1) !== rounded) ctx.setAttr(rigId, attr, rounded);
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
        // 子线弯曲量给渲染用（3D 要把子线画成弯的）。只在变化时写，别把 ops 撑爆。
        writeBend(ctx, entity.id, result.state);

        const conditions = conditionsOf(entity);
        const waterTemperature = conditions.waterTemperature;
        const interval = Math.max(0.5, num(worldConfig.castInterval, defaultInterval));
        const nextAt = num(entity.attrs.nextAt, 0);
        if (ctx.time + 1e-9 < nextAt) continue;

        // 装备（目标鱼 / 钩 / 线 / 饵）与情况（走水 / 闹窝 / 窝料）只给倍率，随机仍全部取自 ctx.rng。
        const gear = loadoutEffects(loadoutFromAttrs(entity.attrs));
        const situation = conditionMultipliers(conditions, ctx.time);
        const zone = result.state.zone;
        const biteChance = clamp01(biteProbability(zone, waterTemperature) * gear.biteMul * gear.zoneBite[zone] * situation.bite);
        const hookChance = clamp01(hookProbability(zone, waterTemperature) * gear.hookMul * situation.hook);

        const casts = num(entity.attrs.casts, 0) + 1;
        const bit = ctx.rng.bool(biteChance);
        const hooked = bit && ctx.rng.bool(hookChance);
        // 中鱼后按子线拉力判切线；拉力富余（breakChance = 0）时不耗随机数。
        const broken = hooked && gear.breakChance > 0 && ctx.rng.bool(gear.breakChance);
        const caught = hooked && !broken;
        // 有口就有漂相（顿口 / 送漂 / 黑漂）——这是用户唯一能直接看到的信号。
        const signal: FloatSignal = bit ? ctx.rng.pick(BITE_SIGNALS) : 'none';

        ctx.setAttr(entity.id, 'casts', casts);
        ctx.setAttr(entity.id, 'bites', num(entity.attrs.bites, 0) + (bit ? 1 : 0));
        ctx.setAttr(entity.id, 'catches', num(entity.attrs.catches, 0) + (caught ? 1 : 0));
        ctx.setAttr(entity.id, 'emptyHooks', num(entity.attrs.emptyHooks, 0) + (bit && !hooked ? 1 : 0));
        if (broken) ctx.setAttr(entity.id, 'breaks', num(entity.attrs.breaks, 0) + 1);
        ctx.setAttr(entity.id, 'zone', result.state.zone);
        ctx.setAttr(entity.id, 'bottomLoad', result.state.bottomLoad);
        ctx.setAttr(entity.id, 'nextAt', ctx.time + interval);
        ctx.setAttr(entity.id, 'signal', signal);
        ctx.emit('fish:cast', {
          entityId: entity.id,
          payload: { cast: casts, zone: result.state.zone, bite: bit, caught, broken, signal },
        });
        if (broken) ctx.emit('fish:break', { entityId: entity.id, payload: { cast: casts } });
      }
    },
  };
}
