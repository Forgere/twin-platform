import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import type { SceneAuditCheck } from '@twin-platform/scene-audit';
import { TwinWorld } from '@twin-platform/world-kernel';
import { diffTrace, firstJsonDivergence, replayTwinScene, runTwinScene, type RunTwinSceneInput } from './index';

const scene: TwinScene = {
  version: 1,
  id: 'runner-test',
  name: 'Runner test',
  entities: [{ id: 'box', kind: 'box', transform: { position: [0, 0, 0] }, capabilities: [], attrs: { count: 0 } }],
};

const input = (actions: RunTwinSceneInput['actions'] = []): RunTwinSceneInput => ({
  scene,
  seed: 7,
  step: 0.5,
  steps: 4,
  plugins: [{ id: 'test-plugin', version: '1.0.0' }],
  actions,
  checks: [{ id: 'count', description: '动作恰好落地两次', check: (world) => world.getEntity('box')?.attrs.count === 2 ? [] : [{ message: 'count 错误', where: 'box.attrs.count' }] }],
  metrics: (world) => ({ count: Number(world.getEntity('box')?.attrs.count) }),
});

const increment = (atStep: number) => ({
  atStep,
  id: 'increment',
  params: { amount: 1 },
  apply: (world: TwinWorld) => {
    const count = Number(world.getEntity('box')?.attrs.count ?? 0);
    world.setAttr('box', 'count', count + 1);
    world.dispatch('test:increment', { entityId: 'box', payload: { count: count + 1 } });
  },
});

describe('scene-runner', () => {
  test('run → trace → replay 同输入逐字节一致，动作顺序与指标可审计', () => {
    const first = runTwinScene(input([increment(0), increment(4)]));
    expect(first.trace.events.map((event) => event.occurredAt)).toEqual([0, 2]);
    expect(first.trace.actions.map((action) => action.atStep)).toEqual([0, 4]);
    expect(first.report.passed).toBe(true);
    expect(first.report.metrics).toEqual({ count: 2 });
    const replayed = replayTwinScene(input([increment(0), increment(4)]), first.trace);
    expect(replayed.diff.identical).toBe(true);
    expect(replayed.diff.baselineHash).toBe(replayed.diff.currentHash);
  });

  test('差分给出首个 JSON Pointer，并转义指针片段', () => {
    const baseline = runTwinScene(input([increment(0), increment(4)])).trace;
    const changed = runTwinScene(input([increment(0)]));
    const diff = diffTrace(baseline, changed.trace);
    expect(diff.identical).toBe(false);
    expect(diff.firstDivergence?.pointer).toBe('/actions/1');
    expect(diff.firstDivergence?.reason).toBe('missing');
    expect(firstJsonDivergence({ 'a/b': { '~x': 1 } }, { 'a/b': { '~x': 2 } })?.pointer).toBe('/a~1b/~0x');
  });

  test('差分优先指向真实事件，而不是被派生哈希遮住', () => {
    const baseline = runTwinScene(input([increment(0)])).trace;
    const changed = runTwinScene(input([increment(0)])).trace;
    const events = changed.events.map((event, index) => index === 0 ? { ...event, detail: 'changed' } : event);
    const semantic = { ...changed, events, eventHash: 'tampered-hash' };
    expect(diffTrace(baseline, semantic).firstDivergence?.pointer).toBe('/events/0/detail');
    expect(diffTrace(baseline, { ...changed, eventHash: 'tampered-hash' }).firstDivergence?.pointer).toBe('/eventHash');
  });

  test('不会用有界日志冒充完整 trace，输入窗口严格校验', () => {
    expect(() => runTwinScene({ ...input([increment(0), increment(1), increment(2)]), eventLogSize: 2 })).toThrow('事件日志容量不足');
    expect(() => runTwinScene({ scene, steps: 1, durationSeconds: 1 })).toThrow('只能提供一个');
    expect(() => runTwinScene({ scene, step: 0.3, durationSeconds: 1 })).toThrow('整数个固定步');
    expect(() => runTwinScene({ scene, steps: 1, actions: [increment(2)] })).toThrow('atStep');
  });

  test('领域无关 invariant 能直接消费运行后的世界', () => {
    const positive: SceneAuditCheck<TwinWorld> = {
      id: 'positive', description: 'count 非负',
      check: (world) => Number(world.getEntity('box')?.attrs.count) >= 0 ? [] : [{ message: '负数' }],
    };
    expect(runTwinScene({ scene, steps: 0, checks: [positive] }).report.checks[0]?.status).toBe('pass');
  });
});
