import { describe, expect, test } from 'bun:test';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import { lineMetrics, seriesLatest, seriesTotal } from '@twin-platform/analytics-core';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { buildLineScene, logisticsPlugin } from './index';

const STEP = 1 / 60;

/** 跑一段仿真，返回世界与收集到的事件。 */
function simulate(behaviors: readonly WorldBehavior[], steps: number, seed = 7) {
  const scene = buildLineScene({ parcels: 5, length: 20 }) as never;
  const world = new TwinWorld(scene, { seed, step: STEP, behaviors, maxStepsPerAdvance: 8 });
  for (let i = 0; i < steps; i += 1) world.step(STEP);
  return world;
}

describe('logistics 插件', () => {
  test('经 PluginHost 安装后贡献行为/指标/模板，且不改内核', () => {
    const host = new PluginHost();
    const record = host.install(logisticsPlugin);
    expect(record.state).toBe('active');
    expect(host.behaviors).toHaveLength(2);
    expect(host.behaviors[0]?.id).toBe('logistics-flow');
    expect(host.metrics.map((metric) => metric.id)).toEqual(['throughput', 'busy-duration']);
    expect(host.templates.map((template) => template.id)).toEqual([
      'logistics-line',
      'logistics-factory',
      'logistics-center',
    ]);
  });

  test('行为驱动包裹流转：开局进入 + 绕圈出/进', () => {
    const world = simulate([logisticsPlugin.activate().behaviors?.[0] as WorldBehavior], 1200);
    const events = world.getEventLog();
    const enters = events.filter((event) => event.type === 'parcel:enter');
    const exits = events.filter((event) => event.type === 'parcel:exit');

    // 5 个包裹开局各进 1 次；每完成一圈再出+进，所以进入永远比离开多 5。
    expect(enters.length).toBe(exits.length + 5);
    expect(exits.length).toBeGreaterThan(0);
  });

  test('产线指标：吞吐为正、积压稳定为在线包裹数、检测站有忙时', () => {
    const world = simulate([logisticsPlugin.activate().behaviors?.[0] as WorldBehavior], 1200);
    const events = world.getEventLog();
    const metrics = lineMetrics(events, {
      bucketSize: 5,
      enterTypes: ['parcel:enter'],
      exitTypes: ['parcel:exit'],
      busyStatuses: ['busy'],
      downStatuses: ['down'],
      until: world.time,
    });

    expect(seriesTotal(metrics.throughput)).toBeGreaterThan(0);
    // 闭环产线：包裹只出不进（每圈出+进抵消），积压恒为在线包裹数 5。
    expect(seriesLatest(metrics.backlog)).toBe(5);
    const scan = metrics.utilization.find((row) => row.entityId === 'scan-01');
    expect(scan).toBeDefined();
    expect(scan?.utilization ?? 0).toBeGreaterThan(0);
  });

  test('确定性：同种子两次仿真事件流逐条一致', () => {
    const a = simulate([logisticsPlugin.activate().behaviors?.[0] as WorldBehavior], 1200, 7);
    const b = simulate([logisticsPlugin.activate().behaviors?.[0] as WorldBehavior], 1200, 7);
    const signature = (events: { type: string; entityId?: string; occurredAt: number }[]) =>
      events.map((event) => `${event.type}|${event.entityId ?? ''}|${event.occurredAt}`).join(';');
    expect(signature(a.getEventLog())).toBe(signature(b.getEventLog()));
    expect(a.time).toBe(b.time);
  });
});
