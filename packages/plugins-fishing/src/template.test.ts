import { describe, expect, test } from 'bun:test';
import { buildFishingScene, fishingTemplate } from './template';
import { calculateRigState } from './fishingCore';
import { fishingLayout } from './fishSim';

describe('fishing-pond 场景模板', () => {
  test('水面 + 逻辑钓组 + 六个布局实体 + 装饰实体，id 唯一', () => {
    const scene = buildFishingScene({});
    expect(scene.id).toBe('fishing-pond');
    // 8 个功能实体（含 8 字环）+ 水底/岸坡/钓台/鱼竿/竿梢/2 芦苇/2 水草/3 鱼影
    expect(scene.entities).toHaveLength(21);
    const ids = scene.entities.map((entity) => entity.id);
    expect(new Set(ids).size).toBe(ids.length);

    const rig = scene.entities.find((entity) => entity.id === 'rig-01');
    expect(rig?.capabilities).toContain('rig');
    expect(rig?.attrs?.t0).toBe(4);
    expect(rig?.attrs?.casts).toBe(0);

    const slots = scene.entities
      .filter((entity) => typeof (entity.config as { slot?: unknown } | undefined)?.slot === 'string')
      .map((entity) => (entity.config as { slot?: string } | undefined)?.slot);
    expect(slots).toEqual(['float', 'sinker', 'swivel', 'upperHook', 'lowerHook', 'upperBait', 'lowerBait']);
  });

  test('布局实体初始位置就是 fishingLayout 的输出——首帧即与 FishSim 写入一致', () => {
    const scene = buildFishingScene({ depth: 2 });
    const rig = scene.entities.find((entity) => entity.id === 'rig-01')!;
    const attrs = rig.attrs as { t0: number; t: number; w: number; d: number };
    const input = { t0: attrs.t0, t: attrs.t, w: attrs.w, d: attrs.d };
    const result = calculateRigState(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 模板内部约定：水面在 y=depth（水底贴地）
    const expected = fishingLayout(input, result.state, { surfaceY: 2, depth: 2, hookGap: 0.2 });

    for (const id of ['float-01', 'sinker-01', 'swivel-01', 'hook-upper-01', 'hook-lower-01', 'bait-upper-01', 'bait-lower-01']) {
      const entity = scene.entities.find((item) => item.id === id)!;
      const slot = (entity.config as { slot: keyof typeof expected }).slot;
      expect(entity.transform.position[1]).toBeCloseTo(expected[slot][1], 9);
    }
  });

  test('装饰实体不带 rigId / slot，不会进布局核对', () => {
    const scene = buildFishingScene({});
    for (const id of ['rod-01', 'bottom-01', 'shore-01', 'platform-01', 'reed-01', 'weed-01', 'fish-01']) {
      const entity = scene.entities.find((item) => item.id === id)!;
      expect(entity.config).not.toHaveProperty('rigId');
      expect(entity.config).not.toHaveProperty('slot');
    }
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
