import { runAudit, type SceneAuditCheck } from '@twin-platform/scene-audit';
import type { TwinScene } from '@twin-platform/scene-schema';
import {
  canonicalize,
  SCENE_TRACE_VERSION,
  stableHash,
  type AuditReport,
  type JsonObject,
  type SceneActionRecord,
  type ScenePluginLock,
  type SceneTrace,
} from '@twin-platform/scene-spec';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import { diffTrace } from './diff';
import type { TraceDiff } from '@twin-platform/scene-spec';

export interface TwinSceneAction extends SceneActionRecord {
  /** 动作只通过内核公开接口改世界；params 会原样进入 trace，供回放与审计配对。 */
  apply(world: TwinWorld): void;
}

export interface RunTwinSceneInput {
  readonly scene: TwinScene;
  readonly seed?: number;
  readonly step?: number;
  /** steps 与 durationSeconds 二选一；duration 必须能落在整数固定步上（1e-9 容差）。 */
  readonly steps?: number;
  readonly durationSeconds?: number;
  readonly behaviors?: readonly WorldBehavior[];
  readonly actions?: readonly TwinSceneAction[];
  readonly plugins?: readonly ScenePluginLock[];
  readonly checks?: readonly SceneAuditCheck<TwinWorld>[];
  readonly metrics?: (world: TwinWorld) => Readonly<Record<string, number>>;
  readonly warnings?: readonly string[];
  /** 内存事件容量；容量不足会抛错，绝不输出缺头部的“完整” trace。 */
  readonly eventLogSize?: number;
}

export interface TwinSceneRun {
  readonly trace: SceneTrace;
  readonly report: AuditReport;
  readonly world: TwinWorld;
}

function resolveSteps(input: RunTwinSceneInput, step: number): number {
  if ((input.steps === undefined) === (input.durationSeconds === undefined)) {
    throw new Error('steps 与 durationSeconds 必须且只能提供一个。');
  }
  const raw = input.steps ?? input.durationSeconds! / step;
  if (!Number.isFinite(raw) || raw < 0 || Math.abs(raw - Math.round(raw)) > 1e-9) {
    throw new Error('运行步数必须是非负整数；durationSeconds 必须对应整数个固定步。');
  }
  return Math.round(raw);
}

/** 参考 runtime 的 headless runner：固定步长、固定动作次序、完整事件与最终快照。 */
export function runTwinScene(input: RunTwinSceneInput): TwinSceneRun {
  const step = input.step ?? 1 / 60;
  if (!Number.isFinite(step) || step <= 0) throw new Error('step 必须是正有限数字。');
  const steps = resolveSteps(input, step);
  const seed = input.seed ?? 1;
  const actions = (input.actions ?? []).map((action, order) => ({ action, order })).sort((a, b) =>
    a.action.atStep - b.action.atStep || a.order - b.order,
  );
  for (const { action } of actions) {
    if (!Number.isInteger(action.atStep) || action.atStep < 0 || action.atStep > steps) {
      throw new Error(`动作 ${action.id} 的 atStep 必须在 0..${steps} 内。`);
    }
  }
  const world = new TwinWorld(input.scene, {
    seed,
    step,
    behaviors: input.behaviors,
    eventLogSize: input.eventLogSize ?? 100_000,
    maxStepsPerAdvance: Math.max(8, steps),
  });
  let actionIndex = 0;
  for (let atStep = 0; atStep <= steps; atStep += 1) {
    while (actionIndex < actions.length && actions[actionIndex]!.action.atStep === atStep) {
      actions[actionIndex]!.action.apply(world);
      actionIndex += 1;
    }
    if (atStep < steps) world.step(step);
  }
  const events = world.getEventLog();
  const expectedEvents = world.snapshot().sequence - 1;
  if (events.length !== expectedEvents) {
    throw new Error(`事件日志容量不足：应保留 ${expectedEvents} 条，实际 ${events.length} 条；请提高 eventLogSize。`);
  }
  const finalState = canonicalize(world.snapshot());
  const actionRecords: SceneActionRecord[] = actions.map(({ action }) => ({
    atStep: action.atStep,
    id: action.id,
    ...(action.params === undefined ? {} : { params: canonicalize(action.params) as JsonObject }),
  }));
  const trace: SceneTrace = {
    formatVersion: SCENE_TRACE_VERSION,
    sceneId: input.scene.id,
    sceneHash: stableHash(input.scene),
    seed,
    step,
    steps,
    plugins: (input.plugins ?? []).map((plugin) => ({ ...plugin })),
    actions: actionRecords,
    events: events.map((event) => ({ ...event, payload: event.payload ? { ...event.payload } : undefined })),
    finalState,
    eventHash: stableHash(events),
    stateHash: stableHash(finalState),
  };
  const report = runAudit({
    sceneId: input.scene.id,
    subject: world,
    checks: input.checks ?? [],
    metrics: input.metrics?.(world),
    warnings: input.warnings,
  });
  return { trace, report, world };
}

/** 回放不是插值或沿用旧世界：从同一场景与输入重新推进，再与基线逐字段比较。 */
export function replayTwinScene(input: RunTwinSceneInput, baseline: SceneTrace): { run: TwinSceneRun; diff: TraceDiff } {
  const run = runTwinScene(input);
  return { run, diff: diffTrace(baseline, run.trace) };
}
