import CameraControls from 'camera-controls';
import type { ReplayController } from '@twin-platform/replay-core';
import type { TwinScene, TwinVector3 } from '@twin-platform/world-kernel';
import * as THREE from 'three';
import { entityLabel } from './demoScene';

CameraControls.install({ THREE });

export type CameraPreset = 'overview' | 'line';

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

const DEFAULT_COLOR = '#94a3b8';
const DEFAULT_SIZE: TwinVector3 = [0.7, 0.7, 0.7];

export class TwinSceneController {
  /** 侧边栏列出的可选实体（物料这类动态实体不进列表）。 */
  readonly entities: TwinEntityView[];

  private readonly controller: ReplayController;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private readonly clock = new THREE.Clock();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly entityMeshes = new Map<string, THREE.Mesh>();
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
    this.renderer.setClearColor('#07111f');
    this.renderer.shadowMap.enabled = true;
    this.host.append(this.renderer.domElement);
    this.camera.position.set(10, 8, 12);
    this.controls = new CameraControls(this.camera, this.renderer.domElement);
    this.controls.smoothTime = 0.32;
    this.controls.draggingSmoothTime = 0.08;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 32;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.setTarget(0, 0.5, 0, false);
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
    for (const [entityId, mesh] of this.entityMeshes) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.emissive.set(entityId === id ? '#e0f2fe' : '#000000');
      material.emissiveIntensity = entityId === id ? 0.45 : 0;
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
    if (preset === 'overview') {
      void this.controls.setLookAt(10, 8, 12, 0, 0.5, 0, true);
      return;
    }
    void this.controls.setLookAt(0, 4.8, 13, 0, 0.7, 0, true);
  }

  dispose(): void {
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.pick);
    this.controls.dispose();
    for (const mesh of this.entityMeshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private buildEnvironment(scene: TwinScene): void {
    this.scene.background = new THREE.Color('#07111f');
    const grid = new THREE.GridHelper(18, 18, '#334155', '#172338');
    this.scene.add(grid);
    this.scene.add(new THREE.HemisphereLight('#c7e5ff', '#0b1324', 2.2));
    const key = new THREE.DirectionalLight('#ffffff', 2.8);
    key.position.set(5, 9, 7);
    key.castShadow = true;
    this.scene.add(key);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(18, 18), new THREE.MeshStandardMaterial({ color: '#0c1a2d', roughness: 0.94 }));
    floor.rotateX(-Math.PI / 2);
    floor.receiveShadow = true;
    this.scene.add(floor);

    for (const entity of scene.entities) this.addMesh(entity.id, entity.visual?.size ?? DEFAULT_SIZE, entity.visual?.color ?? DEFAULT_COLOR, entity.transform);
  }

  /** 外部数据源可能带来场景里没有的实体，运行时补一个盒子，别让它消失。 */
  private ensureMesh(id: string): THREE.Mesh {
    const existing = this.entityMeshes.get(id);
    if (existing) return existing;
    return this.addMesh(id, DEFAULT_SIZE, '#f472b6', { position: [0, 1, 0] });
  }

  private addMesh(
    id: string,
    size: TwinVector3,
    color: string,
    transform: { position: TwinVector3; rotation?: TwinVector3 },
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.44 }),
    );
    mesh.position.set(...transform.position);
    mesh.rotation.y = transform.rotation?.[1] ?? 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = id;
    this.entityMeshes.set(id, mesh);
    this.scene.add(mesh);
    return mesh;
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
      .filter((mesh): mesh is THREE.Mesh => mesh !== undefined);
    const hit = this.raycaster.intersectObjects(selectable, false)[0];
    const id = hit?.object.userData.entityId as string | undefined;
    if (id) this.selectEntity(id);
  };

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
