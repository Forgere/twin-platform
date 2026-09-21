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
import { describeEntityState } from './entityState';
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
/** 顶升链带链轮角速度（rad/s）。 */
const CHAIN_SPIN = 7.0;
/** 顶升链带线速度（m/s），链齿按它循环平移。 */
const CHAIN_RUN = 0.6;

/** 物料类实体：走实例化池，不走逐实体 Group。 */
function isCargoKind(kind: string): boolean {
  return kind === 'parcel' || kind === 'pallet';
}

export class TwinSceneController {
  /**
   * 场景里**声明过**的全部实体，含在制物料、堆垛机与货叉。
   *
   * 之前这里把 `parcel` 过滤掉了，结果物料既不在列表里、点击也解析不出视图，
   * 看上去就是"货物点不中"。现在拾取与选中解析都基于这张全量表，
   * 侧边栏要按类别显示由 UI 层自己筛。
   *
   * 注意：**运行时生成的实体**（发生器产的小货物、打包出的托盘）不在这张表里，
   * 它们只能从世界状态里查——用 `listEntities()` 拿"声明 + 运行时"的合并视图。
   */
  readonly entities: TwinEntityView[];

  private readonly controller: ReplayController;
  private readonly worldScene: TwinScene;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  private readonly timer = new THREE.Timer();
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
    // PCFShadowMap：相比默认 BasicShadowMap（硬边、移动物体边缘严重闪烁）抗锯齿更好；
    // 旧版用的 PCFSoftShadowMap 在本版本 three 已废弃（强制回落 PCFShadowMap），故直接用 PCF。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
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

  /**
   * 可选实体：场景声明的 + 运行时生成出来的。
   *
   * 生产线里"小货物发生器持续产出"意味着实体集合每时每刻都在变，
   * 场景声明表是静态的，所以这里按需合并一次——列表、拾取、选中解析共用它。
   */
  listEntities(): TwinEntityView[] {
    const seen = new Set<string>();
    const out: TwinEntityView[] = [];
    for (const entity of this.entities) {
      seen.add(entity.id);
      out.push(entity);
    }
    for (const state of this.controller.world.listEntities()) {
      if (seen.has(state.id)) continue;
      out.push({
        id: state.id,
        kind: state.kind,
        label: entityLabel(state.config?.label, state.id),
      });
    }
    return out;
  }

  /**
   * 选中实体的**实时状态**（只读世界状态，不在渲染层推演）。
   *
   * 托盘货位 / 货架占用 / 堆垛机任务都写在实体 attrs 里，翻译成人话的那部分
   * 放在 `entityState.ts`（纯函数、可单测）；这里只负责把世界状态取出来。
   */
  describeEntity(id: string): string[] {
    const state = this.controller.world.getEntity(id);
    if (!state) return [];
    return describeEntityState(state);
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
        // 实例矩阵 = 单位立方体按 size 缩放 + 绕 Y 旋转 + 平移；Box3Helper 只能画轴对齐线框，
        // 故从矩阵取中心点、用声明尺寸建轴对齐盒（旋转时略宽松，但足够做选中高亮）。
        // 注意：Box3 没有 setFromMatrix4（那是 Matrix3 的方法），旧写法运行时直接崩。
        const size = this.entitySizes.get(id) ?? DEFAULT_SIZE;
        const center = new THREE.Vector3().setFromMatrixPosition(matrix);
        const box = new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(size[0], size[1], size[2]));
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
    // 运行时生成的实体不在场景声明表里，退回世界状态里查一次。
    const known = this.entities.find((entity) => entity.id === id);
    if (known) {
      this.onSelect(known);
      return;
    }
    const state = this.controller.world.getEntity(id);
    this.onSelect(state ? { id: state.id, kind: state.kind, label: entityLabel(state.config?.label, state.id) } : undefined);
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
    this.addCoordinateAxes();
    this.scene.add(new THREE.HemisphereLight('#FFF4E6', '#E8E4DC', 1.7));
    const key = new THREE.DirectionalLight('#FFF4E6', 2.4);
    key.position.set(14, 20, 16);
    key.castShadow = true;
    // 阴影质量：mapSize 默认仅 512² → 放大到 2048 让边缘更细腻（单方向光一次深度 pass，开销可控）。
    key.shadow.mapSize.set(2048, 2048);
    // 正交阴影相机裁剪范围收紧：场景跨度 ~60，远裁剪从 500 收到 80，近裁剪从 0.5 提到 1，
    // 深度精度大幅提高，避免移动物体上的 shadow acne 闪烁。
    key.shadow.camera.left = -32;
    key.shadow.camera.right = 32;
    key.shadow.camera.top = 32;
    key.shadow.camera.bottom = -32;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 80;
    key.shadow.camera.updateProjectionMatrix();
    // normalBias：沿法线方向把阴影采样点推出表面，是消除移动箱子/薄几何自阴影闪烁的关键，
    // 比单纯 bias 更稳，不会造成阴影"悬空"（peter-panning）。
    key.shadow.normalBias = 0.03;
    key.shadow.bias = -0.0001;
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

  /**
   * 加一个世界坐标系（X 红 / Y 绿 / Z 蓝 + 文字标注），放在场景左下角空白处，
   * 方便肉眼核对朝向——尤其确认外部车道/移栽机的 +X（东）、+Z（北）方向对不对。
   * 不进 entityMeshes / cargoPool，所以不会被拾取/选中逻辑干扰。
   */
  private addCoordinateAxes(): void {
    const origin = new THREE.Vector3(-17, 0, -7); // 主环线西南角外侧的空地
    const len = 6;
    const axes = new THREE.AxesHelper(len);
    axes.position.copy(origin);
    axes.renderOrder = 999; // 压在其它几何之上，避免被皮带/货架挡住
    if (Array.isArray(axes.material)) {
      for (const m of axes.material) {
        m.depthTest = false;
        m.transparent = true;
      }
    } else {
      axes.material.depthTest = false;
      axes.material.transparent = true;
    }
    this.scene.add(axes);

    const makeLabel = (text: string, color: string, offset: THREE.Vector3): void => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = color;
      ctx.font = 'bold 88px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 64);
      const tex = new THREE.CanvasTexture(canvas);
      tex.anisotropy = 4;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sprite.position.copy(origin).add(offset);
      sprite.scale.set(1.6, 1.6, 1.6);
      sprite.renderOrder = 1000;
      this.scene.add(sprite);
    };
    // 颜色与 AxesHelper 默认一致：X=红、Y=绿、Z=蓝。
    makeLabel('X', '#E5484D', new THREE.Vector3(len + 0.8, 0, 0));
    makeLabel('Y', '#46A758', new THREE.Vector3(0, len + 0.8, 0));
    makeLabel('Z', '#3E63DD', new THREE.Vector3(0, 0, len + 0.8));
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
    // 记下初始高度：托举座靠"相对它的偏移"判断自己有没有被顶起来。
    object.userData.baseY = entity.transform.position[1] ?? 0;
    // 记下原始自发光，取消选中时才能还原（光幕/状态灯原本就发光）。
    for (const material of collectMaterials(object)) {
      material.userData.baseEmissive = material.emissive.getHex();
      material.userData.baseEmissiveIntensity = material.emissiveIntensity;
    }
    this.entityMeshes.set(entity.id, object);
    this.scene.add(object);
    return object;
  }

  /**
   * 运行时冒出来的实体（外部数据源补的货、发生器产出的小货物、打包出的托盘、
   * 入场的卡车）在这里补模型：能查到世界状态就按**声明**建，
   * 查不到才退回默认方块——否则生成的货物会以错误尺寸/类型出现。
   */
  private ensureMesh(id: string): THREE.Object3D | undefined {
    if (this.entityMeshes.has(id)) return this.entityMeshes.get(id);
    if (this.cargoPool.has(id)) return undefined;

    const state = this.controller.world.getEntity(id);
    const size = state?.visual?.size ?? DEFAULT_SIZE;
    const color = state?.visual?.color ? new THREE.Color(state.visual.color) : this.cargoColor(id);

    if (state && !isCargoKind(state.kind)) {
      // 设备类（卡车、站台…）：按声明组合模型，和场景里的设备走同一条路径。
      const object = buildEntityMesh({
        id: state.id,
        kind: state.kind,
        visual: state.visual,
        transform: { position: [...state.transform.position], rotation: state.transform.rotation ? [...state.transform.rotation] : undefined },
        capabilities: state.capabilities,
        config: state.config,
      });
      object.position.set(...state.transform.position);
      object.rotation.y += state.transform.rotation?.[1] ?? 0;
      object.userData.entityId = state.id;
      object.userData.baseY = state.transform.position[1] ?? 0;
      for (const material of collectMaterials(object)) {
        material.userData.baseEmissive = material.emissive.getHex();
        material.userData.baseEmissiveIntensity = material.emissiveIntensity;
      }
      this.entityMeshes.set(state.id, object);
      this.scene.add(object);
      return object;
    }

    this.entitySizes.set(id, size);
    this.cargoPool.alloc(id, state?.transform.position ?? [0, 1, 0], size, color);
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

  /** 每渲染帧推进皮带箭头流动（播放时）；状态由帧差量驱动，这里只做连续动效。 */
  private animateBeltAndRollers(realDelta: number): void {
    const playing = this.controller.playing;
    if (playing) this.beltTime += realDelta;
    for (const object of this.entityMeshes.values()) {
      const anim = object.userData.anim as EntityAnim | undefined;
      if (!anim) continue;
      if (anim.belt) anim.belt.uniforms.time.value = this.beltTime;
      // 滚筒不再自转：输送线滚筒属装饰件，转动既无物理含义又增加每帧矩阵写入，
      // 静态可见即可（保留用户能看见"是一排滚筒"的语义）。
      // 顶升链带：只有真的被顶起来才转。顶升量 = 托举座相对初始高度的偏移，
      // 这样链带动效完全跟着内核走，不额外读 attrs，也不怕时序错位。
      if (anim.sprockets || anim.chainTeeth) {
        const baseY = typeof object.userData.baseY === 'number' ? (object.userData.baseY as number) : object.position.y;
        if (playing && object.position.y - baseY > 0.004) {
          const sign = anim.divertSign ?? -1;
          if (anim.sprockets) {
            // 链轮用 order='ZYX' + Rz(−π/2) 立起来，rotation.y 增大 → 盘面顶点往 +Z 走，
            // 与链齿的 `+sign` 同向（见 entityMeshes 里 buildCassette 的推导）。
            for (const sprocket of anim.sprockets) sprocket.rotation.y += sign * CHAIN_SPIN * realDelta;
          }
          if (anim.chainTeeth) {
            const travel = CHAIN_RUN * realDelta;
            for (const tooth of anim.chainTeeth) {
              tooth.mesh.position.z += sign * travel;
              if (tooth.mesh.position.z > tooth.halfSpan) tooth.mesh.position.z -= tooth.halfSpan * 2;
              else if (tooth.mesh.position.z < -tooth.halfSpan) tooth.mesh.position.z += tooth.halfSpan * 2;
            }
          }
        }
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
    // three r185 起 Clock 废弃，改用 Timer：每帧先 update() 再 getDelta()（单位同为秒）。
    this.timer.update();
    const delta = this.timer.getDelta();
    this.applyFrame(this.controller.advance(delta));
    this.animateBeltAndRollers(delta);
    if (this.selectionHelper && 'update' in this.selectionHelper && typeof (this.selectionHelper as { update?: unknown }).update === 'function') {
      (this.selectionHelper as unknown as { update: () => void }).update();
    }
    this.controls.update(delta);
    this.renderer.render(this.scene, this.camera);
  };
}
