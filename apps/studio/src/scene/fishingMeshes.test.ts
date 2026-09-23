import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { buildEntityMesh } from './entityMeshes';

/**
 * 台钓钓组的模型回归测试。
 *
 * 之前这些 kind 在实体模型工厂里没有分支，全部退回默认灰盒子——加上写死的物流机位，
 * 切到钓场就是"外面什么也看不到"。这里守两件事：每种零件都有真实几何；逻辑钓组不画盒子。
 */

const meshCount = (group: THREE.Group): number => {
  let count = 0;
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) count += 1;
  });
  return count;
};

const entity = (kind: string, color: string, size: [number, number, number]) => ({
  id: kind + '-01',
  kind,
  visual: { kind, color, size },
  transform: { position: [0, 0, 0] as [number, number, number] },
});

describe('台钓钓组模型', () => {
  test('漂 / 铅 / 钩 / 饵 / 水 都有实体几何，不是空组', () => {
    const parts: [string, string, [number, number, number]][] = [
      ['float', '#ff7a3c', [0.1, 0.42, 0.1]],
      ['sinker', '#4a4a4a', [0.06, 0.07, 0.06]],
      ['hook', '#c9ccd1', [0.06, 0.07, 0.06]],
      ['bait', '#e07a5f', [0.06, 0.06, 0.06]],
      ['water', '#2E86AB', [12, 2, 8]],
    ];
    for (const [kind, color, size] of parts) {
      expect(meshCount(buildEntityMesh(entity(kind, color, size))), kind).toBeGreaterThan(0);
    }
  });

  test('浮漂是三段造型（漂尾 + 漂身 + 漂脚）', () => {
    expect(meshCount(buildEntityMesh(entity('float', '#ff7a3c', [0.1, 0.42, 0.1])))).toBe(3);
  });

  test('逻辑钓组不画实体，免得场景里多个灰盒子', () => {
    expect(meshCount(buildEntityMesh(entity('rig', '#c9b79c', [0.1, 0.1, 0.1])))).toBe(0);
  });

  test('水面不投影，避免水下钓组被自己的水面阴影糊掉', () => {
    const water = buildEntityMesh(entity('water', '#2E86AB', [12, 2, 8]));
    let shadows = 0;
    water.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).castShadow) shadows += 1;
    });
    expect(shadows).toBe(0);
  });
});
