import { describe, expect, test } from 'bun:test';
import { diffScenes, sameScene, sameValue } from './diff';
import type { TwinScene } from './index';

const scene = (overrides: Partial<TwinScene> = {}): TwinScene => ({
  version: 1,
  id: 'line-a',
  name: '产线 A',
  entities: [
    { id: 'belt-01', kind: 'transport', transform: { position: [0, 0, 0] }, capabilities: ['move'] },
    { id: 'rack-01', kind: 'storage', transform: { position: [4, 0, 0] }, capabilities: ['store'] },
  ],
  ...overrides,
});

describe('sameValue / sameScene', () => {
  test('忽略对象键顺序，但数组顺序不同即不等', () => {
    expect(sameValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
    expect(sameValue({ a: undefined }, {})).toBe(true);
  });

  test('同内容的场景相等，改一个位姿就不等', () => {
    const left = scene();
    const right = scene();
    expect(sameScene(left, right)).toBe(true);
    right.entities[0]!.transform.position = [0.1, 0, 0];
    expect(sameScene(left, right)).toBe(false);
  });
});

describe('diffScenes', () => {
  test('按实体 id 对齐：增、删、改分别列出，数组重排不算变化', () => {
    const before = scene();
    const after = scene({
      entities: [
        { id: 'rack-01', kind: 'storage', transform: { position: [4, 0, 0] }, capabilities: ['store'] },
        { id: 'belt-01', kind: 'transport', transform: { position: [2, 0, 0] }, capabilities: ['move'] },
        { id: 'agv-01', kind: 'vehicle', transform: { position: [0, 0, 5] }, capabilities: ['move'] },
      ],
    });

    const diff = diffScenes(before, after);
    expect(diff.added).toEqual(['agv-01']);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([{ id: 'belt-01', fields: ['transform'] }]);
    expect(diff.sceneFields).toEqual([]);
  });

  test('字段级差异按字母序，场景级字段不含 entities', () => {
    const before = scene();
    const after = scene({ name: '产线 A（改）' });
    after.entities[1] = {
      ...after.entities[1]!,
      transform: { position: [4, 0, 1] },
      capabilities: ['store', 'inspect'],
      attrs: { batch: 'B-2' },
    };

    const diff = diffScenes(before, after);
    expect(diff.changed).toEqual([{ id: 'rack-01', fields: ['attrs', 'capabilities', 'transform'] }]);
    expect(diff.sceneFields).toEqual(['name']);
  });

  test('同一份文档没有差异', () => {
    const diff = diffScenes(scene(), scene());
    expect(diff).toEqual({ added: [], removed: [], changed: [], sceneFields: [] });
  });
});
