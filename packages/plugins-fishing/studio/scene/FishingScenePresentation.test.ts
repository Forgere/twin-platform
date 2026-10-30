import { afterEach, describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { disposeObject } from '@twin-platform/studio-sdk/three';
import { createFishingViewFixture } from './sceneFixture';

const allocated: ReturnType<typeof createFishingViewFixture>[] = [];
const setup = () => {
  const run = createFishingViewFixture();
  allocated.push(run);
  return run;
};
afterEach(() => { for (const run of allocated.splice(0)) run.dispose(); });
const waterColor = (water: THREE.Object3D) => ((water.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();

describe('钓场展示模块生命周期', () => {
  test('只认领领域模型，未知类型交回宿主；相机与辅助网格由插件声明', () => {
    const run = setup();
    expect(run.presentation.buildEntity({ id: 'unknown', kind: 'unknown', transform: { position: [0, 0, 0] } })).toBeUndefined();
    expect(run.presentation.showHelpers).toBe(false);
    const view = run.presentation.overview?.();
    expect(view?.eye[2]).toBeGreaterThan(5);
    expect(view?.target[1]).toBeCloseTo(1.1);
    run.world.removeEntity('rig-01');
    expect(run.presentation.overview?.()).toBeUndefined();
  });

  test('网格重建重新取当前实体，旧水材质恢复且不被继续写入', () => {
    const run = setup();
    const oldWater = run.meshes.get('pond-01')!;
    const warm = waterColor(oldWater);
    run.attrs({ inWater: true, casts: 1, drift: true, waterTemperature: 8 });
    run.world.runSteps(120);
    run.frame();
    const before = run.fingerprint();
    expect(waterColor(oldWater)).not.toBe(warm);
    run.rebuild();
    expect(waterColor(oldWater)).toBe(warm);
    expect(run.meshes.get('pond-01')).not.toBe(oldWater);
    run.frame();
    expect(waterColor(run.meshes.get('pond-01')!)).not.toBe(warm);
    expect(waterColor(oldWater)).toBe(warm);
    expect(run.fingerprint()).toEqual(before);
    expect(run.scene.children.filter((object) => object.name === 'fishing-conditions')).toHaveLength(1);
  });

  test('卸载只释放自有装饰资源，实体资源仍由宿主释放', () => {
    const run = createFishingViewFixture();
    const water = run.meshes.get('pond-01')!;
    const warm = waterColor(water);
    const waterMaterial = (water.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const waterDispose = vi.spyOn(waterMaterial, 'dispose');
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    const decoration = run.scene.getObjectByName('fishing-conditions')!;
    decoration.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      resources.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) resources.add(material);
    });
    const disposes = [...resources].map((resource) => vi.spyOn(resource, 'dispose'));
    run.attrs({ waterTemperature: 8 });
    run.frame();
    expect(waterColor(water)).not.toBe(warm);
    run.presentation.dispose();
    expect(decoration.parent).toBeNull();
    expect(water.parent).toBe(run.scene);
    expect(waterColor(water)).toBe(warm);
    for (const dispose of disposes) expect(dispose).toHaveBeenCalledOnce();
    expect(waterDispose).not.toHaveBeenCalled();
    // 模拟宿主随后释放网格；不再次调用已卸载的 Adapter。
    for (const mesh of run.meshes.values()) disposeObject(mesh);
    run.scene.clear();
  });
});
