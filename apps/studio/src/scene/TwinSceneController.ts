import CameraControls from 'camera-controls';
import type { ReplayController } from '@twin-platform/replay-core';
import type { TwinScene, TwinVector3, FrameDelta } from '@twin-platform/world-kernel';
import * as THREE from 'three';
import { entityLabel } from './demoScene';
import {
  buildEntityMesh,
  collectMaterials,
  disposeObject,
  type EntityMeshInput,
  type EntityAnim,
} from './entityMeshes';
import { CargoPool } from './CargoPool';
import { getActiveTheme, setActiveTheme, themeByName, cargoColorFor, type ThemeName } from './theme';

CameraControls.install({ THREE });

export type CameraPreset =
  | 'overview'
  | 'infeed'
  | 'inspection'
  | 'sorter'
  | 'warehouse'
  | 'aisle'
  | 'outfeed'
  | 'external';

export interface TwinEntityView {
  id: string;
  label: string;
  kind: string;
}

export interface TwinSceneControllerOptions {
  scene: TwinScene;
  /** 时间轴控制器：渲染层的推进完全由它决定，视口自己不推演状态。 */
  controller: ReplayController;
}

const DEFAULT_SIZE: TwinVector3 = [0.7, 0.7, 0.7];
/** 选中高亮色（暖橘，和奶油色场景对比足够）。 */
const HIGHLIGHT = '#F4A261';
/** 滚筒滚动角速度（rad/s），仅播放时转。 */
const ROLLER_SPIN = 3.0;

/** 物料类实体：走实例化池，不走逐实体 Group。 */
function isCargoKind(kind: string): boolean {
  return kind === 'parcel' || kind === 'pallet';
}

export class TwinSceneController {
  /**
   * 场景里**全部**可选实体，含在制物料、堆垛机与货叉。
   *
   * 之前这里把 `parcel` 过滤掉了，结果物料既不在列表里、点击也解析不出视图，
   * 看上去就是"货物点不中"。现在拾取与选中解析都基于这张全量表，
   * 侧边栏要按类别显示由 UI 层自己筛。
   */
  readonly entities: TwinEntityView[];

  private readonly controller: ReplayController;
  private readonly worldScene: TwinScene;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly entityMeshes = new Map<string, THREE.Object3D>();
  /** 物料（parcel/pallet）走实例化池，省 draw call。 */
  private readonly cargoPool: CargoPool;
  /** 物料尺寸：帧差量里不带 size，靠实体声明记住，write 时复用。 */
  private readonly entitySizes = new Map<string, TwinVector3>();
  /** 皮带箭头流动时间（秒），暂停即停——视觉跟随仿真。 */
  private beltTime = 0;
  private selectionHelper: THREE.Object3D | undefined;
  private selectedId: string | undefined;
  private readonly resizeObserver: ResizeObserver;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: CameraControls;
  private frameId: number | undefined;

  constructor(
    private readonly host: HTMLElement,
    private readonly onSelect: (entity: TwinEntityView | undefined) => void,
    options: TwinSceneControllerOptions,
  ) {
    this.controller = options.controller;
    this.worldScene = options.scene;
    this.entities = options.scene.entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      label: entityLabel(entity.config?.label, entity.id),
    }));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor('#F5F2EB');
    this.renderer.shadowMap.enabled = true;
    this.host.append(this.renderer.domElement);
    this.camera.position.set(20, 24, 40);
    this.controls = new CameraControls(this.camera, this.renderer.domElement);
    this.controls.smoothTime = 0.32;
    this.controls.draggingSmoothTime = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 90;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.setTarget(4, 1, 4, false);

    this.cargoPool = new CargoPool();
    this.scene.add(this.cargoPool.mesh);

    this.buildEnvironment(this.worldScene);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.renderer.domElement.addEventListener('pointerdown', this.pick);
    this.resize();
    this.renderFrame();
  }

  /** 仿真时间（秒），供 HUD 显示。 */
  get simTime(): number {
    return this.controller.time;
  }

  /** 当前主题名，供 UI 同步按钮态。 */
  get themeName(): ThemeName {
    return getActiveTheme().name;
  }

  /** 点中实体后，回答"它由哪段代码渲染"——模型溯源，调试用。 */
  codePath(id: string): string {
    if (this.cargoPool.has(id)) return 'CargoPool.ts (instanced, capacity 2048)';
    const object = this.entityMeshes.get(id);
    return (object?.userData.codePath as string | undefined) ?? 'unknown';
  }

  /** 切主题：换 DeviceTheme 对象 + 整场重建（圆角/颜色/材质都来自主题）。 */
  setTheme(name: ThemeName): void {
    setActiveTheme(themeByName(name));
    this.rebuildEntities();
  }

  selectEntity(id: string): void {
    // 设备：保留自发光高亮（状态灯自发光会被还原到 baseEmissive）。
    for (const [entityId, object] of this.entityMeshes) {
      for (const material of collectMaterials(object)) {
        if (entityId === id) {
          material.emissive.set(HIGHLIGHT);
          material.emissiveIntensity = 0.55;
        } else {
          material.emissive.setHex(Number(material.userData.baseEmissive ?? 0));
          material.emissiveIntensity = Number(material.userData.baseEmissiveIntensity ?? 0);
        }
      }
    }
    // 选中框：设备用 BoxHelper 包模型，货物用 Box3Helper 包实例。
    this.removeSelectionHelper();
    this.selectedId = id;
    if (this.cargoPool.has(id)) {
      const matrix = this.cargoPool.matrixOf(id);
      if (matrix) {
        const box = new THREE.Box3().setFromMatrix4(matrix);
        const helper = new THREE.Box3Helper(box, new THREE.Color(HIGHLIGHT));
        this.selectionHelper = helper;
        this.scene.add(helper);
      }
    } else {
      const object = this.entityMeshes.get(id);
      if (object) {
        const helper = new THREE.BoxHelper(object, HIGHLIGHT);
        this.selectionHelper = helper;
        this.scene.add(helper);
      }
    }
    this.onSelect(this.entities.find((entity) => entity.id === id));
  }

  focusEntity(id: string): void {
    const mesh = this.entityMeshes.get(id);
    if (!mesh) return;
    const target = mesh.getWorldPosition(new THREE.Vector3());
    void this.controls.setLookAt(target.x + 5.2, target.y + 4.4, target.z + 6.4, target.x, target.y, target.z, true);
  }

  setCameraPreset(preset: CameraPreset): void {
    switch (preset) {
      case 'overview':
        void this.controls.setLookAt(20, 24, 40, 4, 1, 4, true);
        return;
      case 'infeed':
        void this.controls.setLookAt(-20, 6.5, 13, -14, 0.8, 1, true);
        return;
      case 'inspection':
        void this.controls.setLookAt(-8.5, 5, 11, -8.5, 1.1, 0, true);
        return;
      case 'sorter':
        void this.controls.setLookAt(1.5, 5, 11, 1.5, 0.9, 0, true);
        return;
      case 'warehouse':
        void this.controls.setLookAt(11, 13, 28, 11, 2, 8, true);
        return;
      case 'aisle':
        void this.controls.setLookAt(11.5, 4.5, 17, 8, 2.4, 7, true);
        return;
      case 'outfeed':
        void this.controls.setLookAt(19, 5, 12, 15, 0.9, 0, true);
        return;
      case 'external':
        void this.controls.setLookAt(26, 8, 9, 20.6, 0.9, 4, true);
        return;
    }
  }

  dispose(): void {
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.pick);
    this.controls.dispose();
    this.removeSelectionHelper();
    for (const object of this.entityMeshes.values()) disposeObject(object);
    this.cargoPool.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private buildEnvironment(scene: TwinScene): void {
    this.scene.background = new THREE.Color('#F5F2EB');
    const grid = new THREE.GridHelper(64, 64, '#D8D0C2', '#E8E4DC');
    this.scene.add(grid);
    this.scene.add(new THREE.HemisphereLight('#FFF4E6', '#E8E4DC', 1.7));
    const key = new THREE.DirectionalLight('#FFF4E6', 2.4);
    key.position.set(14, 20, 16);
    key.castShadow = true;
    key.shadow.camera.left = -30;
    key.shadow.camera.right = 30;
    key.shadow.camera.top = 30;
    key.shadow.camera.bottom = -30;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#ffffff', 0.6);
    fill.position.set(-12, 8, -10);
    this.scene.add(fill);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 64),
      new THREE.MeshStandardMaterial({ color: '#EFEAE0', roughness: 0.96 }),
    );
    floor.rotateX(-Math.PI / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    for (const entity of scene.entities) this.addEntity(entity);
  }

  /** 切主题后重建：卸掉设备网格 + 清空货池，再按新主题重新生成。 */
  private rebuildEntities(): void {
    for (const object of this.entityMeshes.values()) {
      this.scene.remove(object);
      disposeObject(object);
    }
    this.entityMeshes.clear();
    this.entitySizes.clear();
    this.cargoPool.clear();
    this.removeSelectionHelper();
    this.selectedId = undefined;
    for (const entity of this.worldScene.entities) this.addEntity(entity);
  }

  /** 按实体声明生成模型并挂进场景；物料走 CargoPool，其余造型在 entityMeshes.ts 组合。 */
  private addEntity(entity: EntityMeshInput): THREE.Object3D | undefined {
    if (isCargoKind(entity.kind)) {
      const size = entity.visual?.size ?? DEFAULT_SIZE;
      this.entitySizes.set(entity.id, size);
      this.cargoPool.alloc(entity.id, entity.transform.position, size, this.cargoColor(entity.id));
      return undefined;
    }
    const object = buildEntityMesh(entity);
    object.position.set(...entity.transform.position);
    // 叠加而不是覆盖：输送段可能已经在模型工厂里转过 90°（沿 Z 铺设）。
    object.rotation.y += entity.transform.rotation?.[1] ?? 0;
    object.userData.entityId = entity.id;
    // 记下原始自发光，取消选中时才能还原（光幕/状态灯原本就发光）。
    for (const material of collectMaterials(object)) {
      material.userData.baseEmissive = material.emissive.getHex();
      material.userData.baseEmissiveIntensity = material.emissiveIntensity;
    }
    this.entityMeshes.set(entity.id, object);
    this.scene.add(object);
    return object;
  }

  /** 外部数据源可能带来场景里没有的实体，运行时补一个货箱，别让它消失。 */
  private ensureMesh(id: string): THREE.Object3D | undefined {
    if (this.entityMeshes.has(id)) return this.entityMeshes.get(id);
    if (this.cargoPool.has(id)) return undefined;
    // 未知 id：历史上兜底成 parcel，这里同样塞进实例化池（不建 Group）。
    this.entitySizes.set(id, DEFAULT_SIZE);
    this.cargoPool.alloc(id, [0, 1, 0], DEFAULT_SIZE, this.cargoColor(id));
    return undefined;
  }

  private cargoColor(id: string): THREE.Color {
    return new THREE.Color(cargoColorFor(getActiveTheme(), id));
  }

  /** 渲染层只消费帧差量：内核算什么这里就画什么，绝不自己推演状态。 */
  private applyFrame(delta: FrameDelta): void {
    for (const id of delta.added) this.ensureMesh(id);

    for (const change of delta.changed) {
      const id = change.id;
      // 物料：走实例化池，按位姿 + 背压染色。
      if (this.cargoPool.has(id)) {
        const position = change.transform?.position;
        if (!position) continue;
        const size = this.entitySizes.get(id) ?? DEFAULT_SIZE;
        const stuck = change.attrs?.stuck === true || change.attrs?.backpressure === true;
        this.cargoPool.write(id, position, change.transform?.rotation?.[1] ?? 0, size, this.cargoColor(id), stuck);
        continue;
      }
      const mesh = this.entityMeshes.get(id);
      if (!mesh) continue;
      if (change.transform) {
        mesh.position.set(...change.transform.position);
        mesh.rotation.y = change.transform.rotation?.[1] ?? 0;
      }
      // 内核发来的状态 / 属性驱动模型动画（状态灯、缓存货位……）。
      this.applyState(mesh, change.status, change.attrs);
    }

    for (const id of delta.removed) {
      if (this.cargoPool.has(id)) {
        this.cargoPool.free(id);
        if (this.selectedId === id) this.removeSelectionHelper();
        continue;
      }
      const mesh = this.entityMeshes.get(id);
      if (!mesh) continue;
      this.scene.remove(mesh);
      disposeObject(mesh);
      this.entityMeshes.delete(id);
      if (this.selectedId === id) this.removeSelectionHelper();
    }
  }

  /** 把内核 status / attrs 落到具体模型的动画句柄上。 */
  private applyState(mesh: THREE.Object3D, status: string | undefined, attrs: Record<string, unknown> | undefined): void {
    const anim = mesh.userData.anim as EntityAnim | undefined;
    if (!anim) return;
    const theme = getActiveTheme();
    // 状态灯：idle↔active 变色（busy/passed/error 等都算 active）。
    if (anim.statusLight) {
      const active = status !== undefined && status !== 'idle';
      const color = active ? theme.lightActive : theme.lightIdle;
      anim.statusLight.color.set(color);
      anim.statusLight.emissive.set(color);
    }
    // 缓存货架：按 attrs.fill（0..1）点亮前 N 个货位。
    if (anim.bufferSlots && attrs) {
      const fill = Number(attrs.fill ?? 0);
      const lit = Math.round(Math.min(Math.max(fill, 0), 1) * anim.bufferSlots.length);
      anim.bufferSlots.forEach((slot, index) => {
        slot.visible = index < lit;
      });
    }
  }

  /** 每渲染帧推进皮带箭头流动 + 滚筒自转（播放时）；状态由帧差量驱动，这里只做连续动效。 */
  private animateBeltAndRollers(realDelta: number): void {
    const playing = this.controller.playing;
    if (playing) this.beltTime += realDelta;
    const spin = playing ? ROLLER_SPIN * realDelta : 0;
    for (const object of this.entityMeshes.values()) {
      const anim = object.userData.anim as EntityAnim | undefined;
      if (!anim) continue;
      if (anim.belt) anim.belt.uniforms.time.value = this.beltTime;
      if (anim.rollers && spin !== 0) {
        for (const roller of anim.rollers) roller.rotation.y += spin;
      }
    }
  }

  private removeSelectionHelper(): void {
    if (!this.selectionHelper) return;
    this.scene.remove(this.selectionHelper);
    this.selectionHelper.geometry.dispose();
    (this.selectionHelper.material as THREE.Material).dispose();
    this.selectionHelper = undefined;
  }

  private readonly pick = (event: PointerEvent): void => {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    // 设备网格 + 实例化货池一起拾取。
    const selectable = [
      ...[...this.entityMeshes.values()],
      this.cargoPool.mesh,
    ];
    const hit = this.raycaster.intersectObjects(selectable, true)[0];
    if (!hit) return;
    let id: string | undefined;
    if (hit.object === this.cargoPool.mesh && hit.instanceId !== undefined) {
      id = this.cargoPool.entityIdAt(hit.instanceId);
    } else {
      id = this.entityIdOf(hit.object);
    }
    if (id) this.selectEntity(id);
  };

  /** 沿父链找最近的 entityId（组合模型挂在 Group 上）。 */
  private entityIdOf(object: THREE.Object3D | undefined): string | undefined {
    let current: THREE.Object3D | null = object ?? null;
    while (current) {
      const id = current.userData?.entityId;
      if (typeof id === 'string') return id;
      current = current.parent;
    }
    return undefined;
  }

  private resize(): void {
    const { width, height } = this.host.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private renderFrame = (): void => {
    this.frameId = requestAnimationFrame(this.renderFrame);
    const delta = this.clock.getDelta();
    this.applyFrame(this.controller.advance(delta));
    this.animateBeltAndRollers(delta);
    if (this.selectionHelper && 'update' in this.selectionHelper && typeof (this.selectionHelper as { update?: unknown }).update === 'function') {
      (this.selectionHelper as unknown as { update: () => void }).update();
    }
    this.controls.update(delta);
    this.renderer.render(this.scene, this.camera);
  };
}
