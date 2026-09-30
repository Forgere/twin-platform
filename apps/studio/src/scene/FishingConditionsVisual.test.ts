import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildFishingScene, createFishSimBehavior } from '@twin-platform/plugins-fishing';
import { buildEntityMesh } from './entityMeshes';
import { FishingConditionsVisual } from './FishingConditionsVisual';
import { TwinSceneController } from './TwinSceneController';

const setup = () => {
  const world = new TwinWorld(buildFishingScene(), { seed: 7, behaviors: [createFishSimBehavior()] });
  world.runSteps(1);
  const pond = world.getEntity('pond-01')!;
  const water = buildEntityMesh({ id: pond.id, kind: pond.kind, visual: pond.visual, transform: pond.transform });
  const meshes = new Map<string, THREE.Object3D>([['pond-01', water]]);
  const visual = new FishingConditionsVisual();
  const update = () => visual.update(world, meshes);
  const group = (name: string) => visual.group.getObjectByName(name);
  return { world, visual, update, group, water };
};

const matrices = (object: THREE.Object3D): number[][] => {
  const result: number[][] = [];
  object.traverse((child) => {
    if (child instanceof THREE.InstancedMesh) result.push(Array.from(child.instanceMatrix.array));
  });
  return result;
};

const waterColor = (water: THREE.Object3D): number => ((water.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();

describe('钓场条件 → 3D 的真实状态接线', () => {
  test('控制器每帧的真实更新路径在暂停时仍消费条件，不只是独立模块会画', () => {
    const { world, visual, water, group } = setup();
    // 只跳过 WebGL 构造；运行控制器真实 animateSubParts → 条件表现层路径。
    const controller = Object.assign(Object.create(TwinSceneController.prototype), {
      controller: { world, playing: false },
      entityMeshes: new Map([['pond-01', water]]),
      fishingConditions: visual,
      beltTime: 0,
      rigFlowTan: 0,
      floatBite: { casts: -1, signal: 'none', hook: 'lower', t: 10 },
    }) as { animateSubParts: (delta: number) => void };
    const warm = waterColor(water);
    world.setAttr('rig-01', 'drift', true);
    world.setAttr('rig-01', 'smallFish', true);
    world.setAttr('rig-01', 'waterTemperature', 8);
    world.setAttr('rig-01', 'nestUntil', world.time + 10);
    controller.animateSubParts(0);
    expect(group('fishing-current')?.visible).toBe(true);
    expect(group('fishing-small-fish')?.visible).toBe(true);
    expect(group('fishing-nest')?.visible).toBe(true);
    expect(waterColor(water)).not.toBe(warm);
    visual.dispose();
  });

  test('走水显示流向，小鱼闹窝显示鱼群，打窝显示窝料；关闭各自立即消失', () => {
    const { world, visual, update, group } = setup();
    update();
    for (const name of ['fishing-current', 'fishing-small-fish', 'fishing-nest']) {
      expect(group(name)?.visible, name + ' initially hidden').toBe(false);
    }
    for (const [attr, value, name] of [
      ['drift', true, 'fishing-current'],
      ['smallFish', true, 'fishing-small-fish'],
      ['nestUntil', 120, 'fishing-nest'],
    ] as const) {
      world.setAttr('rig-01', attr, value);
      const before = world.snapshot();
      update();
      expect(group(name)?.visible, name + ' visible after world attr change').toBe(true);
      expect(matrices(group(name)!).length).toBeGreaterThan(0);
      expect(world.snapshot()).toEqual(before); // 表现层不改变仿真和随机数。
      world.setAttr('rig-01', attr, typeof value === 'number' ? 0 : false);
      update();
      expect(group(name)?.visible).toBe(false);
    }
    visual.dispose();
  });

  test('降温改变真实水体颜色，回暖恢复原材质；暂停不推进也能立刻更新', () => {
    const { world, visual, update, water } = setup();
    const warm = waterColor(water);
    const time = world.time;
    world.setAttr('rig-01', 'waterTemperature', 8);
    update();
    expect(waterColor(water)).not.toBe(warm);
    expect(world.time).toBe(time);
    world.setAttr('rig-01', 'waterTemperature', 20);
    update();
    expect(waterColor(water)).toBe(warm);
    visual.dispose();
  });

  test('关掉条件 / 回放旧快照 / 窝料到期 / 移除钓组，不残留视觉状态', () => {
    const { world, visual, update, group, water } = setup();
    const initial = world.snapshot();
    const warm = waterColor(water);
    world.setAttr('rig-01', 'drift', true);
    world.setAttr('rig-01', 'smallFish', true);
    world.setAttr('rig-01', 'waterTemperature', 8);
    world.setAttr('rig-01', 'nestUntil', world.time + 1);
    update();
    expect(group('fishing-nest')?.visible).toBe(true);
    world.runSteps(60);
    update();
    expect(group('fishing-nest')?.visible).toBe(false);
    world.restore(initial);
    update();
    expect(group('fishing-current')?.visible).toBe(false);
    expect(group('fishing-small-fish')?.visible).toBe(false);
    expect(waterColor(water)).toBe(warm);
    world.setAttr('rig-01', 'waterTemperature', 8);
    update();
    world.removeEntity('rig-01');
    update();
    expect(visual.group.visible).toBe(false);
    expect(waterColor(water)).toBe(warm);
    visual.dispose();
  });

  test('同一状态同一仿真时间逐位相同；暂停不动，回放回到相同位置', () => {
    const { world, visual, update } = setup();
    for (const attr of ['drift', 'smallFish']) world.setAttr('rig-01', attr, true);
    world.setAttr('rig-01', 'nestUntil', 100);
    const initial = world.snapshot();
    update();
    const first = matrices(visual.group);
    expect(first.length).toBeGreaterThan(0);
    update();
    expect(matrices(visual.group)).toEqual(first);
    world.runSteps(30);
    update();
    expect(matrices(visual.group)).not.toEqual(first);
    world.restore(initial);
    update();
    expect(matrices(visual.group)).toEqual(first);
    visual.dispose();
  });

  test('场景初值走 config，运行时 attrs 优先；加铅稳钓组但水流不停', () => {
    const { world, visual, update, group } = setup();
    const rig = world.getEntity('rig-01')!;
    rig.config.drift = true;
    update();
    expect(group('fishing-current')?.visible).toBe(true);
    const current = matrices(group('fishing-current')!);
    world.setAttr('rig-01', 'antiDrift', true);
    update();
    expect(matrices(group('fishing-current')!)).toEqual(current);
    world.setAttr('rig-01', 'drift', false);
    update();
    expect(group('fishing-current')?.visible).toBe(false);
    visual.dispose();
  });

  test('所有新增对象最多 6 次实例绘制，物件数量不增加 draw call', () => {
    const { visual } = setup();
    let drawCalls = 0;
    visual.group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        expect(object).toBeInstanceOf(THREE.InstancedMesh);
        drawCalls += 1;
      }
    });
    expect(drawCalls).toBe(6);
    visual.dispose();
  });

  test('释放自有几何和材质，恢复水色但不释放别人的水材质', () => {
    const { world, visual, update, water } = setup();
    const warm = waterColor(water);
    const waterMaterial = (water.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const waterDispose = vi.spyOn(waterMaterial, 'dispose');
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    visual.group.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      resources.add(child.geometry);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) resources.add(material);
    });
    const disposes = [...resources].map((resource) => vi.spyOn(resource, 'dispose'));
    world.setAttr('rig-01', 'waterTemperature', 8);
    update();
    expect(waterColor(water)).not.toBe(warm);
    visual.dispose();
    expect(resources.size).toBeGreaterThan(0);
    for (const dispose of disposes) expect(dispose).toHaveBeenCalledOnce();
    expect(waterColor(water)).toBe(warm);
    expect(waterDispose).not.toHaveBeenCalled();
  });
});
