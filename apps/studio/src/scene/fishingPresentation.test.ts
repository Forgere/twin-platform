import { describe, expect, test } from 'vitest';
import * as THREE from 'three';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildFishingScene, LIFT_WINDOW } from '@twin-platform/plugins-fishing';
import { TwinSceneController } from './TwinSceneController';
import { buildEntityMesh, type EntityAnim } from './entityMeshes';
import { FishingConditionsVisual } from './FishingConditionsVisual';
import { MAX_FLOAT_DROP, SIGNAL_DURATION } from './floatSignal';
import { type Rope } from './rope';

const setup = () => {
  const world = new TwinWorld(buildFishingScene(), { seed: 7, behaviors: [] });
  for (const [key, value] of Object.entries({ fishingMode: 'sim', manualCast: true, autoLift: false, rigPhase: 'fishing', inWater: false, signal: 'none', castAt: -1 })) world.setAttr('rig-01', key, value);
  const scene = new THREE.Scene();
  const meshes = new Map<string, THREE.Object3D>();
  for (const entity of world.listEntities()) {
    const mesh = buildEntityMesh({ id: entity.id, kind: entity.kind, visual: entity.visual, transform: entity.transform, config: entity.config });
    mesh.position.set(...entity.transform.position);
    meshes.set(entity.id, mesh);
    scene.add(mesh);
  }
  const visual = new FishingConditionsVisual();
  const ropes = new Map<string, Rope>();
  const controller = Object.assign(Object.create(TwinSceneController.prototype), {
    controller: { world, playing: true },
    entityMeshes: meshes,
    fishingConditions: visual,
    beltTime: 0,
    rigFlowTan: 0,
    rigFloorY: 0,
    rigSurfaceY: 2,
    ropes,
    lineLengths: new Map(),
    floatBite: { casts: -1, bites: -1, signal: 'none', hook: 'lower', t: SIGNAL_DURATION },
  }) as { animateSubParts: (delta: number) => void; controller: { playing: boolean } };
  const frame = (dt = 1 / 60) => { controller.animateSubParts(dt); scene.updateMatrixWorld(true); };
  const attrs = (values: Record<string, string | number | boolean>) => { for (const [key, value] of Object.entries(values)) world.setAttr('rig-01', key, value); };
  const pivot = (id: string) => meshes.get(id)!.userData.lineAnchorPivot as THREE.Object3D;
  const anchor = (id: string) => {
    const mesh = meshes.get(id)!;
    const point = new THREE.Vector3(...(mesh.userData.lineAnchor ?? [0, 0, 0]));
    return (mesh.userData.lineAnchorPivot ?? mesh).localToWorld(point);
  };
  const biter = () => (meshes.get('rig-01')!.userData.anim as EntityAnim).biter!;
  const fingerprint = () => [...meshes.entries()].map(([id, mesh]) => ({
    id, visible: mesh.visible,
    parts: (() => { const values: number[][] = []; mesh.traverse((child) => values.push([...child.position.toArray(), ...child.quaternion.toArray(), ...child.scale.toArray()])); return values; })(),
  }));
  return { world, meshes, controller, frame, attrs, pivot, anchor, biter, ropes, fingerprint, dispose: () => visual.dispose() };
};

describe('抛竿 / 入水 / 鱼口的实际钓组表现', () => {
  test('未抛竿与收竿不再显示水下钓组；测量和找底预览仍显示', () => {
    const run = setup();
    run.frame();
    for (const id of ['rig-01', 'float-01', 'sinker-01', 'hook-lower-01', 'bait-lower-01']) expect(run.meshes.get(id)?.visible, id).toBe(false);
    expect(run.meshes.get('rod-01')?.visible).toBe(true);
    for (const phase of ['measure_t0', 'find_bottom']) {
      run.attrs({ rigPhase: phase });
      run.frame();
      expect(run.meshes.get('float-01')?.visible).toBe(true);
      expect(run.meshes.get('rig-01')?.visible).toBe(true);
    }
    run.attrs({ rigPhase: 'fishing', inWater: true, castAt: 0, casts: 1 });
    run.frame();
    expect(run.meshes.get('float-01')?.visible).toBe(true);
    run.attrs({ inWater: false, pendingBite: false, signal: 'none' });
    run.frame();
    expect(run.meshes.get('rig-01')?.visible).toBe(false);
    expect(run.biter().visible).toBe(false);
    run.dispose();
  });

  test('新抛竿的漂钩从水面附近入水，再下沉至真实布局，钓线始终接着对应挂点', () => {
    const run = setup();
    run.attrs({ inWater: true, castAt: 0, casts: 1 });
    run.frame();
    const entry = run.anchor('hook-lower-01').y;
    expect(entry).toBeGreaterThan(1.8);
    run.world.runSteps(24);
    run.frame();
    expect(run.anchor('hook-lower-01').y).toBeLessThan(entry);
    run.world.runSteps(36);
    run.frame();
    expect(run.anchor('hook-lower-01').y).toBeLessThan(0.5);
    for (const [key, rope] of run.ropes) {
      const [from, to] = key.split('->');
      expect(new THREE.Vector3(...rope.point(0)).distanceTo(run.anchor(from))).toBeLessThan(1e-8);
      expect(new THREE.Vector3(...rope.point(12)).distanceTo(run.anchor(to))).toBeLessThan(1e-8);
    }
    run.dispose();
  });

  test('延迟黑漂按 biteUntil 还原当前口龄，鱼、饵、钩、线同步，漂下沉仍受浮力上限约束', () => {
    const run = setup();
    run.world.runSteps(60 * 4);
    run.attrs({ inWater: true, castAt: 0, casts: 1, bites: 0, signal: 'none' });
    run.frame();
    const idleFloat = run.anchor('float-01').y;
    run.attrs({ bites: 1, signal: 'sink', bitHook: 'lower', pendingBite: true, biteUntil: run.world.time + LIFT_WINDOW - 0.6 });
    run.frame(0);
    const drop = idleFloat - run.anchor('float-01').y;
    expect(drop).toBeGreaterThan(0.1);
    expect(drop).toBeLessThanOrEqual(MAX_FLOAT_DROP.sink + 1e-6);
    expect(run.biter().visible).toBe(true);
    expect(run.anchor('hook-lower-01').x).toBeGreaterThan(0.3);
    for (const [key, rope] of run.ropes) {
      const [from, to] = key.split('->');
      expect(new THREE.Vector3(...rope.point(0)).distanceTo(run.anchor(from))).toBeLessThan(1e-8);
      expect(new THREE.Vector3(...rope.point(12)).distanceTo(run.anchor(to))).toBeLessThan(1e-8);
    }
    run.attrs({ signal: 'none', pendingBite: false });
    run.frame();
    expect(run.biter().visible).toBe(false);
    expect(run.anchor('float-01').y).toBeCloseTo(idleFloat, 9);
    run.dispose();
  });

  test('同一 world.time 不受 renderDelta、暂停或历史帧影响；seek 相同快照恢复相同节点', () => {
    const run = setup();
    run.world.runSteps(120);
    run.attrs({ inWater: true, castAt: 0, casts: 1, bites: 1, drift: true, pendingBite: true, signal: 'run', bitHook: 'upper', biteUntil: run.world.time + LIFT_WINDOW - 0.5 });
    const snapshot = run.world.snapshot();
    run.frame(1 / 240);
    const original = run.fingerprint();
    const ropes = [...run.ropes.values()].map((rope) => Array.from(rope.nodes));
    run.frame(0.9);
    expect(run.fingerprint()).toEqual(original);
    expect([...run.ropes.values()].map((rope) => Array.from(rope.nodes))).toEqual(ropes);
    run.controller.controller.playing = false;
    run.frame(0.5);
    expect(run.fingerprint()).toEqual(original);
    run.world.runSteps(12);
    run.frame(0.2);
    expect(run.fingerprint()).not.toEqual(original);
    run.world.restore(snapshot);
    run.frame(0.03);
    expect(run.fingerprint()).toEqual(original);
    expect([...run.ropes.values()].map((rope) => Array.from(rope.nodes))).toEqual(ropes);
    run.dispose();
  });
});
