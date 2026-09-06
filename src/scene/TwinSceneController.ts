import CameraControls from 'camera-controls';
import * as THREE from 'three';

CameraControls.install({ THREE });

export type CameraPreset = 'overview' | 'line';

export interface TwinEntityView {
  id: string;
  label: string;
  kind: string;
}

const ENTITIES: Array<
  TwinEntityView & { color: string; position: [number, number, number] }
> = [
  { id: 'infeed-01', label: '入料输送线', kind: 'transport', color: '#22c55e', position: [-4, 0.6, 0] },
  { id: 'inspection-01', label: '视觉检测站', kind: 'inspect', color: '#38bdf8', position: [0, 0.8, 0] },
  { id: 'buffer-01', label: '缓存货架', kind: 'buffer', color: '#f59e0b', position: [4, 1, 0] },
];

export class TwinSceneController {
  readonly entities = ENTITIES.map(({ id, label, kind }) => ({ id, label, kind }));
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

  constructor(private readonly host: HTMLElement, private readonly onSelect: (entity: TwinEntityView | undefined) => void) {
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
    this.buildScene();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.renderer.domElement.addEventListener('pointerdown', this.pick);
    this.resize();
    this.renderFrame();
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

  private buildScene(): void {
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
    for (const entity of ENTITIES) this.addEntity(entity);
  }

  private addEntity(entity: (typeof ENTITIES)[number]): void {
    const geometry = entity.kind === 'buffer' ? new THREE.BoxGeometry(2.2, 2, 1.8) : new THREE.BoxGeometry(2.7, entity.kind === 'inspect' ? 1.6 : 0.7, 1.6);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: entity.color, metalness: 0.2, roughness: 0.44 }));
    mesh.position.set(...entity.position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.entityId = entity.id;
    this.entityMeshes.set(entity.id, mesh);
    this.scene.add(mesh);
  }

  private readonly pick = (event: PointerEvent): void => {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.entityMeshes.values()], false)[0];
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
    this.controls.update(this.clock.getDelta());
    this.renderer.render(this.scene, this.camera);
  };
}
