import {
  calculateRigState,
  conditionsOf,
  fishingModeOf,
  loadoutFromAttrs,
  manualCastOf,
  manualLiftOf,
  observeFishingWorld,
  rigPhaseOf,
  type BaitId,
  type FishingMode,
  type FishingState,
  type LiftResult,
  type Loadout,
  type PondConditions,
} from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';

/**
 * 钓场 UI 共用的读写口：浮层向导、钓况 HUD、钓鱼助手、钓组检视页都走这里，
 * 不各自去翻 rig 实体的 attrs。
 *
 * 读：全部由 plugins-fishing 的纯函数解释（loadoutFromAttrs / conditionsOf /
 * observeFishingWorld），UI 不自己判断"这是什么状态"。
 * 写：一律 `world.setAttr`——可回放的世界变更，和仿真、决策执行同一条路。
 */

export const RIG_ID = 'rig-01';

export interface RigSnapshot {
  readonly loadout: Loadout;
  readonly conditions: PondConditions;
  /** 参数非法时为 undefined（UI 显示原因，不崩）。 */
  readonly state?: FishingState;
  readonly error?: string;
  readonly counts: {
    readonly casts: number;
    readonly bites: number;
    readonly catches: number;
    readonly emptyHooks: number;
    readonly breaks: number;
    /** 手动提杆时错过的口（漂动完了没提）。 */
    readonly missed: number;
  };
  /** 当前这一竿的漂相（有口那一瞬）。 */
  readonly signal: string;
  readonly wizardDone: boolean;
  readonly mode: FishingMode;
  /** 模拟模式下有口要用户提杆才结算。 */
  readonly manualLift: boolean;
  readonly manualCast: boolean;
  readonly inWater: boolean;
  /** 向导配置中不能抛竿/换饵，避免和半水测量争写同一副钓组。 */
  readonly ready: boolean;
  /** 有口、正等着提杆。 */
  readonly pendingBite: boolean;
  /** 最近一次提杆（或错过）的结果。 */
  readonly lastLift?: LiftResult;
}

const LIFT_RESULTS: readonly LiftResult[] = ['caught', 'empty', 'broken', 'missed', 'blank'];

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function hasRig(session: StudioSessionPort): boolean {
  return session.world.getEntity(RIG_ID) !== undefined;
}

export function readRig(session: StudioSessionPort): RigSnapshot | undefined {
  const entity = session.world.getEntity(RIG_ID);
  if (!entity) return undefined;
  const attrs = entity.attrs ?? {};
  let state: FishingState | undefined;
  let error: string | undefined;
  try {
    state = observeFishingWorld(session.world);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return {
    loadout: loadoutFromAttrs(attrs),
    conditions: conditionsOf(entity),
    state,
    error,
    counts: {
      casts: count(attrs.casts),
      bites: count(attrs.bites),
      catches: count(attrs.catches),
      emptyHooks: count(attrs.emptyHooks),
      breaks: count(attrs.breaks),
      missed: count(attrs.missedBites),
    },
    signal: typeof attrs.signal === 'string' ? attrs.signal : 'none',
    wizardDone: attrs.wizardDone === true,
    mode: fishingModeOf(attrs),
    manualLift: manualLiftOf(attrs),
    manualCast: manualCastOf(attrs),
    inWater: attrs.inWater === true,
    ready: attrs.wizardDone === true && rigPhaseOf(attrs) === 'fishing' && state !== undefined,
    pendingBite: attrs.pendingBite === true,
    lastLift: LIFT_RESULTS.includes(attrs.lastLift as LiftResult) ? (attrs.lastLift as LiftResult) : undefined,
  };
}

/** 批量写 rig attrs；暂停中也立刻推一帧，让 3D 与剖面马上反映新状态。 */
export function writeRig(session: StudioSessionPort, values: Readonly<Record<string, number | string | boolean>>): void {
  for (const [key, value] of Object.entries(values)) session.world.setAttr(RIG_ID, key, value);
  refreshWhilePaused(session);
}

/**
 * 暂停时世界不推进，布局实体（漂 / 铅 / 钩）就停在旧位置——布局是 fish-sim
 * 在 step 里算的，推 0 帧只刷渲染不跑行为，所以这里推 1 帧（1/60 秒）。
 */
export function refreshWhilePaused(session: StudioSessionPort): void {
  if (!session.controller.playing) session.controller.stepFrames(1);
}

/**
 * 调钓参数步进（半目为单位）。先过 calculateRigState：不合法的组合不写进世界，
 * 返回人话原因；成功返回 undefined。HUD 的钓目与「钓组」页的调目共用这一处。
 */
export function stepRigParam(session: StudioSessionPort, key: 't0' | 't' | 'w' | 'd', delta: number): string | undefined {
  const snapshot = readRig(session);
  const issue = rigEditIssue(snapshot);
  if (issue) return issue;
  const current = snapshot?.state?.rig;
  if (!current) return '钓组参数还不完整。';
  const input = { t0: current.t0, t: current.t, w: current.w, d: current.d };
  const next = { ...input, [key]: Math.round((input[key] + delta) * 2) / 2 };
  const result = calculateRigState(next);
  if (!result.ok) return result.issues.map((item) => item.message).join(' ');
  writeRig(session, { [key]: next[key] });
  return undefined;
}

/** 换钓场模式：计数从 0 记起——模拟出来的鱼口不能混进真实钓点的记录，反之亦然。 */
export function setFishingMode(session: StudioSessionPort, mode: FishingMode): void {
  writeRig(session, {
    fishingMode: mode,
    manualCast: mode === 'sim',
    autoLift: false,
    cast: false,
    lift: false,
    inWater: false,
    castAt: -1,
    biteUntil: 0,
    biteFish: '',
    bitHook: 'none',
    nextAt: 0,
    casts: 0,
    bites: 0,
    catches: 0,
    emptyHooks: 0,
    breaks: 0,
    missedBites: 0,
    pendingBite: false,
    lastLift: '',
    signal: 'none',
  });
}

/** 手动抛竿：只有收竿状态接受新意图，连点也不会重置正在等的鱼口。 */
export function castRod(session: StudioSessionPort): void {
  const current = readRig(session);
  if (!current?.ready || current.mode !== 'sim' || current.inWater || current.pendingBite) return;
  writeRig(session, { manualCast: true, autoLift: false, cast: true, lift: false });
}

export function rigEditIssue(current: RigSnapshot | undefined): string | undefined {
  if (!current?.ready) return '请先完成钓组配置。';
  if (current.inWater || current.pendingBite) return '收竿后可更换装备与调整钓目。';
  return undefined;
}

/** 装备编辑共用入口，不用估算值覆盖实测调目。 */
export function switchGear(session: StudioSessionPort, patch: Partial<Loadout>): string | undefined {
  const issue = rigEditIssue(readRig(session));
  if (issue) return issue;
  writeRig(session, patch as Record<string, number | string>);
  return undefined;
}

/** 快捷换饵与装备编辑使用相同的收竿守卫。 */
export function switchBait(session: StudioSessionPort, bait: BaitId): void {
  switchGear(session, { bait });
}

/** 模拟模式下提杆：写一个意图，fish-sim 下一步消费并结算。 */
export function liftRod(session: StudioSessionPort): void {
  const current = readRig(session);
  if (!current?.ready || current.mode !== 'sim') return;
  if (current.manualCast && !current.inWater) return;
  writeRig(session, { lift: true });
}

/** 实际做钓的一竿结果（用户手动记）。 */
export type CastRecord = 'none' | 'caught' | 'empty' | 'broken';

export function recordCast(session: StudioSessionPort, outcome: CastRecord): void {
  const counts = readRig(session)?.counts;
  if (!counts) return;
  const bit = outcome !== 'none';
  writeRig(session, {
    casts: counts.casts + 1,
    bites: counts.bites + (bit ? 1 : 0),
    catches: counts.catches + (outcome === 'caught' ? 1 : 0),
    emptyHooks: counts.emptyHooks + (outcome === 'empty' ? 1 : 0),
    breaks: counts.breaks + (outcome === 'broken' ? 1 : 0),
  });
}
