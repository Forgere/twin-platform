import { describe, expect, test } from 'vitest';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { buildCenterScene, buildLineScene, logisticsPlugin, runtimeInvariantsFor } from '@twin-platform/plugins-logistics';
import { auditScene, auditSpots } from './sceneAudit';

/**
 * 审计取数层的验收标准：**结论来自 scene-audit，定位来自事件日志。**
 *
 * 这两件事必须分开测——判定错了会骗人，定位错了会让人点到不存在的东西。
 */

const STEP = 1 / 60;

function centerWorld(seconds: number, eventLogSize?: number): TwinWorld {
  const scene = buildCenterScene({ maxWip: 10, produceInterval: 2, highWater: 6, externalLanes: 4, aisles: 2 });
  // 经 PluginHost 激活：manifest 校验与能力过滤跟真跑时是同一套。
  const host = new PluginHost();
  host.install(logisticsPlugin);
  const behaviors = host.behaviors as readonly WorldBehavior[];
  const world = new TwinWorld(scene as never, { seed: 20240906, step: STEP, behaviors, maxStepsPerAdvance: 8, eventLogSize });
  const steps = Math.round(seconds / STEP);
  for (let index = 0; index < steps; index += 1) world.step(STEP);
  return world;
}

describe('场景审计取数', () => {
  test('刚起步的闭环中心：链路还没跑通必须报失败，不能默认放行', () => {
    const world = centerWorld(1);
    const view = auditScene(world, runtimeInvariantsFor(world.scene));

    expect(view.passed).toBe(false);
    const flow = view.checks.find((check) => check.id === 'logistics.center.flow');
    expect(flow?.status).toBe('fail');
    // 缺环节的违例定位不出来——缺失本身不是位置，必须如实留空。
    expect(flow?.findings.every((finding) => finding.target === undefined)).toBe(true);
    expect(flow?.findings.length).toBeGreaterThan(0);
    // 违例要能直接读出缺的是哪一环，而不是五条一模一样的句子。
    expect(flow?.findings.map((finding) => finding.where)).toContain('goods:packed');
    expect(flow?.findings[0]?.message).toContain('打包');
  });

  test('跑通之后通过，并且通过项也把账列出来（不留黑箱）', () => {
    const world = centerWorld(240);
    const view = auditScene(world, runtimeInvariantsFor(world.scene));

    expect(view.passed).toBe(true);
    const conservation = view.checks.find((check) => check.id === 'logistics.center.conservation');
    expect(conservation?.status).toBe('pass');
    expect(conservation?.notes.join(' ')).toContain('goods:');
    expect(view.evidence.to).toBeGreaterThan(0);
    expect(view.evidence.events).toBeGreaterThan(0);
  });

  test('报告的指标可交付：时刻 / 实体数 / 事件数都是有限数', () => {
    const world = centerWorld(30);
    const view = auditScene(world, runtimeInvariantsFor(world.scene));

    expect(Object.keys(view.report.metrics).sort()).toEqual(['entities', 'events', 'time']);
    for (const value of Object.values(view.report.metrics)) expect(Number.isFinite(value)).toBe(true);
    // 通过时也有“看现场”：最后一条事件的时刻必须落在窗口内。
    expect(view.latest?.at).toBeLessThanOrEqual(view.evidence.to);
    expect(view.latest?.evidence).toContain('t=');
  });

  test('闭环不变量只装给闭环场景：line 模板不硬套', () => {
    const line = buildLineScene({});
    expect(runtimeInvariantsFor(line)).toHaveLength(0);

    const world = centerWorld(0.5);
    expect(runtimeInvariantsFor(world.scene).length).toBeGreaterThan(0);
  });

  test('违例 where 是实体 id 时能定位到实体与那一刻', () => {
    const world = centerWorld(240);
    const event = world
      .getEventLog()
      .find((item) => item.entityId !== undefined && (item.type === 'goods:packed' || item.type === 'asrs:store'));
    expect(event?.entityId).toBeDefined();
    // 故意造一条指到真实实体的违例，验证 where → target 的翻译。
    const view = auditScene(world, [
      {
        id: 'test.entity-pointer',
        description: '指到具体实体',
        check: () => ({ violations: [{ where: event!.entityId!, message: '人为违例' }] }),
      },
    ]);
    const target = view.checks[0]?.findings[0]?.target;
    expect(target?.entityId).toBe(event!.entityId);
    expect(target?.at).toBeGreaterThanOrEqual(0);
    expect(target?.evidence).toContain(event!.entityId!);
  });

  test('日志容量溢出（或回放回跳）后，报告要自己承认窗口不足，而不是直接判死', () => {
    // 容量只有 4 条：跑到 60s 时事件头早就被丢了——和回跳截断是同一个后果。
    const world = centerWorld(60, 4);
    const view = auditScene(world, runtimeInvariantsFor(world.scene));

    expect(view.evidence.from).toBeGreaterThan(0);
    expect(view.windowComplete).toBe(false);
    expect(view.warnings.join(' ')).toContain('不覆盖全程');
    // 警告必须进报告，否则导出给 CLI 的那份会丢掉这个前提。
    expect(view.report.warnings.join(' ')).toContain('不覆盖全程');
  });

  test('定位不出来的违例不上三维：缺失的那一环不在画面上插旗', () => {
    const world = centerWorld(1);
    const view = auditScene(world, runtimeInvariantsFor(world.scene));
    expect(view.passed).toBe(false);
    expect(auditSpots(view)).toHaveLength(0);
  });

  test('一处违例浓缩成一个「点」：check、严重度、理由都跟着走', () => {
    const world = centerWorld(240);
    const view = auditScene(world, [
      {
        id: 'test.fail-pointer',
        description: '人为失败',
        check: () => ({ violations: [{ where: 'goods:packed', message: '账不平' }] }),
      },
      {
        id: 'test.error-check',
        description: '人为出错',
        check: () => {
          throw new Error('不变量自己炸了');
        },
      },
    ]);
    const spots = auditSpots(view);
    expect(spots).toHaveLength(1);
    expect(spots[0]?.checkId).toBe('test.fail-pointer');
    expect(spots[0]?.check).toBe('人为失败');
    expect(spots[0]?.severity).toBe('fail');
    expect(spots[0]?.message).toBe('账不平');
    expect(spots[0]?.at).toBeGreaterThan(0);
    expect(spots[0]?.evidence).toContain('goods:packed');
  });

  test('多条违例按时刻升序排，去重后一台设备不会被同样的旗淹掉', () => {
    const world = centerWorld(240);
    const view = auditScene(world, [
      {
        id: 'test.pair',
        description: '两处违例',
        check: () => ({
          violations: [
            { where: 'asrs:retrieve', message: '出库比入库早' },
            { where: 'goods:produced', message: '产出多了' },
            { where: 'goods:produced', message: '产出多了（重复指认）' },
          ],
        }),
      },
    ]);
    const spots = auditSpots(view);
    expect(spots).toHaveLength(2);
    // 排序的原料是「该类事件最后一次发生的时刻」，不是违例写下的顺序。
    expect(spots.map((spot) => spot.message)).toEqual(['出库比入库早', '产出多了']);
    const first = spots[0]?.at ?? 0;
    const second = spots[1]?.at ?? 0;
    expect(first).toBeLessThanOrEqual(second);
  });

  test('定位时刻一定落在已发生的窗口内，不会指向未来', () => {
    const world = centerWorld(120);
    const view = auditScene(world, runtimeInvariantsFor(world.scene));
    for (const check of view.checks) {
      for (const finding of check.findings) {
        const at = finding.target?.at;
        if (at === undefined) continue;
        expect(at).toBeLessThanOrEqual(world.time);
        expect(at).toBeGreaterThanOrEqual(view.evidence.from);
      }
    }
  });
});
