import * as THREE from 'three';
import { conditionsOf } from '@twin-platform/plugins-fishing';
import type { TwinWorld } from '@twin-platform/world-kernel';

const CURRENT_COUNT = 14;
const FISH_COUNT = 7;
const PELLET_COUNT = 36;
const COLD_WATER = new THREE.Color('#527fc4');
const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

type WaterMaterial = THREE.Material & { color: THREE.Color };

/**
 * 钓场条件的只读表现层：走水的流线、闹窝的小鱼、有效期内的窝料和冷水色。
 *
 * 条件统一走 conditionsOf，动画只取 world.time（暂停不动，seek 可复现）。
 * 鱼群是“闹窝”的示意，不产生鱼口、上鱼或计数；真正咬钩的鱼仍由 animateRig 驱动。
 * 几何只建一次，重复物件用实例绘制，共 6 个 draw call，不进实体拾取表。
 */
export class FishingConditionsVisual {
  readonly group = new THREE.Group();
  private readonly current = new THREE.Group();
  private readonly fish = new THREE.Group();
  private readonly nest = new THREE.Group();
  private readonly shafts: THREE.InstancedMesh;
  private readonly tips: THREE.InstancedMesh;
  private readonly bodies: THREE.InstancedMesh;
  private readonly tails: THREE.InstancedMesh;
  private readonly eyes: THREE.InstancedMesh;
  private readonly pellets: THREE.InstancedMesh;
  private readonly stamp = new THREE.Object3D();
  private readonly bait = new THREE.Vector3();
  private readonly waterColors = new Map<WaterMaterial, THREE.Color>();
  private water: THREE.Object3D | undefined;

  constructor() {
    this.group.name = 'fishing-conditions';
    this.current.name = 'fishing-current';
    this.fish.name = 'fishing-small-fish';
    this.nest.name = 'fishing-nest';
    this.group.add(this.current, this.fish, this.nest);
    this.group.visible = this.current.visible = this.fish.visible = this.nest.visible = false;

    const flow = new THREE.MeshBasicMaterial({ color: '#57c6e2', transparent: true, opacity: 0.62, depthWrite: false });
    this.shafts = this.instances(this.current, new THREE.CylinderGeometry(0.012, 0.012, 0.4, 5), flow, CURRENT_COUNT);
    this.tips = this.instances(this.current, new THREE.ConeGeometry(0.05, 0.12, 5), flow, CURRENT_COUNT);
    const fishMaterial = new THREE.MeshStandardMaterial({ color: '#b6a07a', roughness: 0.6 });
    this.bodies = this.instances(this.fish, new THREE.SphereGeometry(1, 10, 6), fishMaterial, FISH_COUNT);
    const tailGeometry = new THREE.ConeGeometry(0.065, 0.12, 3);
    tailGeometry.rotateZ(Math.PI / 2);
    this.tails = this.instances(this.fish, tailGeometry, fishMaterial, FISH_COUNT);
    this.eyes = this.instances(this.fish, new THREE.SphereGeometry(0.014, 6, 4), new THREE.MeshBasicMaterial({ color: '#29281f' }), FISH_COUNT * 2);
    this.pellets = this.instances(this.nest, new THREE.SphereGeometry(0.026, 6, 4), new THREE.MeshStandardMaterial({ color: '#dba45b', roughness: 0.95 }), PELLET_COUNT);
  }

  /** 世界状态变化即刻反映；不要求世界正在播放，也不积累真实帧间隔。 */
  update(world: Pick<TwinWorld, 'getEntity' | 'time'>, meshes: ReadonlyMap<string, THREE.Object3D>): void {
    const rig = world.getEntity('rig-01');
    this.group.visible = !!rig;
    if (!rig) {
      this.current.visible = this.fish.visible = this.nest.visible = false;
      this.tintWater(undefined, 0);
      return;
    }
    const conditions = conditionsOf(rig);
    const time = world.time;
    const surface = numberOr(rig.config.surfaceY, 2);
    const depth = Math.max(0.1, numberOr(rig.config.depth, 2));
    const bottom = world.getEntity('bottom-01');
    const floor = bottom ? bottom.transform.position[1] + (bottom.visual?.size?.[1] ?? 0) / 2 : surface - depth;
    const cold = Math.min(1, Math.max(0, (12 - conditions.waterTemperature) / 4));
    this.tintWater(meshes.get('pond-01'), cold);

    // 跟随已经解出的钩饵位置，不另算漂相、受力链或走水位移。
    const baitObject = meshes.get('bait-lower-01');
    const pivot = baitObject?.userData.lineAnchorPivot as THREE.Object3D | undefined;
    if (baitObject) (pivot?.children[0] ?? pivot ?? baitObject).getWorldPosition(this.bait);
    else this.bait.fromArray(world.getEntity('bait-lower-01')?.transform.position ?? rig.transform.position);

    this.current.visible = conditions.drift;
    this.fish.visible = conditions.smallFish;
    this.nest.visible = time < conditions.nestUntil;
    if (this.current.visible) {
      // 加铅能稳钓组，不能让水流停止；antiDrift 不影响这里的流线。
      for (let i = 0; i < CURRENT_COUNT; i += 1) {
        const phase = (time * 0.34 + i * 0.618) % 1;
        const x = rig.transform.position[0] - 1.5 + phase * 3;
        const y = i < 6 ? surface + 0.025 : floor + depth * (0.25 + (i % 3) * 0.21);
        const z = rig.transform.position[2] + ((i % 4) - 1.5) * 0.42;
        this.stamp.position.set(x, y, z);
        this.stamp.rotation.set(0, 0, -Math.PI / 2);
        this.stamp.scale.setScalar(1);
        this.put(this.shafts, i);
        this.stamp.position.x += 0.25;
        this.put(this.tips, i);
      }
      this.dirty(this.shafts, this.tips);
    }
    if (this.fish.visible) {
      for (let i = 0; i < FISH_COUNT; i += 1) {
        const angle = time * (cold > 0 ? 0.55 : 1.7) + i * 2.4;
        const radius = 0.32 + (i % 3) * 0.17;
        const yaw = -angle - Math.PI / 2;
        const x = this.bait.x + Math.cos(angle) * radius;
        const y = Math.max(floor + 0.15, Math.min(surface - 0.15, this.bait.y + 0.18 + (i % 3) * 0.07 + Math.sin(angle * 2) * 0.04));
        const z = this.bait.z + Math.sin(angle) * radius * 0.6;
        this.stamp.position.set(x, y, z);
        this.stamp.rotation.set(0, yaw, 0);
        this.stamp.scale.set(0.15, 0.063, 0.042);
        this.put(this.bodies, i);
        this.stamp.position.set(x - Math.cos(yaw) * 0.18, y, z + Math.sin(yaw) * 0.18);
        this.stamp.rotation.y += Math.sin(time * 13 + i) * 0.35;
        this.stamp.scale.set(1, 1, 0.45);
        this.put(this.tails, i);
        for (let side = 0; side < 2; side += 1) {
          const dz = side === 0 ? -0.034 : 0.034;
          this.stamp.position.set(x + Math.cos(yaw) * 0.10 + Math.sin(yaw) * dz, y + 0.018, z - Math.sin(yaw) * 0.10 + Math.cos(yaw) * dz);
          this.stamp.scale.setScalar(1);
          this.put(this.eyes, i * 2 + side);
        }
      }
      this.dirty(this.bodies, this.tails, this.eyes);
    }
    if (this.nest.visible) {
      for (let i = 0; i < PELLET_COUNT; i += 1) {
        const angle = i * 2.399963;
        const radius = Math.sqrt((i + 1) / PELLET_COUNT) * 0.52;
        // 多数颗粒散在底上，少量悬浮轻晃，表示当前有效的窝料而非又打了一次窝。
        const suspension = i % 3 === 0 ? 0.12 + (i % 5) * 0.06 + Math.sin(time * 0.7 + i) * 0.04 : 0;
        this.stamp.position.set(rig.transform.position[0] + Math.cos(angle) * radius, floor + 0.028 + suspension, rig.transform.position[2] + Math.sin(angle) * radius);
        this.stamp.rotation.set(0, angle, 0);
        this.stamp.scale.setScalar(0.8 + (i % 4) * 0.15);
        this.put(this.pellets, i);
      }
      this.dirty(this.pellets);
    }
  }

  dispose(): void {
    this.tintWater(undefined, 0);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.removeFromParent();
  }

  private instances(parent: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // 实例每帧移动，不能沿用初始位置的包围球。
    parent.add(mesh);
    return mesh;
  }

  private put(mesh: THREE.InstancedMesh, index: number): void {
    this.stamp.updateMatrix();
    mesh.setMatrixAt(index, this.stamp.matrix);
  }

  private dirty(...meshes: THREE.InstancedMesh[]): void {
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /** 保存 / 还原水体原色；不接管涟漪颜色，也不释放外部模型的材质。 */
  private tintWater(water: THREE.Object3D | undefined, cold: number): void {
    if (water !== this.water) {
      for (const [material, color] of this.waterColors) material.color.copy(color);
      this.waterColors.clear();
      this.water = water;
      // buildWater 的前三个子网格是水体、表面和深水层，之后的涟漪保持白色。
      for (const child of water?.children.slice(0, 3) ?? []) {
        if (!(child instanceof THREE.Mesh)) continue;
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
          if ('color' in material && material.color instanceof THREE.Color) this.waterColors.set(material as WaterMaterial, material.color.clone());
        }
      }
    }
    for (const [material, color] of this.waterColors) material.color.copy(color).lerp(COLD_WATER, cold * 0.8);
  }
}
