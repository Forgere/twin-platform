import { describe, expect, test } from 'vitest';
import type { TwinScene } from '@twin-platform/scene-schema';
import { TwinWorld } from '@twin-platform/world-kernel';
import { selectionCard } from './selectionCard';

/** 三个典型实体：静态可编辑、声明了 motion（不可编辑）、托盘（要翻译状态行）。 */
const scene: TwinScene = {
  version: 1,
  id: 'line-a',
  name: '产线 A',
  entities: [
    {
      id: 'rack-01',
      kind: 'asrs',
      capabilities: ['store', 'retrieve'],
      transform: { position: [4, 0, 6], rotation: [0, 0.5, 0], scale: [1, 1, 1] },
      config: { label: 'A排货架' },
      attrs: { used: 3, capacity: 8 },
    },
    {
      id: 'belt-01',
      kind: 'transport',
      capabilities: ['move'],
      transform: { position: [0, 0.8, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      config: { label: '主皮带' },
      motion: { points: [[0, 0.8, 0], [8, 0.8, 0]], speed: 1.2, loop: 'repeat' },
    },
    {
      id: 'pallet-01',
      kind: 'pallet',
      capabilities: ['carry'],
      transform: { position: [1, 1.2, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
      attrs: { state: 'stored', slot: '0:1:2', seq: 7 },
    },
  ],
};

const build = (): TwinWorld => new TwinWorld(scene);

describe('selectionCard', () => {
  test('没选中 / 实体不存在 → undefined', () => {
    const world = build();
    expect(selectionCard(world, undefined)).toBeUndefined();
    expect(selectionCard(world, 'nope')).toBeUndefined();
  });

  test('label 取声明 config.label，没有就退回 id；kind / capabilities 一并给出', () => {
    const world = build();
    const card = selectionCard(world, 'rack-01')!;
    expect(card.label).toBe('A排货架');
    expect(card.kind).toBe('asrs');
    expect(card.capabilities).toEqual(['store', 'retrieve']);
    // pallet-01 没写 label → 退回 id
    expect(selectionCard(world, 'pallet-01')!.label).toBe('pallet-01');
  });

  test('状态行是人话（attrs 原值也一并给出，给工具与 AI 判断）', () => {
    const card = selectionCard(build(), 'pallet-01')!;
    expect(card.stateLines.some((line) => line.includes('已上架'))).toBe(true);
    expect(card.stateLines.some((line) => line.includes('第 2 层'))).toBe(true);
    expect(card.attrs).toEqual({ state: 'stored', slot: '0:1:2', seq: 7 });
  });

  test('声明位姿与运行时位姿都给，且都是副本——改返回值不会写回世界', () => {
    const world = build();
    const card = selectionCard(world, 'rack-01')!;
    expect(card.declared?.position).toEqual([4, 0, 6]);
    expect(card.runtime.position).toEqual([4, 0, 6]);
    card.runtime.position[0] = 999;
    card.declared!.position[0] = 999;
    card.attrs.used = 999;
    expect(world.getEntity('rack-01')!.transform.position[0]).toBe(4);
    expect(world.scene.entities[0].transform.position[0]).toBe(4);
    expect(world.getEntity('rack-01')!.attrs.used).toBe(3);
  });

  test('静态设备可编辑；声明了 motion 的位姿由路径决定 → 不可编辑 + 内核原因', () => {
    const world = build();
    expect(selectionCard(world, 'rack-01')!.editability).toEqual({ editable: true });
    const moving = selectionCard(world, 'belt-01')!;
    expect(moving.hasMotion).toBe(true);
    expect(moving.editability.editable).toBe(false);
    expect(moving.editability.reason).toContain('motion');
    expect(selectionCard(world, 'rack-01')!.hasMotion).toBe(false);
  });

  test('运行时生成的实体：declared 为 undefined（场景声明里没有），原因直说改不了', () => {
    const world = build();
    world.addEntity({ id: 'gen-1', kind: 'cargo', capabilities: [], transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    const card = selectionCard(world, 'gen-1')!;
    expect(card.declared).toBeUndefined();
    expect(card.editability.editable).toBe(false);
    expect(card.editability.reason).toContain('运行时生成');
  });

  test('codePath 由渲染层透传，不传就没有', () => {
    const world = build();
    expect(selectionCard(world, 'rack-01', 'model/asrs.glb')!.codePath).toBe('model/asrs.glb');
    expect(selectionCard(world, 'rack-01')!.codePath).toBeUndefined();
  });
});
