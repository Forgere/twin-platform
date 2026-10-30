import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { CargoPool } from './CargoPool';

describe('CargoPool instanceMesh 清理与槽位回收', () => {
  test('free 会把槽位缩放置零并标记 instanceMatrix needsUpdate', () => {
    const pool = new CargoPool(10);
    pool.alloc('item-1', [1, 2, 3], [0.5, 0.5, 0.5], new THREE.Color('#ff0000'));
    expect(pool.has('item-1')).toBe(true);

    pool.free('item-1');
    expect(pool.has('item-1')).toBe(false);

    // 槽位已归还，再次获取该 id 的矩阵应为 undefined
    expect(pool.matrixOf('item-1')).toBeUndefined();
    // 反查 entityIdAt 应为 undefined
    expect(pool.entityIdAt(9)).toBeUndefined();
  });

  test('entityIds 返回当前池内真实分配的所有货物', () => {
    const pool = new CargoPool(10);
    pool.alloc('a', [0, 0, 0], [1, 1, 1], new THREE.Color('#fff'));
    pool.alloc('b', [0, 0, 0], [1, 1, 1], new THREE.Color('#fff'));
    expect(pool.entityIds().sort()).toEqual(['a', 'b']);

    pool.free('a');
    expect(pool.entityIds()).toEqual(['b']);
  });
});
