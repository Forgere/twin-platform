import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { buildFishingEntityMesh } from './fishingMeshes';
import type { EntityMeshInput } from '@twin-platform/studio-sdk';
import { disposeObject } from '@twin-platform/studio-sdk/three';
import { afterEach } from 'vitest';

const allocated: THREE.Group[] = [];
const buildEntityMesh = (entity: EntityMeshInput): THREE.Group => {
  const mesh = buildFishingEntityMesh(entity);
  if (!mesh) throw new Error('Unclaimed test entity: ' + entity.kind);
  allocated.push(mesh);
  return mesh;
};
afterEach(() => { for (const mesh of allocated.splice(0)) disposeObject(mesh); });

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

  test('鱼钩：原点就是钩眼（最高点），钩身垂在下面；比短子线（0.2m）短得多', () => {
    const hook = buildEntityMesh(entity('hook', '#c9ccd1', [0.12, 0.2, 0.12]));
    const box = new THREE.Box3().setFromObject(hook);
    expect(hook.userData.lineAnchor).toEqual([0, 0, 0]);
    expect(box.max.y).toBeCloseTo(0, 2);
    expect(box.max.y - box.min.y).toBeLessThan(0.16);
  });

  test('钩尖和倒刺露在饵外：饵裹在钩弯上，不盖住尖', () => {
    const hook = buildEntityMesh(entity('hook', '#c9ccd1', [0.12, 0.2, 0.12]));
    const bait = buildEntityMesh(entity('bait', '#e07a5f', [0.14, 0.14, 0.14]));
    const part = (name: string) => new THREE.Box3().setFromObject(hook.getObjectByName(name) as THREE.Object3D);
    const baitBox = new THREE.Box3().setFromObject(bait);
    expect(baitBox.intersectsBox(part('hook-body'))).toBe(true);
    expect(part('hook-point').max.y).toBeGreaterThan(baitBox.max.y + 0.02);
    expect(part('hook-barb').max.y).toBeGreaterThan(baitBox.max.y);
    // 尖是尖的：钩尖锥顶端半径为 0。
    const cone = (hook.getObjectByName('hook-point') as THREE.Mesh).geometry as THREE.ConeGeometry;
    expect(cone.parameters.radius).toBeLessThan(0.01);
  });

  test('漂座在漂脚末端（漂的最低点）', () => {
    const float = buildEntityMesh(entity('float', '#ff7a3c', [0.1, 0.9, 0.1]));
    const seat = float.userData.lineAnchor as [number, number, number];
    expect(seat[1]).toBeCloseTo(new THREE.Box3().setFromObject(float).min.y, 5);
  });

  test('鱼竿按 tipOffset 定长定向：竿尖正好落在竿梢导线环上', () => {
    const tipOffset: [number, number, number] = [-0.825, 0.885, -0.625];
    const rod = buildEntityMesh({ ...entity('rod', '#8a5a2b', [0.07, 2.7, 0.07]), config: { tipOffset } });
    rod.updateMatrixWorld(true);
    const tip = new THREE.Vector3();
    const box = new THREE.Box3().setFromObject(rod);
    // 竿尖 = 包围盒里离中心沿 tipOffset 方向最远的那端。
    const dir = new THREE.Vector3(...tipOffset);
    tip.copy(dir);
    expect(box.containsPoint(tip.clone().multiplyScalar(0.99))).toBe(true);
    expect(box.containsPoint(tip.clone().multiplyScalar(1.05))).toBe(false);
  });

  test('逻辑钓组的线：主线 3 段 + 子线 2 根，每根都是 12 截的软绳，端点与场景实体对齐', () => {
    const rig = buildEntityMesh(entity('rig', '#c9b79c', [0.1, 0.1, 0.1]));
    const lines = (rig.userData.anim as { fishingLines?: { fromId: string; toId: string; segment: { index: number } }[] }).fishingLines ?? [];
    const pairs = [...new Set(lines.map((line) => line.fromId + '->' + line.toId))];
    expect(pairs).toEqual([
      'rod-tip-01->float-01',
      'float-01->sinker-01',
      'sinker-01->swivel-01',
      'swivel-01->hook-upper-01',
      'swivel-01->hook-lower-01',
    ]);
    for (const pair of pairs) {
      const segments = lines.filter((line) => line.fromId + '->' + line.toId === pair);
      expect(segments.map((line) => line.segment.index)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    }
  });

  test('钓线看得见：不吃光照、画在半透明水体之后，水体不写深度', () => {
    const rig = buildEntityMesh(entity('rig', '#c9b79c', [0.1, 0.1, 0.1]));
    const lines = (rig.userData.anim as { fishingLines?: { mesh: THREE.Mesh }[] }).fishingLines ?? [];
    for (const { mesh } of lines) {
      expect((mesh.material as THREE.Material).type).toBe('MeshBasicMaterial');
      expect(mesh.renderOrder).toBeGreaterThan(0);
    }
    const water = buildEntityMesh(entity('water', '#2E86AB', [8, 2, 5]));
    water.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.Material).transparent) expect((mesh.material as THREE.Material).depthWrite).toBe(false);
    });
  });

  test('咬钩的鱼挂在钓组上，平时隐藏', () => {
    const rig = buildEntityMesh(entity('rig', '#c9b79c', [0.1, 0.1, 0.1]));
    const biter = (rig.userData.anim as { biter?: THREE.Group }).biter;
    expect(biter?.parent).toBe(rig);
    expect(biter?.visible).toBe(false);
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
  test('浮漂零件全挂在内层枢轴上：漂相动作只动枢轴，实体静止位不变', () => {
    const float = buildEntityMesh(entity('float', '#ff7a3c', [0.1, 0.9, 0.1]));
    const pivot = float.userData.lineAnchorPivot as THREE.Object3D;
    expect(float.children).toEqual([pivot]);
    expect(meshCount(pivot as THREE.Group)).toBe(7);
  });
});
