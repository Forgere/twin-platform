import CameraControls from 'camera-controls';
import type { ScenePresentation, SceneViewContext } from '@twin-platform/studio-sdk';
import { CanvasTap } from './CanvasTap';
import { rawPartId } from './partId';
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
import type { SceneAuditSpot } from './sceneAudit';
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
  /** 画布实际命中部件的原始标识；从列表选实体时没有部件级命中。 */
  partId?: string;
}

export interface TwinSceneControllerOptions {
  scene: TwinScene;
  /** 时间轴控制器：渲染层的推进完全由它决定，视口自己不推演状态。 */
  controller: ReplayController;
  /** 可选的领域展示模块；实例生命周期跟随当前三维控制器。 */
  presentation?: (context: SceneViewContext) => ScenePresentation;
  /**
   * 画布内拖拽松手时的回调：把最终位置交出去，由 UI 层拼成 `setTransform` op。
   *
   * 拖拽过程**只动渲染层的网格**（纯预览，不写世界），松手才提交一条 op——
   * 中间每帧写世界会让"取消拖拽"无从回滚，也会让可编辑性判定来回抖。
   *
   * @returns 这条编辑是否被接受；false 时渲染层自己把网格吸附回世界状态。
   */
  onDragCommit?: (entityId: string, position: TwinVector3) => boolean;
  /**
   * 渲染节拍的真实测量：约每 500ms 一次，只报实测值。
   *
   * `fps` 是这半秒内真实跑完的帧数除以墙钟时间；`frameMs` 是每帧**渲染自身**
   * 的 CPU 耗时均值（performance.now 夹住帧体，不含 vsync 等待）。
   * 不传就完全不测——不编造帧率，宁可没有读数。
   */
  onStats?: (stats: { fps: number; frameMs: number }) => void;
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
/** 审计违例色：设备描边与货箱脉冲共用，fail ≡ error 一深一浅。 */
const AUDIT_FAIL = new THREE.Color('#B3261E');
const AUDIT_ERROR = new THREE.Color('#D97706');
/** 报警脉冲频率（rad/s）：慢到能读清，快到不会被当成常亮。 */
const AUDIT_PULSE = 4.2;
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
  private readonly presentation: ScenePresentation | undefined;
  /** 物料尺寸：帧差量里不带 size，靠实体声明记住，write 时复用。 */
  private readonly entitySizes = new Map<string, TwinVector3>();
  /** 皮带箭头流动时间（秒），暂停即停——视觉跟随仿真。 */
  private beltTime = 0;
  private selectionHelper: THREE.BoxHelper | THREE.Box3Helper | undefined;
  private selectedId: string | undefined;
  /** 审计点名的违例。含没有实体的：那种只上时间轴标记，不在三维里插旗。 */
  private auditSpots: readonly SceneAuditSpot[] = [];
  /** 每个被点名实体一面旗：旋转齿环 + 光柱，位置每帧跟实体走。 */
  private readonly auditMarkers = new Map<string, THREE.Group>();
  /** 正在描边脉冲的设备网格 id。 */
  private readonly flaggedMeshes = new Set<string>();
  /** 脉冲相位（秒）：只看已过去的时间，报警不依赖仿真在不在跑。 */
  private pulseClock = 0;
  /** 进行中的拖拽（预览期间只改网格，不写世界）。 */
  private drag: DragState | undefined;
  /** 进行中的轻点：按下的那根指针与按下位置；抬起时没怎么动才算点选。 */
  private readonly tap = new CanvasTap();
  /** 编辑态才有：拖拽松手时的提交通道（只看不改的孪生视图不传）。 */
  private readonly onDragCommit: TwinSceneControllerOptions['onDragCommit'];
  private readonly resizeObserver: ResizeObserver;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: CameraControls;
  private frameId: number | undefined;
  /** 渲染节拍的真实测量（只在传了 onStats 时累计）。 */
  private readonly onStats: TwinSceneControllerOptions['onStats'];
  private statsFrames = 0;
  private statsCostMs = 0;
  private statsElapsed = 0;
  /** 视口底色：跟界面主题走，默认暗色（与 CSS 的 --bg 同值）。 */
  private backdrop = '#0D0F12';
  /** 最近一次上报的实测值（HUD 每拍读它）。 */
  private lastStats = { fps: 0, frameMs: 0 };

  constructor(
    private readonly host: HTMLElement,
    private readonly onSelect: (entity: TwinEntityView | undefined) => void,
    options: TwinSceneControllerOptions,
  ) {
    this.controller = options.controller;
    this.worldScene = options.scene;
    this.onDragCommit = options.onDragCommit;
    this.onStats = options.onStats;
    this.entities = options.scene.entities.map((entity) => ({
      id: entity.id,
      kind: entity.kind,
      label: entityLabel(entity.config?.label, entity.id),
    }));

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(this.backdrop);
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
    this.presentation = options.presentation?.({ world: this.controller.world, scene: this.scene, meshes: this.entityMeshes });

    this.buildEnvironment(this.worldScene);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    // 点选 = 轻点：画布上按下记位置，抬起（在哪抬起都算，所以挂 window）时没怎么动才拾取。
    this.renderer.domElement.addEventListener('pointerdown', this.onTapStart);
    window.addEventListener('pointermove', this.onTapMove);
    window.addEventListener('pointerup', this.onTapEnd);
    window.addEventListener('pointercancel', this.onTapCancel);
    // 编辑态的抓取在捕获阶段挂在**容器**上：camera-controls 的监听器比我们先注册在画布上，
    // 同一个节点上的监听器按注册顺序跑、不吃 capture 标志，直接在画布上抢不过它；
    // 挂到父容器的捕获阶段才能先于画布执行，从而在它看到 pointerdown 之前
    // 把 `controls.enabled` 关掉——否则"拖设备"会同时变成"转相机"。
    this.host.addEventListener('pointerdown', this.grab, true);
    this.resize();
    if (this.presentation?.overview) this.frameScene(false);
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

  /** 最近一次测量的渲染节拍；没传 `onStats` 时一直是 0（HUD 据此隐藏读数）。 */
  get stats(): { fps: number; frameMs: number } {
    return this.lastStats;
  }

  /**
   * 换视口底色（跟随界面主题）。画布与面板必须同色：暗色 UI 里嵌一块米黄，
   * 看上去像视口没加载完。
   *
   * 只换背景，**不动**地面、网格与灯光：它们是场景的美术方向（奶油色台面 +
   * 暖白主光），设备涂装与阴影都按它调过；换背景已足够让视口和界面融合。
   */
  setBackdrop(color: string): void {
    this.backdrop = color;
    this.renderer.setClearColor(color);
    this.scene.background = new THREE.Color(color);
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

  selectEntity(id: string, partId?: string): void {
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
      this.onSelect({ ...known, partId });
      return;
    }
    const state = this.controller.world.getEntity(id);
    this.onSelect(state ? { id: state.id, kind: state.kind, label: entityLabel(state.config?.label, state.id), partId } : undefined);
  }

  /**
   * 画面上真正插了旗的实体 id。
   *
   * 这是**渲染层自己的账**：给面板与测试对一对“看到几面旗”。
   * 判定不在这里，也不在这里重算定位。
   */
  get auditedEntities(): readonly string[] {
    return [...this.auditMarkers.keys()];
  }

  /**
   * 把审计结论画到场景里：违例实体描边脉冲 + 头上插一面报警旗。
   *
   * 三条不肯让步的规矩：
   * 1. **定位不出来就不插旗**。where 对不上实体 id 的违例（例如缺 goods:packed 这一环）
   *    只在面板里说清，画面上不插旗——硬塞一个位置就是骗人；
   * 2. **旗跟着实体走**。每帧从当前网格或实例矩阵取锚点，实体不在了就把旗收起来，
   *    不留在原地假装它还在；
   * 3. **退出名单必须还原**。红漆交给 emissive 混色，摘标记时把 emissive
   *    交还给模型默认值与选中态，不留一层洗不掉的红。
   */
  setAuditSpots(spots: readonly SceneAuditSpot[]): void {
    this.auditSpots = spots;
    const next = new Set<string>();
    for (const spot of spots) if (spot.entityId) next.add(spot.entityId);

    // 先还原旧的，再上新标记：顺序反了会漏一层红漆。
    for (const id of [...this.flaggedMeshes]) {
      if (next.has(id)) continue;
      this.flaggedMeshes.delete(id);
      this.restoreEmissive(id);
    }
    for (const [id, marker] of [...this.auditMarkers]) {
      if (next.has(id)) continue;
      this.disposeMarker(id, marker);
    }
    for (const id of next) {
      if (this.auditMarkers.has(id)) continue;
      const severity = spots.find((spot) => spot.entityId === id)?.severity ?? 'fail';
      this.auditMarkers.set(id, this.buildMarker(severity));
    }
    for (const id of next) {
      if (this.entityMeshes.has(id)) this.flaggedMeshes.add(id);
    }
    this.cargoPool.setFlagged([...next]);
  }

  /**
   * 相机飞到某个实体。
   *
   * 设备走实体网格，物料走实例池（小货物/托盘不建 mesh，只占一个实例矩阵）——
   * 两种都得能取景，否则审计定位到一只物料时相机会默默不动。
   */
  focusEntity(id: string): void {
    const mesh = this.entityMeshes.get(id);
    const target = mesh
      ? mesh.getWorldPosition(new THREE.Vector3())
      : (() => {
          const matrix = this.cargoPool.matrixOf(id);
          return matrix ? new THREE.Vector3().setFromMatrixPosition(matrix) : undefined;
        })();
    if (!target) return;
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

  /** 优先使用插件取景，否则按当前实体包围盒取景。 */
  private frameScene(animate = true): void {
    const view = this.presentation?.overview?.();
    if (view) {
      void this.controls.setLookAt(...view.eye, ...view.target, animate);
      return;
    }
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
    this.renderer.domElement.removeEventListener('pointerdown', this.onTapStart);
    window.removeEventListener('pointermove', this.onTapMove);
    window.removeEventListener('pointerup', this.onTapEnd);
    window.removeEventListener('pointercancel', this.onTapCancel);
    this.host.removeEventListener('pointerdown', this.grab, true);
    this.controls.dispose();
    this.removeSelectionHelper();
    this.presentation?.dispose();
    for (const object of this.entityMeshes.values()) disposeObject(object);
    for (const marker of this.auditMarkers.values()) disposeObject(marker);
    this.auditMarkers.clear();
    this.flaggedMeshes.clear();
    this.cargoPool.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private buildEnvironment(scene: TwinScene): void {
    this.scene.background = new THREE.Color(this.backdrop);
    if (this.presentation?.showHelpers !== false) {
      const grid = new THREE.GridHelper(64, 64, '#D8D0C2', '#E8E4DC');
      this.scene.add(grid);
      this.addCoordinateAxes(scene);
    }
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
   * 原点按**当前场景实体的包围盒**外推，避免坐标标注覆盖小场景。
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
    this.presentation?.reset?.();
    for (const object of this.entityMeshes.values()) {
      this.scene.remove(object);
      disposeObject(object);
    }
    this.entityMeshes.clear();
    this.entitySizes.clear();
    this.cargoPool.clear();
    this.removeSelectionHelper();
    this.selectedId = undefined;
    for (const entity of this.controller.world.listEntities()) this.addEntity(entity);
  }

  /** 按实体声明生成模型并挂进场景；物料走 CargoPool，其余造型在 entityMeshes.ts 组合。 */
  private addEntity(entity: EntityMeshInput): THREE.Object3D | undefined {
    if (isCargoKind(entity.kind)) {
      const size = entity.visual?.size ?? DEFAULT_SIZE;
      this.entitySizes.set(entity.id, size);
      this.cargoPool.alloc(entity.id, entity.transform.position, size, this.cargoColor(entity.id));
      return undefined;
    }
    const object = this.presentation?.buildEntity(entity) ?? buildEntityMesh(entity);
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
    const state = this.controller.world.getEntity(entity.id);
    if (state) this.applyState(object, state.status, state.attrs);
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

    if (state && !isCargoKind(state.kind)) return this.addEntity(state);

    this.entitySizes.set(id, size);
    this.cargoPool.alloc(id, state?.transform.position ?? [0, 1, 0], size, color);
    return undefined;
  }

  private cargoColor(id: string): THREE.Color {
    return new THREE.Color(cargoColorFor(getActiveTheme(), id));
  }

  /**
   * 权威对齐：让渲染层（Mesh + InstancedMesh CargoPool）与世界真实实体绝对一致。
   *
   * 为什么要这个兜底：
   * 1. 当 seek(0) 命中无快照分支走 `world.reset()` 时，内核把动态生成的物料
   *    直接从 Map 删掉，未生成 delta.removed 差量。
   * 2. 如果仅靠差量，InstancedMesh 里的槽位就不会被 zero-scale，画面上就会留着
   *    已经不存在于世界中的物料。
   * 3. 对齐会把 CargoPool 中多余的实例清掉（设为 scale 0），并补上漏掉的实体。
   */
  syncEntitiesFromWorld(): void {
    const liveEntities = this.controller.world.listEntities();
    const liveIds = new Set(liveEntities.map((e) => e.id));

    // 1. 清理 CargoPool 中在世界里已经不存在的物料
    for (const id of this.cargoPool.entityIds()) {
      if (!liveIds.has(id)) {
        this.cargoPool.free(id);
        if (this.selectedId === id) this.removeSelectionHelper();
      }
    }

    // 2. 清理普通网格中在世界里已经不存在的实体
    for (const [id, object] of this.entityMeshes) {
      if (!liveIds.has(id)) {
        this.scene.remove(object);
        disposeObject(object);
        this.entityMeshes.delete(id);
        if (this.selectedId === id) this.removeSelectionHelper();
      }
    }

    // 3. 补上世界里存在但渲染层漏掉的实体/物料
    for (const entity of liveEntities) {
      if (isCargoKind(entity.kind)) {
        if (!this.cargoPool.has(entity.id)) {
          const size = entity.visual?.size ?? DEFAULT_SIZE;
          this.entitySizes.set(entity.id, size);
          this.cargoPool.alloc(entity.id, entity.transform.position, size, this.cargoColor(entity.id));
        } else {
          // 已经存在，更新其当前位姿与背压状态
          const size = this.entitySizes.get(entity.id) ?? DEFAULT_SIZE;
          const stuck = entity.attrs?.stuck === true || entity.attrs?.backpressure === true;
          this.cargoPool.write(entity.id, entity.transform.position, entity.transform.rotation?.[1] ?? 0, size, this.cargoColor(entity.id), stuck);
        }
      } else {
        if (!this.entityMeshes.has(entity.id)) {
          this.addEntity(entity);
        }
      }
    }
  }

  /**
   * 渲染层只消费帧差量：内核算什么这里就画什么，绝不自己推演状态。
   *
   * 公开给 UI 的原因：`seek()` 是**唯一一个会一次性改变世界**的入口（恢复快照 +
   * 截断 + 重算），它返回的差量（回跳时消失的实体、又回来的实体）如果没人消费，
   * 场景里就会留着上一条时间线的幽灵货物。渲染循环自己的 `advance()` 拿不到它——
   * 差量已经在 `seek()` 里被刷走并清空了。所以定位结束必须显式把这一帧交回来。
   */
  applyFrame(delta: FrameDelta): void {
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
   * 每渲染帧的连续动效：领域展示、皮带箭头与顶升链带。
   * 状态本身由帧差量驱动，这里只做"位置已经是最新之后"的连续性补间。
   */
  private animateSubParts(realDelta: number): void {
    const playing = this.controller.playing;
    if (playing) this.beltTime += realDelta;
    this.presentation?.update();
    for (const object of this.entityMeshes.values()) {
      const anim = object.userData.anim as EntityAnim | undefined;
      if (!anim) continue;
      const time = anim.belt?.uniforms.time;
      if (time) time.value = this.beltTime;
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
    // 审计报警层放在帧末：此时位置已经是世界最新值，插旗才不会慢一拍。
    this.updateAuditVisuals(realDelta);
  }

  // ---------------------------------------------------------------------------
  // 审计在三维里的样子：违例实体描边脉冲 + 头上一面报警旗
  // ---------------------------------------------------------------------------

  /**
   * 造一面旗：地面光圈 + 一道光柱 + 朝下的锥形指针。
   *
   * `depthTest = false`：报警是抬显层，被货架挡住就等于没报警。
   * 位置由 `updateAuditVisuals` 每帧给，这里只管造型。
   */
  private buildMarker(severity: 'fail' | 'error'): THREE.Group {
    const color = severity === 'error' ? AUDIT_ERROR : AUDIT_FAIL;
    const group = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.06, 8, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 1.5, 6, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }),
    );
    beam.position.y = 0.75;
    const tip = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 0.36, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
    );
    tip.rotation.x = Math.PI; // 尖端朝下：指的就是下面那件东西
    tip.position.y = 1.62;
    group.add(ring, beam, tip);
    group.renderOrder = 998;
    group.userData.entityMarker = true;
    this.scene.add(group);
    return group;
  }

  /** 收旗：退出名单、换场景、卸载，都走这一条，不留孤儿对象。 */
  private disposeMarker(id: string, marker: THREE.Group): void {
    this.auditMarkers.delete(id);
    this.scene.remove(marker);
    disposeObject(marker);
  }

  /** 把某个设备的 emissive 交还给模型默认值（或选中态），消除报警描边。 */
  private restoreEmissive(id: string): void {
    const object = this.entityMeshes.get(id);
    if (!object) return;
    const selected = this.selectedId === id;
    for (const material of collectMaterials(object)) {
      material.emissive.setHex(Number(material.userData.baseEmissive ?? 0));
      material.emissiveIntensity = Number(material.userData.baseEmissiveIntensity ?? 0);
      if (selected) {
        material.emissive.set(HIGHLIGHT);
        material.emissiveIntensity = 0.55;
      }
    }
  }

  /**
   * 实体当前的顶锚点：旗就插在它正上方。
   *
   * 设备走包围盒顶，物料走实例矩阵 + 声明尺寸。取不到就返回 undefined——
   * 这一帧这面旗必须收起来，实体已经不在了。
   */
  private topAnchor(id: string): THREE.Vector3 | undefined {
    const mesh = this.entityMeshes.get(id);
    if (mesh) {
      const box = new THREE.Box3().setFromObject(mesh);
      if (box.isEmpty()) return undefined;
      return new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2);
    }
    const matrix = this.cargoPool.matrixOf(id);
    if (!matrix) return undefined;
    const size = this.entitySizes.get(id) ?? DEFAULT_SIZE;
    return new THREE.Vector3().setFromMatrixPosition(matrix).setY(matrix.elements[13] + size[1] / 2);
  }

  /**
   * 每帧的报警表现：相位乘出来的脉冲同时驱动旗的缩放/透明与设备描边。
   *
   * 只遍历被点名的那几个对象，不由场景规模付费。
   */
  private updateAuditVisuals(realDelta: number): void {
    if (this.auditMarkers.size === 0 && this.flaggedMeshes.size === 0) return;
    this.pulseClock += realDelta;
    const k = 0.5 + 0.5 * Math.sin(this.pulseClock * AUDIT_PULSE);
    this.cargoPool.pulseFlagged(k);

    for (const [id, marker] of this.auditMarkers) {
      const anchor = this.topAnchor(id);
      if (!anchor) {
        marker.visible = false; // 实体不在了：收旗，不留在原地冒充它
        continue;
      }
      marker.visible = true;
      marker.position.set(anchor.x, anchor.y + 0.16, anchor.z);
      const spread = 0.92 + 0.18 * k;
      marker.scale.set(spread, 1 + 0.22 * k, spread);
      marker.traverse((child) => {
        const material = (child as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (!material || !('opacity' in material)) return;
        if (material.userData.baseOpacity === undefined) material.userData.baseOpacity = material.opacity;
        const base = Number(material.userData.baseOpacity);
        material.opacity = Math.min(1, Math.max(0.18, base * (0.55 + 0.55 * k)));
      });
    }

    for (const id of this.flaggedMeshes) {
      const object = this.entityMeshes.get(id);
      if (!object) continue;
      // 选中的那一个保留橘色高亮：它已经有选中框了，别让两种状态互相覆盖。
      if (id === this.selectedId) continue;
      const color = this.auditSpots.find((spot) => spot.entityId === id)?.severity === 'error' ? AUDIT_ERROR : AUDIT_FAIL;
      for (const material of collectMaterials(object)) {
        material.emissive.copy(color);
        material.emissiveIntensity = 0.22 + 0.5 * k;
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

  /** 屏幕点 → 命中的实体、原始 partId（设备网格 + 实例化货池一起拾取）与命中点。 */
  private hitTest(event: PointerEvent): { id: string; partId?: string; point: THREE.Vector3 } | undefined {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
    this.pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.entityMeshes.values(), this.cargoPool.mesh], true)[0];
    if (!hit) return undefined;
    const id =
      hit.object === this.cargoPool.mesh && hit.instanceId !== undefined
        ? this.cargoPool.entityIdAt(hit.instanceId)
        : this.entityIdOf(hit.object);
    return id ? { id, partId: rawPartId(hit), point: hit.point } : undefined;
  }

  /**
   * 点选 = 轻点（按下后没怎么动就抬起）。
   *
   * 以前按下就选中：手机上单指转相机、双指缩放，手指多半落在设备上，
   * 转一下选中就跳一次，检视区也被翻到实体页。现在拖过的（转 / 移 / 缩放）一律不算点选。
   */
  private readonly onTapStart = (event: PointerEvent): void => {
    this.tap.down(event);
  };

  private readonly onTapMove = (event: PointerEvent): void => {
    this.tap.move(event);
  };

  private readonly onTapEnd = (event: PointerEvent): void => {
    if (!this.tap.up(event) || this.drag) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    const hit = this.hitTest(event);
    if (hit) this.selectEntity(hit.id, hit.partId);
  };

  private readonly onTapCancel = (event: PointerEvent): void => {
    this.tap.cancel(event);
  };

  /** 编辑态（有提交通道）：左键按下即抓取——选中并进入拖拽待命。 */
  private readonly grab = (event: PointerEvent): void => {
    if (!this.onDragCommit || event.button !== 0) return;
    const hit = this.hitTest(event);
    if (!hit) return;
    this.selectEntity(hit.id, hit.partId);
    // 可编辑性由内核回答，路径 / 行为接管的实体根本起不来。
    this.beginDrag(hit.id, hit.point);
  };

  // ---------------------------------------------------------------------------
  // 画布内拖拽（阶段 J）：预览只动网格，松手才提交一条 op
  // ---------------------------------------------------------------------------

  private beginDrag(id: string, point: THREE.Vector3): void {
    // 物料走实例化池，不在这张网格表里；即便在，它们的位姿也由路径 / 行为管，
    // 内核的 poseEditability 本来就会拒绝。
    // 没有提交通道（只看不改的孪生视图）就不进入拖拽，免得预览动了网格又弹回去。
    if (!this.onDragCommit) return;
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
    const startedAt = performance.now();
    // three r185 起 Clock 废弃，改用 Timer：每帧先 update() 再 getDelta()（单位同为秒）。
    this.timer.update();
    const delta = this.timer.getDelta();
    this.applyFrame(this.controller.advance(delta));
    this.animateSubParts(delta);
    // 两个 helper 只有 BoxHelper 有 update()（Box3Helper 靠 updateMatrixWorld 跟随）。
    // 用 `in` + typeof 收窄，别把联合类型强转成伪造形状再读成员。
    const helper = this.selectionHelper;
    if (helper && 'update' in helper && typeof helper.update === 'function') helper.update();
    this.controls.update(delta);
    this.renderer.render(this.scene, this.camera);
    this.sampleStats(delta, performance.now() - startedAt);
  };

  /**
   * 帧率与帧耗时的真实测量：半秒一个窗口，两个数都来自实测。
   *
   * `fps` = 窗口内跑完的帧数 ÷ 墙钟时间（Timer 的 delta 累计），掉帧会如实反映；
   * `frameMs` = 每帧渲染自身的 CPU 耗时均值（performance.now 夹住帧体，不含等 vsync）。
   *
   * 不传 `onStats` 就完全不测：HUD 宁可不显示，也不摆一个编出来的数字。
   */
  private sampleStats(delta: number, costMs: number): void {
    if (!this.onStats) return;
    this.statsFrames += 1;
    this.statsCostMs += costMs;
    this.statsElapsed += delta;
    if (this.statsElapsed < 0.5) return;
    this.lastStats = {
      fps: Math.round((this.statsFrames / this.statsElapsed) * 10) / 10,
      frameMs: Math.round((this.statsCostMs / this.statsFrames) * 10) / 10,
    };
    this.statsFrames = 0;
    this.statsCostMs = 0;
    this.statsElapsed = 0;
    this.onStats(this.lastStats);
  }
}
