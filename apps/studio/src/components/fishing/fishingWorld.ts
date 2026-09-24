import {
  calculateRigState,
  conditionsOf,
  loadoutFromAttrs,
  observeFishingWorld,
  type FishingState,
  type Loadout,
  type PondConditions,
} from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';

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
  };
  /** 当前这一竿的漂相（有口那一瞬）。 */
  readonly signal: string;
  readonly wizardDone: boolean;
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function hasRig(session: StudioSession): boolean {
  return session.world.getEntity(RIG_ID) !== undefined;
}

export function readRig(session: StudioSession): RigSnapshot | undefined {
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
    },
    signal: typeof attrs.signal === 'string' ? attrs.signal : 'none',
    wizardDone: attrs.wizardDone === true,
  };
}

/** 批量写 rig attrs；暂停中也立刻推一帧，让 3D 与剖面马上反映新状态。 */
export function writeRig(session: StudioSession, values: Readonly<Record<string, number | string | boolean>>): void {
  for (const [key, value] of Object.entries(values)) session.world.setAttr(RIG_ID, key, value);
  refreshWhilePaused(session);
}

/**
 * 暂停时世界不推进，布局实体（漂 / 铅 / 钩）就停在旧位置——布局是 fish-sim
 * 在 step 里算的，推 0 帧只刷渲染不跑行为，所以这里推 1 帧（1/60 秒）。
 */
export function refreshWhilePaused(session: StudioSession): void {
  if (!session.controller.playing) session.controller.stepFrames(1);
}

/**
 * 调钓参数步进（半目为单位）。先过 calculateRigState：不合法的组合不写进世界，
 * 返回人话原因；成功返回 undefined。HUD 的钓目与「钓组」页的调目共用这一处。
 */
export function stepRigParam(session: StudioSession, key: 't0' | 't' | 'w' | 'd', delta: number): string | undefined {
  const current = readRig(session)?.state?.rig;
  if (!current) return '钓组参数还不完整。';
  const input = { t0: current.t0, t: current.t, w: current.w, d: current.d };
  const next = { ...input, [key]: Math.round((input[key] + delta) * 2) / 2 };
  const result = calculateRigState(next);
  if (!result.ok) return result.issues.map((item) => item.message).join(' ');
  writeRig(session, { [key]: next[key] });
  return undefined;
}
