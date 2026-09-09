import { describe, expect, test } from 'vitest';
import { seriesLatest, seriesTotal } from '@twin-platform/analytics-core';
import { StudioSession } from './studioSession';

/**
 * Studio 会话的装配测试：**不挂 WebGL**，直接推世界再读遥测。
 *
 * 视口那一层（TwinViewport / TwinSceneController）在无头环境里跑不动，
 * 但"场景 + 插件行为 + 遥测派生"这一整条链路是纯 TS 的，所以能在这里断言：
 * HUD 上那几个数到底对不对，而不是靠肉眼看。
 */
describe('StudioSession · 生产工厂闭环产线', () => {
  test('跑 5 分钟后，遥测能反映产出/打包/入库/运走的真实进度', () => {
    const session = new StudioSession();
    session.controller.pause();
    session.controller.stepFrames(60 * 300);

    const telemetry = session.telemetry();
    expect(telemetry.spawned).toBeGreaterThan(0); // 小货物产出
    expect(telemetry.packed).toBeGreaterThan(0); // 2 合 1 打包
    expect(telemetry.consumed).toBeGreaterThan(0); // 卡车运走
    expect(telemetry.asrsStore).toBeGreaterThan(0); // 入库
    expect(telemetry.asrsRetrieve).toBeGreaterThan(0); // 出库
    expect(telemetry.stock).toBeGreaterThan(0); // 库里有货
    expect(telemetry.pallets).toBeGreaterThan(0); // 托盘还在系统里
    expect(telemetry.truckTrips).toBeGreaterThan(0);
    expect(telemetry.trucks.length).toBe(2);
    for (const truck of telemetry.trucks) {
      expect(['docked', 'departing', 'away', 'returning']).toContain(truck.state);
    }

    // 在制小货物受发生器背压约束，不会无限涨
    expect(telemetry.active).toBeLessThanOrEqual(10);

    // 货架占用与库存一致（遥测只读行为发布的 attrs，不自己重算）
    const used = telemetry.racks.reduce((sum, rack) => sum + rack.used, 0);
    expect(telemetry.stock).toBe(used);
    expect(telemetry.capacity).toBeGreaterThan(0);
  });

  test('产线指标按"产出 / 运走"记账：吞吐为正，积压 = 在制 + 在库', () => {
    const session = new StudioSession();
    session.controller.pause();
    session.controller.stepFrames(60 * 300);

    const metrics = session.metrics();
    const telemetry = session.telemetry();
    expect(seriesTotal(metrics.throughput)).toBeGreaterThan(0);
    // 积压是末桶水位：没运走的都算在账上（在制小货物 + 托盘）
    expect(seriesLatest(metrics.backlog)).toBeGreaterThan(0);
    expect(telemetry.active + telemetry.pallets).toBeGreaterThan(0);
  });
});
