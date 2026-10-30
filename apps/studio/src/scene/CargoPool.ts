import * as THREE from 'three';
import type { TwinVector3 } from '@twin-platform/world-kernel';

/**
 * 物料（parcel / pallet）实例化渲染池。
 *
 * 之前每个货物是一个独立 `THREE.Group`，规模一大就掉帧，而且看不出"谁是谁"。
 * 这里改用单个 `InstancedMesh`：
 * - 槽位池 + 空闲栈，spawn/removed 只改槽位，不重建数组；
 * - 每帧 `moved` 只写变化矩阵的槽位，delta 为空不碰 GPU；
 * - 颜色按 id 哈希轮转（5 色），背压/堵住的货物染红；
 * - 回收用零缩放矩阵泊到 `y = -100`，绝不重建数组。
 *
 * 与 r3f-tools 的 `InstancedMeshPool` 思路一致：单池、显式 `setInstanceCount`、
 * 回收零缩放。几何用单位立方体，尺寸靠实例矩阵缩放，所以不同尺寸的货共用一套几何。
 */

const STUCK_COLOR = new THREE.Color('#EF4444');
/** 审计违例色：闪烁脉冲在它与浅色之间插值，所以两色都要留着。 */
const FLAG_LOW = new THREE.Color('#B3261E');
const FLAG_HIGH = new THREE.Color('#FF8A80');
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class CargoPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly capacity: number;
  private readonly idToSlot = new Map<string, number>();
  private readonly slotToId: (string | undefined)[];
  private readonly freeSlots: number[] = [];
  private readonly dummy = new THREE.Object3D();
  private readonly baseColor = new THREE.Color();
  private readonly stuck = new Set<string>();
  /** 本帧真正移动过的货物 id，供控制器做背压判定。 */
  readonly movedThisFrame = new Set<string>();
  private readonly lastMatrix = new Map<string, THREE.Matrix4>();
  /** 每个货物的常规色（身份色），摘掉审计标记后按它还原。 */
  private readonly lastColor = new Map<string, THREE.Color>();
  /** 被审计点名的货物：颜色由脉冲接管，不走身份色与背压色。 */
  private readonly flagged = new Set<string>();
  private readonly flagMix = new THREE.Color();

  constructor(capacity = 2048, baseColor = '#F4A07A') {
    this.capacity = capacity;
    this.slotToId = new Array(capacity).fill(undefined);
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.05 });
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.count = capacity;
    this.baseColor.set(baseColor);
    // 所有槽位先零缩放（不可见），alloc 时才写真实矩阵。
    for (let i = 0; i < capacity; i += 1) {
      this.mesh.setMatrixAt(i, ZERO);
      this.freeSlots.push(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    // 初始化 instanceColor，否则首帧 setColorAt 不生效。
    this.mesh.setColorAt(0, this.baseColor);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  get entityCount(): number {
    return this.idToSlot.size;
  }

  /** 该货物当前是否在池里（控制器据此分流 changed / removed）。 */
  has(id: string): boolean {
    return this.idToSlot.has(id);
  }

  /** 分配槽位并写入初始位姿 + 颜色。池满则静默降级（不再渲染该货）。 */
  alloc(id: string, position: TwinVector3, size: TwinVector3, color: THREE.Color): void {
    if (this.idToSlot.has(id)) return;
    const slot = this.freeSlots.pop();
    if (slot === undefined) return;
    this.idToSlot.set(id, slot);
    this.slotToId[slot] = id;
    this.stuck.delete(id);
    this.write(id, position, 0, size, color, false);
  }

  /** 写位姿（位置 + 绕 Y 朝向 + 尺寸）；颜色随身份/背压变化。 */
  write(id: string, position: TwinVector3, rotationY: number, size: TwinVector3, color: THREE.Color, stuck: boolean): void {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return;
    this.dummy.position.set(position[0], position[1], position[2]);
    this.dummy.rotation.set(0, rotationY, 0);
    this.dummy.scale.set(size[0], size[1], size[2]);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(slot, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.lastMatrix.set(id, this.dummy.matrix.clone());

    this.lastColor.set(id, color);
    // 审计标记压过背压色：违例比堵住了更该被看见。
    const target = this.flagged.has(id) ? FLAG_LOW : stuck ? STUCK_COLOR : color;
    this.mesh.setColorAt(slot, target);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    if (stuck) this.stuck.add(id);
    else this.stuck.delete(id);
    this.movedThisFrame.add(id);
  }

  /**
   * 审计标记：把一批货物交给脉冲色接管，不在名单上的立刻还原。
   *
   * 只认池里真有的 id——对着一个还没出生或已被运走的货物插旗没有意义，
   * 那是拿审计的名字去点一个画面上不存在的东西。
   */
  setFlagged(ids: readonly string[]): void {
    const next = new Set<string>();
    for (const id of ids) if (this.idToSlot.has(id)) next.add(id);
    let touched = false;
    for (const id of [...this.flagged]) {
      if (next.has(id)) continue;
      this.flagged.delete(id);
      this.recolor(id);
      touched = true;
    }
    for (const id of next) {
      if (this.flagged.has(id)) continue;
      this.flagged.add(id);
      this.recolor(id);
      touched = true;
    }
    if (touched && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** 回收槽位：零缩放 + 归还空闲栈。 */
  free(id: string): void {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return;
    this.mesh.setMatrixAt(slot, ZERO);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.slotToId[slot] = undefined;
    this.idToSlot.delete(id);
    this.stuck.delete(id);
    this.flagged.delete(id);
    this.lastColor.delete(id);
    this.lastMatrix.delete(id);
    this.freeSlots.push(slot);
  }

  /** 按当前标记状态重写一个实例的颜色（退标记后回到身份色 / 背压色）。 */
  private recolor(id: string): void {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return;
    const color = this.flagged.has(id)
      ? FLAG_LOW
      : this.stuck.has(id)
        ? STUCK_COLOR
        : (this.lastColor.get(id) ?? this.baseColor);
    this.mesh.setColorAt(slot, color);
  }

  /**
   * 每帧脉冲：k = 0..1，在暗红与警示红之间插值。
   *
   * 只碰被标记的槽位；数量由违例数决定，不随场景规模增长。
   */
  pulseFlagged(k: number): void {
    if (this.flagged.size === 0) return;
    this.flagMix.copy(FLAG_LOW).lerp(FLAG_HIGH, k);
    for (const id of this.flagged) {
      const slot = this.idToSlot.get(id);
      if (slot === undefined) continue;
      this.mesh.setColorAt(slot, this.flagMix);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** 射线命中 InstancedMesh 后，用 instanceId 反查实体 id。 */
  entityIdAt(instanceId: number): string | undefined {
    return this.slotToId[instanceId];
  }

  /** 取某货物当前世界矩阵（选中框用）。 */
  matrixOf(id: string): THREE.Matrix4 | undefined {
    return this.lastMatrix.get(id);
  }

  /** 一键把整池写回零缩放（切主题 / 重置场景时）。 */
  clear(): void {
    for (const id of [...this.idToSlot.keys()]) this.free(id);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
