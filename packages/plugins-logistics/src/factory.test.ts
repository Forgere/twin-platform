import { describe, expect, test } from 'bun:test';
import { TwinWorld, type WorldBehavior } from '@twin-platform/world-kernel';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { buildFactoryScene, factoryTemplate, logisticsPlugin } from './index';

const STEP = 1 / 60;

/** 跑一段工厂仿真，返回世界与收集到的事件。 */
function simulate(behaviors: readonly WorldBehavior[], steps: number, seed = 7) {
  const scene = buildFactoryScene({ parcels: 8, externalLanes: 4 }) as never;
  const world = new TwinWorld(scene, { seed, step: STEP, behaviors, maxStepsPerAdvance: 8 });
  for (let i = 0; i < steps; i += 1) world.step(STEP);
  return world;
}

describe('logistics 工厂模板', () => {
  test('经 PluginHost 安装后贡献工厂模板（logistics-factory）', () => {
    const host = new PluginHost();
    host.install(logisticsPlugin);
    expect(host.templates.map((template) => template.id)).toContain('logistics-factory');
    expect(factoryTemplate.id).toBe('logistics-factory');
  });

  test('组装出预期拓扑：入料×2 / 主段×3 / 出料×1 / 分拣×1 / 外部×4 / 质检×2 / 拒收×2 / 包装×1 / 物料', () => {
    const scene = buildFactoryScene({ parcels: 8, externalLanes: 4 });
    const byKind = (kind: string): number => scene.entities.filter((entity) => entity.kind === kind).length;

    // 输送类（transport）：入料2 + 主段3 + 出料1 + 分拣1 + 外部4 = 11
    expect(byKind('transport')).toBe(11);
    // 检测站（inspect）：scan-01 / scan-02
    expect(byKind('inspect')).toBe(2);
    // 缓存（buffer）：拒收2 + 包装1 = 3
    expect(byKind('buffer')).toBe(3);
    // 在制物料（parcel）：主环线8 + 外部4 = 12
    expect(byKind('parcel')).toBe(12);

    expect(scene.entities.find((entity) => entity.id === 'scan-01')).toBeDefined();
    expect(scene.entities.find((entity) => entity.id === 'reject-rack-1')).toBeDefined();
    expect(scene.entities.find((entity) => entity.id === 'pack-01')).toBeDefined();
    expect(scene.entities.find((entity) => entity.id === 'ext-4')).toBeDefined();
  });

  test('参数化：externalLanes 与 parcels 改变实体数量', () => {
    const small = buildFactoryScene({ parcels: 3, externalLanes: 2 });
    const big = buildFactoryScene({ parcels: 10, externalLanes: 6 });
    expect(small.entities.filter((e) => e.kind === 'parcel')).toHaveLength(5);
    expect(big.entities.filter((e) => e.kind === 'parcel')).toHaveLength(16);
    expect(big.entities.filter((e) => e.kind === 'transport')).toHaveLength(2 + 3 + 1 + 1 + 6);
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
