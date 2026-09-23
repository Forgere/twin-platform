import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { buildEntityMesh } from './entityMeshes';

/**
 * 台钓钓组的模型回归测试。
 *
 * 守三件事（都是踩过的坑）：
 * - 每种零件都有真实几何，不是退回默认灰盒子；
 * - 漂够长、漂尾有可数的目节，钩饵分开（否则饵把钩整个盖住"看不见钩"）；
 * - 逻辑钓组提供三段线（主线 + 两段子线），端点与场景实体 id 对齐。
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
      ['float', '#ff7a3c', [0.1, 0.9, 0.1]],
      ['sinker', '#4a4a4a', [0.09, 0.11, 0.09]],
      ['hook', '#c9ccd1', [0.12, 0.2, 0.12]],
      ['bait', '#e07a5f', [0.14, 0.14, 0.14]],
      ['water', '#2E86AB', [8, 2, 5]],
    ];
    for (const [kind, color, size] of parts) {
      expect(meshCount(buildEntityMesh(entity(kind, color, size))), kind).toBeGreaterThan(0);
    }
  });

  test('浮漂够长，漂尾是 5 个目节 + 漂身 + 漂脚', () => {
    const float = buildEntityMesh(entity('float', '#ff7a3c', [0.1, 0.9, 0.1]));
    expect(meshCount(float)).toBe(7);
    const box = new THREE.Box3().setFromObject(float);
    expect(box.max.y - box.min.y).toBeGreaterThan(0.8);
  });

  test('钩和饵分开画，不会饵把钩盖住', () => {
    const hookBox = new THREE.Box3().setFromObject(buildEntityMesh(entity('hook', '#c9ccd1', [0.12, 0.2, 0.12])));
    const baitBox = new THREE.Box3().setFromObject(buildEntityMesh(entity('bait', '#e07a5f', [0.14, 0.14, 0.14])));
    expect(hookBox.min.x).toBeGreaterThan(baitBox.max.x);
  });

  test('逻辑钓组提供四段线（主线从竿到漂 + 两段子线），端点与场景实体对齐', () => {
    const rig = buildEntityMesh(entity('rig', '#c9b79c', [0.1, 0.1, 0.1]));
    expect(meshCount(rig)).toBe(4);
    const anim = rig.userData.anim as { fishingLines?: { fromId: string; toId: string }[] } | undefined;
    expect(anim?.fishingLines?.map((line) => line.fromId + '->' + line.toId)).toEqual([
      'rod-01->float-01',
      'float-01->sinker-01',
      'sinker-01->hook-upper-01',
      'hook-upper-01->hook-lower-01',
    ]);
  });

  test('钓场装饰（岸坡 / 钓台 / 鱼竿 / 芦苇 / 水草 / 鱼影 / 水底）都有实体几何', () => {
    const parts: [string, string, [number, number, number]][] = [
      ['shore', '#d8c69b', [9.6, 0.05, 6.6]],
      ['pondBottom', '#d9c49a', [8, 0.08, 5]],
      ['platform', '#c94f3d', [0.62, 0.34, 0.45]],
      ['rod', '#8a5a2b', [0.07, 2.6, 0.07]],
      ['reed', '#8a6a45', [0.5, 1.0, 0.2]],
      ['weed', '#4c7a3f', [0.5, 0.36, 0.3]],
      ['fish', '#5c6b73', [0.42, 0.16, 0.1]],
    ];
    for (const [kind, color, size] of parts) {
      expect(meshCount(buildEntityMesh(entity(kind, color, size))), kind).toBeGreaterThan(0);
    }
  });

  test('水面不投影，避免水下钓组被自己的水面阴影糊掉', () => {
    const water = buildEntityMesh(entity('water', '#2E86AB', [8, 2, 5]));
    let shadows = 0;
    water.traverse((child) => {
      if ((child as THREE.Mesh).isMesh && (child as THREE.Mesh).castShadow) shadows += 1;
    });
    expect(shadows).toBe(0);
  });
});
