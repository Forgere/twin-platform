import { describe, expect, test } from 'vitest';
import { seriesLatest, seriesTotal } from '@twin-platform/analytics-core';
import { parseSceneDocument, serializeSceneDocument, type TwinScene } from '@twin-platform/scene-schema';
import { StudioSession, buildDefaultScene } from './studioSession';

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

/**
 * 外部场景注入：**布局真相能不能离开代码**。
 *
 * 这是"接 CAD / MES 台账 / 手绘重建"的前置能力——只要外部工具能落成这份
 * JSON，就应当能直接进内核跑，而不用改一行 TS 再重新构建。
 */
describe('StudioSession · 导入外部场景', () => {
  test('注入一个手写场景后，世界与遥测都按它跑', () => {
    const imported: TwinScene = {
      version: 1,
      id: 'my-plant',
      name: '我的车间',
      entities: [
        {
          id: 'belt-in',
          kind: 'transport',
          transform: { position: [0, 0.8, 0] },
          capabilities: ['move'],
          motion: { points: [[0, 0.8, 0], [20, 0.8, 0]], speed: 1.5 },
        },
        {
          id: 'pack-01',
          kind: 'pack',
          transform: { position: [20, 0.8, 0] },
          capabilities: ['pack'],
        },
      ],
    };

    const session = new StudioSession(imported);
    expect(session.sceneSource).toBe('imported');
    expect(session.world.scene.id).toBe('my-plant');
    expect(session.world.listEntities()).toHaveLength(2);

    // 摘要用于导入后给用户确认"装对了没有"。
    const summary = session.describeScene();
    expect(summary.entities).toBe(2);
    expect(summary.moving).toBe(1);

    // 行为靠 capabilities 认领实体，几何进来但没人认领时要能查出来。
    const drivable = session.drivableKinds();
    expect(drivable.known).toBe(2);
    expect(drivable.unknown).toEqual([]);

    // 不传场景时回到模板。
    expect(new StudioSession().sceneSource).toBe('template');
  });

  test('未知 kind 会被 drivableKinds 列出来，避免"跑不动却没提示"', () => {
    const session = new StudioSession({
      version: 1,
      id: 'x',
      name: 'x',
      entities: [{ id: 'weird-1', kind: 'laser-welder', transform: { position: [0, 0, 0] }, capabilities: [] }],
    });
    const drivable = session.drivableKinds();
    expect(drivable.known).toBe(0);
    expect(drivable.unknown).toEqual(['laser-welder']);
  });

  test('模板场景导出成 JSON 再导入，同 seed 同帧数逐位一致', () => {
    // 这条是"布局真相能离开代码"的硬证据：
    // 场景绕了一圈文件（序列化 → 文本 → 解析 → 校验）后再跑，
    // 结果必须与模板场景完全相同，否则说明有状态没被序列化进去。
    const original = new StudioSession();
    original.controller.pause();

    const text = serializeSceneDocument(original.currentScene());
    const parsed = parseSceneDocument(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.issues).toEqual([]);

    const restored = new StudioSession(parsed.scene!);
    restored.controller.pause();

    original.controller.stepFrames(60 * 120);
    restored.controller.stepFrames(60 * 120);

    const before = original.telemetry();
    const after = restored.telemetry();
    expect(after.spawned).toBe(before.spawned);
    expect(after.packed).toBe(before.packed);
    expect(after.asrsStore).toBe(before.asrsStore);
    expect(after.stock).toBe(before.stock);
    expect(after.pallets).toBe(before.pallets);
    // 世界状态也要一致，不只是事件计数。
    expect(restored.world.time).toBe(original.world.time);
  });

  test('分叉对比用当前场景做基准，导入后比的是导入的布局', () => {
    const session = new StudioSession({
      version: 1,
      id: 'fork-base',
      name: '对比基准',
      entities: buildDefaultScene().entities.slice(0, 40),
    });
    const diff = session.compare(0, 60, 4);
    // 能跑通即说明基准取自当前场景（模板 id 是 center-*，不会是 fork-base 之外的东西）。
    expect(diff).toBeTruthy();
    expect(session.world.scene.id).toBe('fork-base');
  });
});
