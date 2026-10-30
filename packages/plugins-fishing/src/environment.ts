import type { Decision, Environment, Outcome } from '@twin-platform/decision-core';
import { TwinWorld, type WorldEntityState } from '@twin-platform/world-kernel';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { FishingActionId } from './actionSpace';
import { calculateRigState, type TaidiaoInput } from './fishingCore';
import { createFishSimBehavior, fishingLayout, type FishingLayout } from './fishSim';
import { isMeasurePhase, measureLayout, measureMarks, rigPartsOf, rigPhaseOf, type RigPhase } from './rigPhase';
import { toFishingState, type FishingIntent, type FishingState } from './state';
import { buildFishingScene, type FishingTemplateParams } from './template';
import { num, str } from './values';
import type { FloatSignal } from './rigPosture';
import { conditionsOf } from './conditions';
import { fishById, loadoutFromAttrs, recommendedLoadout, TARGET_FISH, type BaitId } from './loadout';

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
  const drift = conditionsOf(entity).drift;
  // 目标鱼：向导写进 attrs 的鱼 id 优先（给 Jev 的是中文名），老场景退回 config 里的文字。
  const targetFish = fishById(str(entity.attrs.targetFish, ''))?.label ?? str(config.targetFish, '');
  return toFishingState(result.state, {
    intent: deriveIntent(observation, drift, num(entity.attrs.casts, 0)),
    drift,
    observation,
    ...(targetFish === '' ? {} : { targetFish }),
  });
}

export interface FishingView {
  readonly state: FishingState;
  /** 钓组阶段：测量阶段线组吊在半水，layout 已按它摆好。 */
  readonly phase: RigPhase;
  readonly layout: FishingLayout;
  readonly depth: number;
  readonly surfaceY: number;
  readonly hookGap: number;
  readonly castInterval: number;
  /** 走水：主线被拉斜、漂走位。 */
  readonly drift: boolean;
  /** 当前漂相（有口那一瞬是顿口 / 送漂 / 黑漂，否则 none）。 */
  readonly signal: FloatSignal;
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
  // 与 FishSim 同一份布局：测量阶段吊在半水，其余按钓目摆放。
  const phase = rigPhaseOf(entity.attrs);
  const layout = isMeasurePhase(phase)
    ? measureLayout(measureMarks(phase, entity.attrs ?? {}), rigPartsOf(phase), { surfaceY, depth, hookGap })
    : fishingLayout({ t0: state.rig.t0, t: state.rig.t, w: state.rig.w, d: state.rig.d }, state.rig, { surfaceY, depth, hookGap });
  const signalRaw = str(entity.attrs?.signal, 'none');
  const signal: FloatSignal = signalRaw === 'nod' || signalRaw === 'lift' || signalRaw === 'sink' || signalRaw === 'run' ? signalRaw : 'none';
  return { state, phase, layout, depth, surfaceY, hookGap, castInterval: Math.max(0.5, num(config.castInterval, 3)), drift: state.drift, signal };
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

  private apply(action: FishingActionId, params: Readonly<Record<string, number | string>>): void {
    applyFishingDecision(this.world, { action, params }, this.world.time);
  }

  private counters(): Counters {
    const attrs = this.world.getEntity(RIG_ID)?.attrs ?? {};
    return { casts: num(attrs.casts, 0), bites: num(attrs.bites, 0), catches: num(attrs.catches, 0) };
  }
}

/** 能写 attrs 的世界（TwinWorld 与 Studio 会话的世界都满足）。 */
export interface WorldWriter extends WorldReader {
  setAttr(entityId: string, key: string, value: unknown): void;
}

const LEAD_MARKS: Readonly<Record<string, number>> = { light: 0.5, medium: 1, heavy: 1.5 };
const NEST_SECONDS: Readonly<Record<string, number>> = { light: 45, normal: 90, heavy: 150 };

/**
 * 把一个决策落到世界上（仿真评测与 Studio "一键执行"共用这一份）。
 *
 * 每个动作都换算成 rig attrs 的变化，于是鱼口模型、剖面与 3D 场景自然跟着变：
 * - ADJUST_FLOAT / CHANGE_LAYER：改钓目 d（上推 = 钝，下推 = 灵）；
 * - ADD_LEAD：加铅 → 漂吃铅更多，t0 / t 同降（钓组整体更钝），并标记已抗流；
 * - CHANGE_BAIT：换成目标鱼更爱吃的饵；
 * - REFILL_NEST：窝料生效一段时间；
 * - REBUILD_RIG：钩 / 线 / 漂换回目标鱼的推荐规格；
 * - CHANGE_SPOT：换个钓位，甩掉闹窝的小鱼与走水；
 * - OBSERVE / NO_CHANGE：不动。
 *
 * 返回一句人话，说明世界里具体改了什么（UI 直接展示）。
 */
export function applyFishingDecision(
  world: WorldWriter,
  decision: { readonly action: FishingActionId; readonly params: Readonly<Record<string, number | string>> },
  now: number,
  rigId = RIG_ID,
): string {
  const entity = world.getEntity(rigId);
  if (!entity) return '没有钓组实体，动作没有落地。';
  const attrs = entity.attrs;
  const params = decision.params;
  const loadout = loadoutFromAttrs(attrs);
  const d = num(attrs.d, 2);

  switch (decision.action) {
    case 'ADJUST_FLOAT': {
      const steps = num(params['steps'], 1);
      // 往钝 = 上推浮漂 = 钓目增大；往灵 = 下推 = 钓目减小。
      const blunt = str(params['direction'], 'blunt') === 'blunt';
      const next = Math.max(0, d + (blunt ? steps : -steps));
      world.setAttr(rigId, 'd', next);
      return (blunt ? '浮漂上推 ' : '浮漂下推 ') + steps + ' 目：钓目 ' + d + ' → ' + next;
    }
    case 'CHANGE_LAYER': {
      const band = num(params['band'], 1);
      const down = str(params['direction'], 'down') === 'down';
      const next = Math.max(0, d + (down ? band : -band));
      world.setAttr(rigId, 'd', next);
      return (down ? '钓层下移（更贴底）' : '钓层上移（离底）') + '：钓目 ' + d + ' → ' + next;
    }
    case 'ADD_LEAD': {
      const marks = LEAD_MARKS[str(params['amount'], 'medium')] ?? 1;
      const t0 = num(attrs.t0, 4);
      const t = num(attrs.t, 2);
      // 调目不能被加到 0 以下太多：t0 至少留半目，t 同步降（双钩压目 H 不变）。
      const drop = Math.min(marks, Math.max(0, t0 - 0.5));
      world.setAttr(rigId, 't0', t0 - drop);
      world.setAttr(rigId, 't', t - drop);
      world.setAttr(rigId, 'antiDrift', true);
      return '加铅 ' + drop + ' 目抗流：调目 ' + t + ' → ' + (t - drop) + '（钓组更钝、更稳）';
    }
    case 'CHANGE_BAIT': {
      const fish = fishById(loadout.targetFish) ?? TARGET_FISH[0]!;
      const ranked = (Object.entries(fish.baitAffinity) as [BaitId, number][]).sort((a, b) => b[1] - a[1]);
      const next = ranked.find(([bait]) => bait !== loadout.bait)?.[0] ?? loadout.bait;
      const best = ranked[0]![0] === loadout.bait ? next : ranked[0]![0];
      world.setAttr(rigId, 'bait', best);
      return '换饵：' + loadout.bait + ' → ' + best;
    }
    case 'REFILL_NEST': {
      const seconds = NEST_SECONDS[str(params['amount'], 'normal')] ?? 90;
      world.setAttr(rigId, 'nestUntil', now + seconds);
      return '补窝：窝料 ' + seconds + ' 秒内诱鱼';
    }
    case 'REBUILD_RIG': {
      const target = str(params['target'], 'hook');
      const recommended = recommendedLoadout(loadout.targetFish);
      if (target === 'line') {
        world.setAttr(rigId, 'mainLine', recommended.mainLine);
        world.setAttr(rigId, 'subLine', recommended.subLine);
        return '换线：主线 ' + recommended.mainLine + ' 号 / 子线 ' + recommended.subLine + ' 号';
      }
      if (target === 'float') {
        world.setAttr(rigId, 'floatSize', recommended.floatSize);
        return '换漂：' + recommended.floatSize + 'g';
      }
      world.setAttr(rigId, 'hookSize', recommended.hookSize);
      return '换钩：' + loadout.hookSize + ' 号 → ' + recommended.hookSize + ' 号';
    }
    case 'CHANGE_SPOT': {
      world.setAttr(rigId, 'smallFish', false);
      world.setAttr(rigId, 'drift', false);
      world.setAttr(rigId, 'nestUntil', 0);
      return '换钓位：甩掉小鱼与走水，但窝要重新打';
    }
    case 'OBSERVE':
      return '继续观察 ' + num(params['casts'], 3) + ' 竿';
    case 'NO_CHANGE':
      return '保持现状';
  }
}

/** 一个决策会改动的一项 attrs（执行前预览、执行后回显共用）。 */
export interface DecisionChange {
  readonly key: string;
  readonly label: string;
  readonly before: unknown;
  readonly after: unknown;
}

const CHANGE_LABEL: Readonly<Record<string, string>> = {
  d: '钓目',
  t0: '无钩调目',
  t: '带钩调目',
  bait: '饵',
  hookSize: '钩号',
  mainLine: '主线',
  subLine: '子线',
  floatSize: '浮漂',
  antiDrift: '抗流铅',
  nestUntil: '窝料',
  smallFish: '小鱼闹窝',
  drift: '走水',
};

/**
 * 预览一个决策：在只读世界上"假执行"一遍 applyFishingDecision，收集会改的 attrs，
 * 真实世界一个字都不写。UI 用它把"建议"变成写明后果的按钮（钓目 2 → 3）。
 */
export function previewFishingDecision(
  world: WorldReader,
  decision: { readonly action: FishingActionId; readonly params: Readonly<Record<string, number | string>> },
  now: number,
  rigId = RIG_ID,
): { readonly note: string; readonly changes: readonly DecisionChange[] } {
  const before = world.getEntity(rigId)?.attrs ?? {};
  const written = new Map<string, unknown>();
  const scratch: WorldWriter = {
    getEntity: (id) => world.getEntity(id),
    setAttr: (entityId, key, value) => {
      if (entityId === rigId) written.set(key, value);
    },
  };
  const note = applyFishingDecision(scratch, decision, now, rigId);
  const changes: DecisionChange[] = [];
  for (const [key, after] of written) {
    if (before[key] === after) continue;
    changes.push({ key, label: CHANGE_LABEL[key] ?? key, before: before[key], after });
  }
  return { note, changes };
}
