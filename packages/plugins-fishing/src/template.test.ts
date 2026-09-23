import { describe, expect, test } from 'bun:test';
import { buildFishingScene, fishingTemplate } from './template';

describe('fishing-pond 场景模板', () => {
  test('水面 + 逻辑钓组 + 六个布局实体，id 唯一', () => {
    const scene = buildFishingScene({});
    expect(scene.id).toBe('fishing-pond');
    expect(scene.entities).toHaveLength(8);
    const ids = scene.entities.map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);

    const rig = scene.entities.find((entity) => entity.id === 'rig-01');
    expect(rig?.capabilities).toContain('rig');
    expect(rig?.attrs?.t0).toBe(4);
    expect(rig?.attrs?.casts).toBe(0);

    const slots = scene.entities
      .filter((entity) => entity.kind !== 'water' && entity.kind !== 'rig')
      .map((entity) => (entity.config as { slot?: string } | undefined)?.slot);
    expect(slots).toEqual(['float', 'sinker', 'upperHook', 'lowerHook', 'upperBait', 'lowerBait']);
  });

  test('钓场坐在地面之上：水底在 y=0、水面在 y=depth', () => {
    const scene = buildFishingScene({ depth: 2 });
    const pond = scene.entities.find((entity) => entity.id === 'pond-01');
    const size = pond?.visual?.size ?? [0, 0, 0];
    const centerY = pond?.transform.position[1] ?? -1;
    expect(centerY - size[1] / 2).toBeCloseTo(0, 9);
    expect(centerY + size[1] / 2).toBeCloseTo(2, 9);
    const rig = scene.entities.find((entity) => entity.id === 'rig-01');
    expect((rig?.config as { surfaceY?: number } | undefined)?.surfaceY).toBe(2);
  });

  test('模板可参数化钓组与水温', () => {
    const entities = fishingTemplate.build({ rig: { t0: 6, t: 4, w: 1.2, d: 3 }, waterTemperature: 8 });
    const rig = entities.find((entity) => entity.id === 'rig-01');
    expect(rig?.attrs?.d).toBe(3);
    expect((rig?.config as { waterTemperature?: number } | undefined)?.waterTemperature).toBe(8);
  });
});
