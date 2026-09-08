import CameraControls from 'camera-controls';
import type { ReplayController } from '@twin-platform/replay-core';
import type { TwinScene, TwinVector3 } from '@twin-platform/world-kernel';
import * as THREE from 'three';
import { entityLabel } from './demoScene';
import { buildEntityMesh, collectMaterials, disposeObject, type EntityMeshInput } from './entityMeshes';

CameraControls.install({ THREE });

export type CameraPreset =
  | 'overview'
  | 'infeed'
  | 'inspection'
  | 'sorter'
  | 'packaging'
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

export class TwinSceneController {
  /** 侧边栏列出的可选实体（物料这类动态实体不进列表）。 */
  readonly entities: TwinEntityView[];

  private readonly controller: ReplayController;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly entityMeshes = new Map<string, THREE.Object3D>();
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
    this.entities = options.scene.entities
      .filter((entity) => entity.kind !== 'parcel')
      .map((entity) => ({ id: entity.id, kind: entity.kind, label: entityLabel(entity.config?.label, entity.id) }));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor('#F5F2EB');
    this.renderer.shadowMap.enabled = true;
    this.host.append(this.renderer.domElement);
    this.camera.position.set(16, 12, 22);
    this.controls = new CameraControls(this.camera, this.renderer.domElement);
    this.controls.smoothTime = 0.32;
    this.controls.draggingSmoothTime = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 48;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.setTarget(1, 0.5, 0, false);
    this.buildEnvironment(options.scene);
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

  selectEntity(id: string): void {
    // 模型是组合体，高亮要改到每个子材质；取消选中时还原各自的原始自发光
    // （检测光幕与状态灯本身就有自发光，不能被抹成黑色）。
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
        void this.controls.setLookAt(16, 12, 22, 1, 0.5, 0, true);
        return;
      case 'infeed':
        void this.controls.setLookAt(-14, 6, 11, -14, 0.6, 0, true);
        return;
      case 'inspection':
        void this.controls.setLookAt(-5, 5, 10, 0, 0.9, 0, true);
        return;
      case 'sorter':
        void this.controls.setLookAt(1.5, 5, 9, 1.5, 0.6, 0, true);
        return;
      case 'packaging':
        void this.controls.setLookAt(12, 5, 9, 12, 1, 0, true);
        return;
      case 'outfeed':
        void this.controls.setLookAt(16, 5, 9, 14, 0.6, 0, true);
        return;
      case 'external':
        void this.controls.setLookAt(24, 9, 0, 16, 0.6, 0, true);
        return;
    }
  }

  dispose(): void {
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.pick);
    this.controls.dispose();
    for (const object of this.entityMeshes.values()) disposeObject(object);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private buildEnvironment(scene: TwinScene): void {
    this.scene.background = new THREE.Color('#F5F2EB');
    const grid = new THREE.GridHelper(40, 40, '#D8D0C2', '#E8E4DC');
    this.scene.add(grid);
    this.scene.add(new THREE.HemisphereLight('#FFF4E6', '#E8E4DC', 1.7));
    const key = new THREE.DirectionalLight('#FFF4E6', 2.4);
    key.position.set(6, 12, 9);
    key.castShadow = true;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#ffffff', 0.6);
    fill.position.set(-8, 6, -6);
    this.scene.add(fill);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({ color: '#EFEAE0', roughness: 0.96 }),
    );
    floor.rotateX(-Math.PI / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    for (const entity of scene.entities) this.addEntity(entity);
  }

  /** 外部数据源可能带来场景里没有的实体，运行时补一个货箱，别让它消失。 */
  private ensureMesh(id: string): THREE.Object3D {
    const existing = this.entityMeshes.get(id);
    if (existing) return existing;
    return this.addEntity({
      id,
      kind: 'parcel',
      visual: { kind: 'box', color: '#C4B5E0', size: DEFAULT_SIZE },
      transform: { position: [0, 1, 0] },
    });
  }

  /** 按实体声明生成模型并挂进场景；造型全部在 `entityMeshes.ts` 里组合。 */
  private addEntity(entity: EntityMeshInput): THREE.Object3D {
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

  /** 渲染层只消费帧差量：内核算什么这里就画什么，绝不自己推演状态。 */
  private applyFrame(delta: ReturnType<ReplayController['advance']>): void {
    for (const id of delta.added) this.ensureMesh(id);
    for (const change of delta.changed) {
      const mesh = change.transform ? (this.entityMeshes.get(change.id) ?? this.ensureMesh(change.id)) : undefined;
      if (!mesh || !change.transform) continue;
      mesh.position.set(...change.transform.position);
      mesh.rotation.y = change.transform.rotation?.[1] ?? 0;
    }
    for (const id of delta.removed) {
      const mesh = this.entityMeshes.get(id);
      if (!mesh) continue;
      this.scene.remove(mesh);
      this.entityMeshes.delete(id);
    }
  }

  private readonly pick = (event: PointerEvent): void => {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const selectable = this.entities
      .map((entity) => this.entityMeshes.get(entity.id))
      .filter((object): object is THREE.Object3D => object !== undefined);
    // 递归拾取：命中的是子网格，要往上找到挂着 entityId 的那一层。
    const hit = this.raycaster.intersectObjects(selectable, true)[0];
    const id = this.entityIdOf(hit?.object);
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
    this.controls.update(delta);
    this.renderer.render(this.scene, this.camera);
  };
}
