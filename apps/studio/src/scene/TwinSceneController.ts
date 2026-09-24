import CameraControls from 'camera-controls';
import { floatSignalPose, SIGNAL_DURATION, type FloatSignalName } from './floatSignal';
import { rigVisualPose, type RigVisualPose } from './rigVisual';
import { calculateRigState, rigPosture } from '@twin-platform/plugins-fishing';
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
  /**
   * 画布内拖拽松手时的回调：把最终位置交出去，由 UI 层拼成 `setTransform` op。
   *
   * 拖拽过程**只动渲染层的网格**（纯预览，不写世界），松手才提交一条 op——
   * 中间每帧写世界会让"取消拖拽"无从回滚，也会让可编辑性判定来回抖。
   *
   * @returns 这条编辑是否被接受；false 时渲染层自己把网格吸附回世界状态。
   */
  onDragCommit?: (entityId: string, position: TwinVector3) => boolean;
}

/** 拖拽阈值（米）：小于它就算一次点击（只选中，不改布局）。 */
const DRAG_THRESHOLD = 0.06;

/** 进行中的拖拽。 */
interface DragState {
  id: string;
  object: THREE.Object3D;
  /** 过实体当前高度的水平面：拖拽只改 XZ，高度保持声明值。 */
  plane: THREE.Plane;
  /** 抓取点相对实体的偏移，免得一开拖物体就跳到光标正下方。 */
  offsetX: number;
  offsetZ: number;
  /** 按下时的原点，用来判断"到底拖没拖"以及 Esc 取消时回滚。 */
  originX: number;
  originZ: number;
  moved: boolean;
}

const DEFAULT_SIZE: TwinVector3 = [0.7, 0.7, 0.7];
/** 选中高亮色（暖橘，和奶油色场景对比足够）。 */
const HIGHLIGHT = '#F4A261';
/** 顶升链带链轮角速度（rad/s）。 */
const CHAIN_SPIN = 7.0;
/** 顶升链带线速度（m/s），链齿按它循环平移。 */
const CHAIN_RUN = 0.6;
/** 钓组线每帧拉伸复用的临时量，避免每帧分配。 */
const FISHING_UP = new THREE.Vector3(0, 1, 0);
const fishingDirection = new THREE.Vector3();
const fishingFrom = new THREE.Vector3();
/** 钓场固定模板：漂相来自 rig-01 的 attrs.signal，一次抛竿（attrs.casts 递增）触发一次动作。 */
const FISHING_RIG_ID = 'rig-01';
const FISHING_FLOAT_ID = 'float-01';
const FISHING_SWIVEL_ID = 'swivel-01';
const FISHING_SINKER_ID = 'sinker-01';
/**
 * 两根并联子线的渲染姿态：仿真里双钩同轴（x = z = 0），直接画会两根线叠成一根、
 * 两只钩朝同一边。这里把上钩摆到 −X、下钩摆到 +X（子线张成 V 字），钩尖各朝外。
 * side = 外侧方向，yaw 让钩尖（模型 −X）朝向 side。被咬的是下钩（台钓里鱼多吃底钩）。
 */
const FISHING_HOOKS = [
  { hookId: 'hook-upper-01', baitId: 'bait-upper-01', side: -1, yaw: 0, bitten: false },
  { hookId: 'hook-lower-01', baitId: 'bait-lower-01', side: 1, yaw: Math.PI, bitten: true },
] as const;
/** 子线张开的水平距离（米，示意比例）。 */
const HOOK_SPLAY = 0.14;
const fishingTo = new THREE.Vector3();
const fishingSegA = new THREE.Vector3();
const fishingSegB = new THREE.Vector3();

/** 钓组零件的挂线点（世界坐标）：实体位置 + 模型声明的本地 `lineAnchor`（随零件旋转）。 */
function lineAnchorOf(object: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  const anchor = object.userData.lineAnchor as readonly [number, number, number] | undefined;
  const pivot = object.userData.lineAnchorPivot as THREE.Object3D | undefined;
  out.set(anchor?.[0] ?? 0, anchor?.[1] ?? 0, anchor?.[2] ?? 0);
  // 挂线点跟着内层枢轴走（浮漂的漂相动作），线才不会和漂脱开。
  if (pivot) out.applyEuler(pivot.rotation).add(pivot.position);
  return out.applyQuaternion(object.quaternion).add(object.position);
}

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
  /** 进行中的拖拽（预览期间只改网格，不写世界）。 */
  private drag: DragState | undefined;
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
    // 捕获阶段挂在**容器**上：camera-controls 的监听器比我们先注册在画布上，
    // 同一个节点上的监听器按注册顺序跑、不吃 capture 标志，直接在画布上抢不过它；
    // 挂到父容器的捕获阶段才能先于画布执行，从而在它看到 pointerdown 之前
    // 把 `controls.enabled` 关掉——否则"拖设备"会同时变成"转相机"。
    this.host.addEventListener('pointerdown', this.pick, true);
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
        this.frameScene();
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

  /**
   * 全景：按场景实体包围盒取景，而不是写死物流中心的坐标。
   *
   * 写死坐标只在"工厂尺度"下成立——台钓钓场只有十几米，写死的机位会把它拍成一个点，
   * 看上去就是"外面什么也看不到"。
   */
  private frameScene(): void {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const object of this.entityMeshes.values()) box.expandByObject(object);
    if (box.isEmpty()) {
      void this.controls.setLookAt(20, 24, 40, 4, 1, 4, true);
      return;
    }
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1);
    const distance = Math.min(Math.max((radius / Math.tan((this.camera.fov * Math.PI) / 360)) * 1.15, 6), 86);
    const eye = center.clone().add(new THREE.Vector3(0.85, 0.7, 1.15).normalize().multiplyScalar(distance));
    void this.controls.setLookAt(eye.x, eye.y, eye.z, center.x, center.y, center.z, true);
  }

  dispose(): void {
    if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
    this.resizeObserver.disconnect();
    this.finishDrag(false); // 拖到一半卸载：先撤监听、把网格放回原处
    this.renderer.domElement.removeEventListener('pointerdown', this.pick);
    this.host.removeEventListener('pointerdown', this.pick, true);
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
    this.addCoordinateAxes(scene);
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
   * 加一个世界坐标系（X 红 / Y 绿 / Z 蓝 + 文字标注），放在场景西南角外侧，
   * 方便肉眼核对朝向——尤其确认外部车道/移栽机的 +X（东）、+Z（北）方向对不对。
   * 原点按**当前场景实体的包围盒**外推：小场景（台钓钓场）里固定坐标会把
   * 红色 X 标签压在水面上，看着像场景出了 bug。
   * 不进 entityMeshes / cargoPool，所以不会被拾取/选中逻辑干扰。
   */
  private addCoordinateAxes(scene: TwinScene): void {
    const len = 6;
    const box = new THREE.Box3();
    for (const entity of scene.entities) {
      const position = entity.transform.position;
      box.expandByPoint(new THREE.Vector3(position[0], position[1] ?? 0, position[2] ?? 0));
    }
    const origin = box.isEmpty()
      ? new THREE.Vector3(-17, 0, -7) // 空场景兜底：沿用老主环线西南角外的位置
      : new THREE.Vector3(box.min.x - len - 2.5, 0, box.min.z - len - 2.5);
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
    const declarationYaw = entity.transform.rotation?.[1] ?? 0;
    object.rotation.y += declarationYaw;
    // 记下"模型工厂自己转过的角度"：之后运行时位姿更新要用 `工厂角度 + 当前朝向`，
    // 直接赋值会把工厂转过的那 90° 抹掉（布局编辑改个位置，皮带头就转正了）。
    object.userData.baseRotationY = object.rotation.y - declarationYaw;
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
      const runtimeYaw = state.transform.rotation?.[1] ?? 0;
      object.rotation.y += runtimeYaw;
      object.userData.baseRotationY = object.rotation.y - runtimeYaw;
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
        mesh.rotation.y = Number(mesh.userData.baseRotationY ?? 0) + (change.transform.rotation?.[1] ?? 0);
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

  /**
   * 每渲染帧的连续动效：皮带箭头、顶升链带、钓组线。
   * 状态本身由帧差量驱动，这里只做"位置已经是最新之后"的连续性补间。
   */
  private animateSubParts(realDelta: number): void {
    const playing = this.controller.playing;
    if (playing) this.beltTime += realDelta;
    this.animateFloatSignal(playing ? realDelta : 0);
    for (const object of this.entityMeshes.values()) {
      const anim = object.userData.anim as EntityAnim | undefined;
      if (!anim) continue;
      if (anim.belt) anim.belt.uniforms.time.value = this.beltTime;
      // 水 / 水草 / 鱼的纯表现动效：跟皮带箭头同一个时钟（暂停即停），不读写世界状态。
      if (anim.ripples) {
        for (const ripple of anim.ripples) {
          const k = (this.beltTime / ripple.period + ripple.phase) % 1;
          const radius = 0.15 + k * ripple.maxRadius;
          ripple.mesh.scale.set(radius, radius, 1);
          (ripple.mesh.material as THREE.MeshStandardMaterial).opacity = 0.55 * (1 - k);
        }
      }
      if (anim.sway) {
        for (const part of anim.sway) {
          part.mesh.rotation[part.axis] = part.base + part.amp * Math.sin(this.beltTime * part.speed + part.phase);
        }
      }
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

      // 台钓钓组的主线 / 子线：两端实体每帧都在动，把单位圆柱拉伸到两端之间。
      // 必须跑在 applyFrame 之后（位置已是本帧最新值），且与是否播放无关——
      // 调漂后即使暂停，线也要立刻跟着新的钩饵位置走。
      if (anim.fishingLines) {
        for (const line of anim.fishingLines) {
          const fromObject = this.entityMeshes.get(line.fromId);
          const toObject = this.entityMeshes.get(line.toId);
          if (!fromObject || !toObject) {
            line.mesh.visible = false;
            continue;
          }
          // 线挂在零件的挂线点（漂座 / 钩眼），不是实体原点。
          const from = lineAnchorOf(fromObject, fishingFrom);
          const to = lineAnchorOf(toObject, fishingTo);
          let ax = from.x;
          let ay = from.y;
          let az = from.z;
          let bx = to.x;
          let by = to.y;
          let bz = to.z;
          // 子线：沿二次贝塞尔曲线分段（segment 决定本 mesh 取哪一截）。弯曲量来自 rigVisualPose
          // （调钓状态 + 这一口），控制点下垂并向外鼓；曲线贴到水底为止，躺底时就是"躺在底上"。
          if (line.segment) {
            const upper = line.bendAttr === 'bendUpper';
            const bend = this.rigPose ? (upper ? this.rigPose.bend.upper : this.rigPose.bend.lower) : 0;
            const side = upper ? -1 : 1;
            const cx = (from.x + to.x) / 2 + side * bend * 0.24;
            const cy = (from.y + to.y) / 2 - bend * 0.5;
            const cz = (from.z + to.z) / 2;
            const floorY = this.rigBottomY + 0.015;
            const point = (k: number, out: THREE.Vector3): THREE.Vector3 => {
              const u = 1 - k;
              out.set(
                u * u * from.x + 2 * u * k * cx + k * k * to.x,
                u * u * from.y + 2 * u * k * cy + k * k * to.y,
                u * u * from.z + 2 * u * k * cz + k * k * to.z,
              );
              out.y = Math.max(out.y, floorY);
              return out;
            };
            const { index, count } = line.segment;
            point(index / count, fishingSegA);
            point((index + 1) / count, fishingSegB);
            ax = fishingSegA.x;
            ay = fishingSegA.y;
            az = fishingSegA.z;
            bx = fishingSegB.x;
            by = fishingSegB.y;
            bz = fishingSegB.z;
          }
          const length = Math.hypot(bx - ax, by - ay, bz - az);
          if (length < 1e-4) {
            line.mesh.visible = false;
            continue;
          }
          line.mesh.visible = true;
          line.mesh.position.set(
            (ax + bx) / 2 - object.position.x,
            (ay + by) / 2 - object.position.y,
            (az + bz) / 2 - object.position.z,
          );
          line.mesh.scale.set(1, length, 1);
          fishingDirection.set(bx - ax, by - ay, bz - az).normalize();
          line.mesh.quaternion.setFromUnitVectors(FISHING_UP, fishingDirection);
        }
      }
    }
  }

  /** 当前这一口的漂相与已播放秒数；casts 变化且有口时重新起播。 */
  private floatBite = { casts: -1, signal: 'none' as FloatSignalName, t: SIGNAL_DURATION };

  /**
   * 浮漂的漂相动作（顿口 / 送漂 / 黑漂 / 走漂）：只摆浮漂模型的内层枢轴，
   * 按渲染时钟播放（暂停即停），不写世界状态。
   */
  private animateFloatSignal(delta: number): void {
    const float = this.entityMeshes.get(FISHING_FLOAT_ID);
    const pivot = float?.userData.lineAnchorPivot as THREE.Object3D | undefined;
    if (!pivot) return;
    const attrs = this.controller.world.getEntity(FISHING_RIG_ID)?.attrs;
    const casts = typeof attrs?.casts === 'number' ? attrs.casts : 0;
    const signal = (typeof attrs?.signal === 'string' ? attrs.signal : 'none') as FloatSignalName;
    const bite = this.floatBite;
    if (casts !== bite.casts) {
      // 首次看到（切场景 / 回放跳转）只对齐计数，不补播已经过去的那一口。
      const fresh = bite.casts >= 0 && casts > bite.casts;
      bite.casts = casts;
      bite.signal = signal;
      bite.t = fresh && signal !== 'none' ? 0 : SIGNAL_DURATION;
    }
    bite.t += delta;
    const pose = floatSignalPose(bite.signal, bite.t);
    pivot.position.set(pose.dx, pose.dy, 0);
    pivot.rotation.z = pose.tilt;
    this.animateRig(bite.signal, bite.t);
  }

  /** 本帧钓组水下姿态（线的弯曲也读它）；非钓场场景为 undefined。 */
  private rigPose: RigVisualPose | undefined;
  private rigBottomY = 0;

  /**
   * 浮漂以下整副钓组的姿态，全部来自 rigVisualPose：
   * - 调钓状态（rigPosture）：灵 / 钝 / 走铅决定钩躺不躺、饵扁不扁、子线弯多少、铅坠倒不倒；
   * - 这一口：主线带着铅坠与 8 字环一起顿 / 托，被咬的下钩连饵被拖走、子线拉直、饵被吸入。
   * 子线张成 V、钩尖各朝外。只写各零件的内层枢轴，线的挂线点跟着枢轴走。
   */
  private animateRig(signal: FloatSignalName, t: number): void {
    const rig = this.controller.world.getEntity(FISHING_RIG_ID);
    const swivelObject = this.entityMeshes.get(FISHING_SWIVEL_ID);
    if (!rig || !swivelObject) {
      this.rigPose = undefined;
      return;
    }
    const attrs = rig.attrs ?? {};
    const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);
    const result = calculateRigState({ t0: num(attrs.t0, 4), t: num(attrs.t, 2), w: num(attrs.w, 1), d: num(attrs.d, 2) });
    if (!result.ok) {
      this.rigPose = undefined;
      return;
    }
    const pose = rigVisualPose(rigPosture(result.state), signal, t);
    this.rigPose = pose;
    const config = rig.config ?? {};
    this.rigBottomY = num(config.surfaceY, 2) - num(config.depth, 2);

    const setPivot = (id: string, apply: (pivot: THREE.Object3D) => void): void => {
      const pivot = this.entityMeshes.get(id)?.userData.lineAnchorPivot as THREE.Object3D | undefined;
      if (pivot) apply(pivot);
    };
    setPivot(FISHING_SINKER_ID, (pivot) => {
      pivot.position.y = pose.mainDy;
      pivot.rotation.z = (pose.sinkerLie * Math.PI) / 2;
    });
    setPivot(FISHING_SWIVEL_ID, (pivot) => {
      pivot.position.y = pose.mainDy;
    });

    const swivelY = swivelObject.position.y + pose.mainDy;
    const swivelX = swivelObject.position.x;
    for (const spec of FISHING_HOOKS) {
      const hook = this.entityMeshes.get(spec.hookId);
      if (!hook) continue;
      const visual = spec.bitten ? pose.hooks.lower : pose.hooks.upper;
      const dx = spec.side * (HOOK_SPLAY + visual.out);
      const dy = visual.dy;
      const dz = visual.shake * Math.sin(t * 38);
      // 钩柄沿子线：本地 +Y 转向"钩→8 字环"。yaw 翻面后本地 X 与世界 X 反向，倾角符号随之翻。
      const toSwivelX = swivelX - (hook.position.x + dx);
      const toSwivelY = Math.max(0.02, swivelY - (hook.position.y + dy));
      const lean = Math.atan2(toSwivelX, toSwivelY);
      const hang = spec.yaw === 0 ? -lean : lean;
      // 躺底：从"顺子线悬垂"过渡到平躺（倒向 8 字环一侧）。
      const flat = (Math.sign(hang) || 1) * (Math.PI / 2) * 0.92;
      const tilt = hang + (flat - hang) * visual.lie;
      const squash = spec.bitten ? pose.baits.lower : pose.baits.upper;
      for (const object of [hook, this.entityMeshes.get(spec.baitId)]) {
        const pivot = object?.userData.lineAnchorPivot as THREE.Object3D | undefined;
        if (!object || !pivot) continue;
        // 饵实体与钩实体同位（仿真同点），偏移相对各自原点即可重合。
        pivot.position.set(dx + hook.position.x - object.position.x, dy + hook.position.y - object.position.y, dz);
        pivot.rotation.set(0, spec.yaw, tilt);
        // 饵：躺底压扁、被吸入变小（只缩饵团本身，不动它在钩尖上的位置）。
        if (object !== hook) pivot.children[0]?.scale.set(1, squash, 1);
      }
      if (spec.bitten) this.placeBiter(hook.position.x + dx, hook.position.y + dy, hook.position.z + dz, spec.side, pose.bite, t);
    }
  }

  /**
   * 咬钩的鱼：嘴含着下钩的饵、身子朝外，随钩一起被拖；强度低时离得远且小（游近 / 游走）。
   * 摆尾沿用 buildFish 自带的 sway，只是这条鱼不是独立实体，由这里代为驱动。
   */
  private placeBiter(x: number, y: number, z: number, side: number, bite: number, t: number): void {
    const rigObject = this.entityMeshes.get(FISHING_RIG_ID);
    const biter = (rigObject?.userData.anim as EntityAnim | undefined)?.biter;
    if (!rigObject || !biter) return;
    biter.visible = bite > 0.02;
    if (!biter.visible) return;
    // 模型嘴在本地 +X（半径 0.12 × 1.35）；转 180° 让嘴朝钩，身子伸向外侧。
    const mouth = 0.16;
    const away = mouth + (1 - bite) * 0.4;
    biter.position.set(x + side * away - rigObject.position.x, y - rigObject.position.y, z - rigObject.position.z);
    biter.rotation.y = side > 0 ? Math.PI : 0;
    biter.scale.setScalar(0.6 + 0.4 * bite);
    const sway = (biter.userData.anim as EntityAnim | undefined)?.sway ?? [];
    for (const part of sway) part.mesh.rotation[part.axis] = part.base + part.amp * 1.6 * Math.sin(t * part.speed * 1.8 + part.phase);
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
    if (id) {
      this.selectEntity(id);
      // 左键按下即进入拖拽待命：可编辑性由内核回答，路径 / 行为接管的实体根本起不来。
      if (event.button === 0) this.beginDrag(id, hit.point);
    }
  };

  // ---------------------------------------------------------------------------
  // 画布内拖拽（阶段 J）：预览只动网格，松手才提交一条 op
  // ---------------------------------------------------------------------------

  private beginDrag(id: string, point: THREE.Vector3): void {
    // 物料走实例化池，不在这张网格表里；即便在，它们的位姿也由路径 / 行为管，
    // 内核的 poseEditability 本来就会拒绝。
    const object = this.entityMeshes.get(id);
    if (!object) return;
    if (!this.controller.world.poseEditability(id).editable) return;

    this.drag = {
      id,
      object,
      plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -object.position.y),
      offsetX: object.position.x - point.x,
      offsetZ: object.position.z - point.z,
      originX: object.position.x,
      originZ: object.position.z,
      moved: false,
    };
    // 相机让位：必须在 camera-controls 看到 pointerdown 之前关掉（我们在捕获阶段）。
    this.controls.enabled = false;
    this.renderer.domElement.style.cursor = 'grabbing';
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragEnd);
    window.addEventListener('pointercancel', this.onDragCancel);
    window.addEventListener('keydown', this.onDragKey);
  }

  private readonly onDragMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    const point = this.raycastToPlane(event, drag.plane);
    if (!point) return; // 视线与拖拽平面平行：保持原样，别把物体甩飞
    const x = point.x + drag.offsetX;
    const z = point.z + drag.offsetZ;
    // 先越过阈值才算真的在拖：否则一次普通点击也会被记成"编辑"。
    if (!drag.moved && Math.hypot(x - drag.originX, z - drag.originZ) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.object.position.set(x, drag.object.position.y, z); // 预览：只改网格
  };

  private readonly onDragEnd = (): void => this.finishDrag(true);
  private readonly onDragCancel = (): void => this.finishDrag(false);
  private readonly onDragKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.finishDrag(false);
  };

  private finishDrag(commit: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    window.removeEventListener('pointercancel', this.onDragCancel);
    window.removeEventListener('keydown', this.onDragKey);
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = '';

    if (!drag.moved) return; // 只是点了一下：位置没动过，也就不产生编辑
    if (!commit) {
      drag.object.position.set(drag.originX, drag.object.position.y, drag.originZ); // Esc / 中断：回滚预览
      return;
    }

    const position: TwinVector3 = [drag.object.position.x, drag.object.position.y, drag.object.position.z];
    const applied = this.onDragCommit?.(drag.id, position) ?? false;
    if (!applied) this.snapToState(drag.id); // op 被拒（不可编辑 / before 对不上）：吸附回世界状态
  }

  private raycastToPlane(event: PointerEvent, plane: THREE.Plane): THREE.Vector3 | undefined {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3()) ?? undefined;
  }

  /** 把网格吸附回世界状态：编辑被拒时靠它消除"看起来改了其实没改"的错觉。 */
  private snapToState(id: string): void {
    const object = this.entityMeshes.get(id);
    const state = this.controller.world.getEntity(id);
    if (!object || !state) return;
    object.position.set(...state.transform.position);
  }

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
    this.animateSubParts(delta);
    if (this.selectionHelper && 'update' in this.selectionHelper && typeof (this.selectionHelper as { update?: unknown }).update === 'function') {
      (this.selectionHelper as unknown as { update: () => void }).update();
    }
    this.controls.update(delta);
    this.renderer.render(this.scene, this.camera);
  };
}
