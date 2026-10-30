import * as THREE from 'three';

import { describe, expect, test } from 'vitest';
import { CargoPool } from './CargoPool';

/**
 * 实例化货池的审计标记。
 *
 * 这里只验一件事：**插旗能变色、摘旗能还原**，并且不认识的名字不会污染池里任何一个槽位。
 * 判定与定位都不在这里——它只是把别人给的名单画出来。
 */

const SIZE: [number, number, number] = [0.5, 0.5, 0.5];

function colorAt(pool: CargoPool, id: string): THREE.Color | undefined {
  const mesh = pool.mesh;
  const slot = (pool as unknown as { idToSlot: Map<string, number> }).idToSlot.get(id);
  if (slot === undefined || !mesh.instanceColor) return undefined;
  const color = new THREE.Color();
  mesh.getColorAt(slot, color);
  return color;
}

describe('货池的审计标记', () => {
  test('插旗覆盖身份色，摘旗回到身份色', () => {
    const pool = new CargoPool(8);
    const identity = new THREE.Color('#4C9A8A');
    pool.alloc('box-1', [0, 0.25, 0], SIZE, identity);
    const before = colorAt(pool, 'box-1')?.getHexString();
    expect(before).toBe(identity.getHexString());

    pool.setFlagged(['box-1']);
    expect(colorAt(pool, 'box-1')?.getHexString()).not.toBe(identity.getHexString());

    pool.setFlagged([]);
    expect(colorAt(pool, 'box-1')?.getHexString()).toBe(identity.getHexString());
  });

  test('脉冲只改颜色，且在两色之间插值：不会被当成静止的恒亮', () => {
    const pool = new CargoPool(8);
    pool.alloc('box-2', [1, 0.25, 1], SIZE, new THREE.Color('#4C9A8A'));
    pool.setFlagged(['box-2']);
    pool.pulseFlagged(0);
    const low = colorAt(pool, 'box-2')!.clone();
    pool.pulseFlagged(1);
    const high = colorAt(pool, 'box-2')!;
    expect(low.getHexString()).not.toBe(high.getHexString());
    // 两个端点都在红区：报警色不因为相位差而变成别的颜色
    expect(high.r).toBeGreaterThan(high.g);
    expect(high.r).toBeGreaterThan(high.b);
  });

  test('名单里没有id不会被记账：查不到的货物插不上旗', () => {
    const pool = new CargoPool(8);
    pool.alloc('box-3', [2, 0.25, 2], SIZE, new THREE.Color('#4C9A8A'));
    pool.setFlagged(['not-yet-born']);
    expect(colorAt(pool, 'box-3')?.getHexString()).toBe('4c9a8a');
    expect(colorAt(pool, 'not-yet-born')).toBeUndefined();
  });

  test('标记状态下的常规写位姿仍然保留报警色', () => {
    const pool = new CargoPool(8);
    pool.alloc('box-4', [3, 0.25, 3], SIZE, new THREE.Color('#4C9A8A'));
    pool.setFlagged(['box-4']);
    pool.write('box-4', [4, 0.25, 4], 0, SIZE, new THREE.Color('#4C9A8A'), true);
    expect(colorAt(pool, 'box-4')?.getHexString()).not.toBe('4c9a8a');
    pool.setFlagged([]);
    // 仍在背压：摘旗后交还给背压色，而不是假装那里一切正常
    expect(colorAt(pool, 'box-4')?.getHexString()).toBe('ef4444');
  });
});
