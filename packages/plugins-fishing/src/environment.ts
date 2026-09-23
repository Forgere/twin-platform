import type { Decision, Environment, Outcome } from '@twin-platform/decision-core';
import { TwinWorld, type WorldEntityState } from '@twin-platform/world-kernel';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { FishingActionId } from './actionSpace';
import { calculateRigState, type TaidiaoInput } from './fishingCore';
import { createFishSimBehavior, fishingLayout, type FishingLayout } from './fishSim';
import { toFishingState, type FishingIntent, type FishingState } from './state';
import { buildFishingScene, type FishingTemplateParams } from './template';
import { num, str } from './values';

/**
 * FishingEnvironment —— 把钓场仿真接到 decision-core 的 `Environment` 端口。
 *
 *   observe()  world -> FishingState（调钓状态 + 累计观察）
 *   step()     应用一个动作，推进固定时长，返回这一段的咬钩 / 中鱼结果
 *
 * 这样 Phase 0/1 的 Fishing Core 与规则 Judge 就能在仿真里跑完整闭环，
 * 产出"决策 -> 结果"的记录，不必等真实出钓。
 */

const RIG_ID = 'rig-01';

/** 只读世界：让观察既能用于 TwinWorld，也能用于任何提供 getEntity 的世界。 */
export interface WorldReader {
  getEntity(id: string): WorldEntityState | undefined;
}

/**
 * 从任意世界读出当前台钓状态。
 *
 * 场景里没有 rig 实体时返回 undefined（调用方据此判断"这不是钓场"）；
 * 有 rig 但参数不合法时抛错——那是配置错误，不该静默。
 */
export function observeFishingWorld(world: WorldReader, rigId = RIG_ID): FishingState | undefined {
  const entity = world.getEntity(rigId);
  if (!entity) return undefined;
  const config = entity.config ?? {};
  const input: TaidiaoInput = {
    t0: num(entity.attrs.t0, 4),
    t: num(entity.attrs.t, 2),
    w: num(entity.attrs.w, 1),
    d: num(entity.attrs.d, 2),
  };
  const result = calculateRigState(input);
  if (!result.ok) throw new Error('钓场里的钓组参数不合法。');

  const observation = {
    bites: num(entity.attrs.bites, 0),
    catches: num(entity.attrs.catches, 0),
    emptyHooks: num(entity.attrs.emptyHooks, 0),
  };
  const drift = config.drift === true;
  const targetFish = str(config.targetFish, '');
  return toFishingState(result.state, {
    intent: deriveIntent(observation, drift, num(entity.attrs.casts, 0)),
    drift,
    observation,
    ...(targetFish === '' ? {} : { targetFish }),
  });
}

export interface FishingView {
  readonly state: FishingState;
  readonly layout: FishingLayout;
  readonly depth: number;
  readonly surfaceY: number;
  readonly hookGap: number;
  readonly castInterval: number;
}

/**
 * 视图模型：把"钓组状态 + 场景几何"一次算好，给 2D / 3D 画图用。
 *
 * 画图与行为读同一份 `fishingLayout`，所以剖面视图同时是 FishSim 的可视化测试工具：
 * 图上位置就是行为写进世界的位置，对不上就是有 bug。
 */
export function fishingView(world: WorldReader, rigId = RIG_ID): FishingView | undefined {
  const entity = world.getEntity(rigId);
  if (!entity) return undefined;
  const state = observeFishingWorld(world, rigId);
  if (!state) return undefined;

  const config = entity.config ?? {};
  const depth = Math.max(0.5, num(config.depth, 2));
  const surfaceY = num(config.surfaceY, 0);
  const hookGap = Math.max(0.05, num(config.hookGap, 0.2));
  const layout = fishingLayout(
    { t0: state.rig.t0, t: state.rig.t, w: state.rig.w, d: state.rig.d },
    state.rig,
    { surfaceY, depth, hookGap },
  );
  return { state, layout, depth, surfaceY, hookGap, castInterval: Math.max(0.5, num(config.castInterval, 3)) };
}

export interface FishingEnvironmentOptions {
  readonly seed?: number;
  readonly step?: number;
  /** 每次 step 推进的仿真秒数（决策后观察多久）。 */
  readonly horizon?: number;
  readonly scene?: TwinScene;
  readonly template?: FishingTemplateParams;
}

interface Counters {
  readonly casts: number;
  readonly bites: number;
  readonly catches: number;
}

function deriveIntent(observation: { bites: number; catches: number; emptyHooks: number }, drift: boolean, casts: number): FishingIntent {
  if (drift) return 'drift';
  if (casts === 0) return 'none';
  const settled = observation.catches + observation.emptyHooks;
  const emptyRatio = settled <= 0 ? 0 : observation.emptyHooks / settled;
  if (observation.bites >= 3 && emptyRatio >= 0.5) return 'bite_no_catch';
  if (observation.bites === 0 && casts >= 3) return 'no_bite';
  return 'none';
}

export class FishingEnvironment implements Environment<FishingState, FishingActionId> {
  readonly world: TwinWorld;
  private readonly horizon: number;

  constructor(options: FishingEnvironmentOptions = {}) {
    this.horizon = Math.max(1 / 60, options.horizon ?? 60);
    const scene = options.scene ?? buildFishingScene(options.template ?? {});
    this.world = new TwinWorld(scene, {
      seed: options.seed ?? 1,
      maxStepsPerAdvance: 600,
      behaviors: [createFishSimBehavior()],
    });
  }

  observe(): FishingState {
    const state = observeFishingWorld(this.world);
    if (!state) throw new Error('钓场缺少 rig 实体。');
    return state;
  }

  step(decision: Decision<FishingActionId>): Outcome {
    const before = this.counters();
    this.apply(decision.action, decision.params);
    const steps = Math.max(1, Math.round(this.horizon / this.world.stepSize));
    this.world.runSteps(steps);
    const after = this.counters();

    const casts = after.casts - before.casts;
    const bites = after.bites - before.bites;
    const catches = after.catches - before.catches;
    return {
      at: this.world.time,
      metrics: {
        casts,
        bites,
        catches,
        biteRate: casts === 0 ? 0 : bites / casts,
        catchRate: casts === 0 ? 0 : catches / casts,
      },
    };
  }

  /** 只有调漂会改钓组；其它动作在仿真里是 no-op（真实世界里由人执行）。 */
  private apply(action: FishingActionId, params: Readonly<Record<string, number | string>>): void {
    if (action !== 'ADJUST_FLOAT') return;
    const direction = str(params['direction'], 'blunt');
    const steps = num(params['steps'], 1);
    // 往钝 = 上推浮漂 = 钓目增大；往灵 = 下推 = 钓目减小。
    const delta = direction === 'blunt' ? steps : -steps;
    const current = num(this.world.getEntity(RIG_ID)?.attrs.d, 2);
    this.world.setAttr(RIG_ID, 'd', Math.max(0, current + delta));
  }

  private counters(): Counters {
    const attrs = this.world.getEntity(RIG_ID)?.attrs ?? {};
    return { casts: num(attrs.casts, 0), bites: num(attrs.bites, 0), catches: num(attrs.catches, 0) };
  }
}
