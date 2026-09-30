import * as THREE from 'three';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildFishingScene } from '@twin-platform/plugins-fishing';
import { disposeObject } from '@twin-platform/studio-sdk/three';
import { createFishingScenePresentation } from './FishingScenePresentation';
import type { FishingEntityAnim } from './fishingMeshes';

/** 测试与宿主跨同一个展示接口，不绕过构造器或调用私有动画方法。 */
export function createFishingViewFixture() {
  const world = new TwinWorld(buildFishingScene(), { seed: 7, behaviors: [] });
  const attrs = (values: Record<string, string | number | boolean>) => {
    for (const [key, value] of Object.entries(values)) world.setAttr('rig-01', key, value);
  };
  attrs({ fishingMode: 'sim', manualCast: true, autoLift: false, rigPhase: 'fishing', inWater: false, signal: 'none', castAt: -1 });
  const scene = new THREE.Scene();
  const meshes = new Map<string, THREE.Object3D>();
  const presentation = createFishingScenePresentation({ world, scene, meshes });
  const rebuild = () => {
    presentation.reset?.();
    for (const mesh of meshes.values()) {
      mesh.removeFromParent();
      disposeObject(mesh);
    }
    meshes.clear();
    for (const entity of world.listEntities()) {
      const mesh = presentation.buildEntity(entity);
      if (!mesh) throw new Error('Unclaimed fixture entity: ' + entity.kind);
      mesh.position.set(...entity.transform.position);
      mesh.rotation.y += entity.transform.rotation?.[1] ?? 0;
      meshes.set(entity.id, mesh);
      scene.add(mesh);
    }
  };
  rebuild();
  const frame = () => { presentation.update(); scene.updateMatrixWorld(true); };
  const pivot = (id: string) => meshes.get(id)!.userData.lineAnchorPivot as THREE.Object3D;
  const anchor = (id: string) => {
    const mesh = meshes.get(id)!;
    const point = new THREE.Vector3(...(mesh.userData.lineAnchor ?? [0, 0, 0]));
    return (mesh.userData.lineAnchorPivot ?? mesh).localToWorld(point);
  };
  const biter = () => (meshes.get('rig-01')!.userData.anim as FishingEntityAnim).biter!;
  /** 直接观察渲染圆柱段的两端，而不是读取 Adapter 私有软绳缓存。 */
  const lines = () => {
    const segments = (meshes.get('rig-01')!.userData.anim as FishingEntityAnim).fishingLines ?? [];
    const result = new Map<string, { from: THREE.Vector3; to: THREE.Vector3 }>();
    for (const line of segments) {
      if (!line.mesh.visible) continue;
      const key = line.fromId + '->' + line.toId;
      if (line.segment.index === 0) result.set(key, {
        from: line.mesh.localToWorld(new THREE.Vector3(0, -0.5, 0)),
        to: new THREE.Vector3(),
      });
      if (line.segment.index === line.segment.count - 1) result.get(key)?.to.copy(line.mesh.localToWorld(new THREE.Vector3(0, 0.5, 0)));
    }
    return result;
  };
  const fingerprint = () => [...meshes.entries()].map(([id, mesh]) => ({
    id, visible: mesh.visible,
    parts: (() => { const values: number[][] = []; mesh.traverse((child) => values.push([...child.position.toArray(), ...child.quaternion.toArray(), ...child.scale.toArray()])); return values; })(),
  }));
  const dispose = () => {
    presentation.dispose();
    for (const mesh of meshes.values()) disposeObject(mesh);
    scene.clear();
    meshes.clear();
  };
  return { world, scene, meshes, presentation, frame, attrs, pivot, anchor, biter, lines, fingerprint, rebuild, dispose };
}
