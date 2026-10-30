import { CsvFrameSource, type CsvParseIssue } from '@twin-platform/data-source-csv';
import { ReplayController, SessionRecorder } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import type { TwinStorage } from '@twin-platform/storage-contracts';
import { TwinWorld, type PoseEditability, type WorldEvent } from '@twin-platform/world-kernel';
import { lineMetrics, seriesLatest, type LineMetrics } from '@twin-platform/analytics-core';
import { PluginHost, type TwinPlugin } from '@twin-platform/plugin-sdk';
import {
  createAsrsBehavior,
  createBufferFillBehavior,
  createGoodsSourceBehavior,
  createLogisticsBehavior,
  createPackingBehavior,
  createTransferBehavior,
  createTruckBehavior,
} from '@twin-platform/plugins-logistics';
import { DEFAULT_PLUGIN_IDS, resolvePlugins, sceneForPlugins } from '../plugins/catalog';
import { compareScenarios, type ScenarioDiff } from '@twin-platform/scenario-compare';
import { sceneSummary, type SceneOp, type SceneSummary, type TwinScene, type TwinTransform } from '@twin-platform/scene-schema';

/**
 * Studio 的一次运行会话：插件宿主 + 世界 + 仓储 + 录制器 + 时间轴控制器。
 *
 * 阶段 D 之后，场景不再是写死的 `demoScene`，而是由 `logistics` 插件经
 * `PluginHost` 安装后、用它的场景模板生成；世界用插件贡献的行为驱动。
 * 这样"装插件 = 得到场景 + 仿真 + 指标"这条链路在 Studio 里是真实跑通的，
 * 而不是另写一份逻辑。
 *
 * Studio 自己不推演状态、不算指标：指标调用 `analytics-core`，分叉对比调用
 * `scenario-compare`。
 */

export interface CsvLoadResult {
  frames: number;
  duration: number;
  issues: CsvParseIssue[];
  /** CSV 里出现过的实体 id，用来把它们切成"听外部数据"。 */
  entities: string[];
}

/** 一次布局编辑的结果。失败不抛异常——把内核的人话错误带回面板显示。 */
export interface EditOutcome {
  ok: boolean;
  /** 失败原因（人话），UI 直接展示。 */
  error?: string;
  /** 实际应用的 ops（失败为空）。 */
  applied: SceneOp[];
}

/**
 * 运行时生成的物料类型。
 *
 * 它们由行为凭空造出来（发生器产小货物、打包出托盘），场景文件里没有，
 * 也没有能力声明——统计"有没有行为认领"时必须排除，否则会误报成未识别设备。
 */
const CARGO_KINDS = new Set(['parcel', 'pallet']);

export const SAMPLE_CSV = ['t,id,x,y,z', '0,cargo-01,-5.2,1.15,0', '1,cargo-01,-2.4,1.15,0', '2,cargo-01,0.6,1.15,0', '3,cargo-01,3.4,1.15,0', '4,cargo-01,5.2,1.15,0'].join('\n');

/**
 * 默认场景参数：生产工厂闭环产线（小货物 → 打包 → 立库 → 卡车）。
 *
 * 注意：`compare()` 也复用同一组参数，两处必须保持一致，
 * 否则分叉对比跑的不是同一套场景。
 */
export { CENTER_PARAMS } from '../plugins/catalog';

/** 场景从哪来：`template` 是插件模板生成的，`imported` 是外部 JSON 导入的。 */
export type SceneSource = 'template' | 'imported';

/** 默认场景：由默认领域包（物流）提供，作为"导入前"的基准，也是"还原"的目标。 */
export function buildDefaultScene(): TwinScene {
  return sceneForPlugins(DEFAULT_PLUGIN_IDS);
}

/** HUD 用的实时遥测快照（由世界事件日志派生，不在 Studio 里重算语义）。 */
export interface StudioTelemetry {
  time: number;
  /** 当前在制小货物数（发生器产出的、还活着的）。 */
  active: number;
  /** 累计产出（goods:produced）。 */
  spawned: number;
  /** 累计运走（goods:shipped）。 */
  consumed: number;
  /** 累计打包次数（每次吃掉 batch 个小货物、产 1 个托盘）。 */
  packed: number;
  /** 当前系统里的托盘数（队列 + 货架 + 出库带）。 */
  pallets: number;
  /** 卡车状态：在货位等货/装车、驶离、门外、回场。一条巷道一台。 */
  trucks: { id: string; label: string; state: string; load: number }[];
  /** 累计发车趟数。 */
  truckTrips: number;
  /** 当前积压（指标末桶）。 */
  backlog: number;
  /** 检测站忙闲。 */
  inspectors: { id: string; busy: boolean }[];
  /** 堆垛机实时状态：所在巷道位置、目标货位层、左右侧、累计入库。 */
  stackers: { id: string; label: string; z: number; level: number; side: string; stores: number }[];
  /** 立库累计入库 / 出库次数。 */
  asrsStore: number;
  asrsRetrieve: number;
  /** 立库当前库存（已上架托盘数）与总库容。 */
  stock: number;
  capacity: number;
  /** 每排货架的占用情况，给 HUD 逐排显示。 */
  racks: { id: string; label: string; used: number; capacity: number }[];
  /** 外部车道条数。 */
  externalLanes: number;
  /** 外部在途物料数。 */
  externalActive: number;
  /** 最近若干事件，给 HUD 滚动展示。 */
  recent: WorldEvent[];
}

/**
 * 会话构造选项。
 *
 * `autoPlay` 唯一的作用，是让"读库对齐序号"排在"世界开始推进"之前：
 * 持久仓储要用一次网络往返才知道写到几号了，而世界一动就在发事件，
 * 事件编号又是会话内自增的——两者并行就会用旧号去撞服务端的"严格单调"。
 */
export interface StudioSessionOptions {
  /** 默认 true。`false` 表示构造完先不动，等调用方对齐后再 `start()`。 */
  autoPlay?: boolean;
}

export class StudioSession {
  readonly storage: TwinStorage;
  readonly host: PluginHost;
  readonly world: TwinWorld;
  readonly recorder: SessionRecorder;
  readonly controller: ReplayController;
  /** 当前场景的来源：模板生成还是外部导入。UI 靠它提示"你正在跑别人的布局"。 */
  readonly sceneSource: SceneSource;
  /** 当前会话安装的插件 id（安装顺序即行为执行顺序）。 */
  readonly pluginIds: readonly string[];

  /** 本次会话累计的布局编辑 ops：阶段 K 落库，现在只在前端内存。 */
  private readonly pendingEdits: SceneOp[] = [];
  /** 有没有还没保存到服务端的布局改动（面板的"有未保存修改"提示）。 */
  private layoutDirty = false;

  /**
   * @param scene 外部场景。不传则用插件模板生成默认产线；
   *   传入的场景必须已经过 `parseSceneDocument`（校验 + 迁移），
   *   这里不再重复校验——调用方负责保证它合法。
   * @param storage 仓储。默认内存（纯静态可跑）；服务端在的时候传 HTTP 仓储，
   *   场景与事件就能真的存下来、刷新不丢。
   * @param options `autoPlay: false` 时构造完**不自动开跑**，由调用方在
   *   `resumeFromStorage()` 对齐完事件序号之后再调 `start()`。
   */
  constructor(
    scene?: TwinScene,
    storage: TwinStorage = createMemoryStorage(),
    plugins: readonly TwinPlugin[] = resolvePlugins(DEFAULT_PLUGIN_IDS),
    options: StudioSessionOptions = {},
  ) {
    this.storage = storage;
    // 1) 安装当前插件集：拿到行为、指标、决策域、场景模板（故障隔离在宿主里）。
    //    安装顺序即行为执行顺序，所以传入数组的顺序是契约的一部分。
    this.host = new PluginHost();
    for (const plugin of plugins) this.host.install(plugin);
    this.pluginIds = plugins.map((plugin) => plugin.manifest.id);

    // 2) 场景优先用显式导入的；否则由所选领域包提供默认场景。
    const resolved = scene ?? sceneForPlugins(this.pluginIds);
    this.sceneSource = scene ? 'imported' : 'template';
    this.world = new TwinWorld(resolved, {
      seed: 20240906,
      maxStepsPerAdvance: 600,
      behaviors: this.host.behaviors,
    });

    this.recorder = new SessionRecorder(this.world, this.storage, {
      sessionId: 'studio-live',
      label: 'Studio 实时录制',
      snapshotIntervalSteps: 120,
    });
    this.controller = new ReplayController({
      world: this.world,
      storage: this.storage,
      maxStepsPerAdvance: 600,
      onFrame: (frame) => {
        void this.recorder.tick(frame);
      },
    });
    void this.recorder.start();
    // ❸ 注意顺序：**先对齐序号，再开跑**。世界一动就发事件，事件编号是会话内自增的
    // 游标；而库里的历史要一次网络往返才拿得到。边跑边等 = 用"新会话的 1"去撞
    // "库里的 1"，服务端只能用 409 拒收（它不敢猜这批事件该插在哪）。
    // 所以连着持久仓储时由调用方传 `autoPlay: false`，自己排好这个顺序。
    if (options.autoPlay !== false) this.controller.play(1);
  }

  /**
   * 开始推进世界（1×）。只有传了 `autoPlay: false` 才需要显式调用。
   *
   * 对齐失败**也要调**：画面该继续跑，只是写库会被拒收——那时候该给的是提示，
   * 而不是一个停住的三维（HTTP 仓储会把拒收原因暴露出来，见 `writeErrors()`）。
   */
  start(speed = 1): void {
    this.controller.play(speed);
  }

  /** 载入 CSV：切到 hybrid 模式，并把 CSV 里出现过的实体标成外部数据源。 */
  loadCsv(text: string): CsvLoadResult {
    const { source, result } = CsvFrameSource.fromCsv(text);
    this.controller.attachSource(source);
    this.world.setMode('hybrid');
    const entities = [...new Set(result.frames.flatMap((frame) => frame.entities.map((entity) => entity.id)))];
    for (const id of entities) this.world.setEntityDataSource(id, 'external');
    return { frames: result.frames.length, duration: source.duration, issues: result.issues, entities };
  }

  /** 丢掉数据源，回到纯仿真。 */
  useSimulation(): void {
    this.controller.attachSource(undefined);
    this.world.setMode('sim');
  }

  /** 当前场景（声明部分）。导出与摘要都从它取，保证 UI 与内核看到的是同一份。 */
  currentScene(): TwinScene {
    return this.world.scene;
  }

  // ---------------------------------------------------------------------------
  // 布局编辑（阶段 J）
  // ---------------------------------------------------------------------------

  /**
   * 实体**声明里**的位姿。面板输入框绑的是文档，不是运行时状态——
   * 仿真位姿再怎么跑动，也不该出现在布局输入框里（否则一刷新回滚都不知道改了啥）。
   */
  declaredTransform(id: string): TwinTransform | undefined {
    return this.world.scene.entities.find((entity) => entity.id === id)?.transform;
  }

  /** 这个实体的位姿由谁说了算。直接转内核的答案，UI 不自己猜（会漂移）。 */
  poseEditability(id: string): PoseEditability {
    return this.world.poseEditability(id);
  }

  /**
   * 应用一批布局编辑 ops（拖拽松手、输入框改值都走这里）。
   *
   * 失败不抛：把内核的人话原样带回 UI，且内核保证**一条都没改**
   * （整批检查通过才动手，不留半截状态）。
   *
   * 成功后 ops 累计进 `pendingEdits`：阶段 K 要把它们落到存储侧；
   * 现在只在前端内存，与"整文档保存到服务端"是两条独立通道。
   */
  applyEdit(ops: readonly SceneOp[]): EditOutcome {
    try {
      this.world.applySceneOps(ops);
      this.pendingEdits.push(...ops);
      this.layoutDirty = true;
      return { ok: true, applied: [...ops] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), applied: [] };
    }
  }

  /** 有没有未保存的布局改动。 */
  hasLayoutEdits(): boolean {
    return this.layoutDirty;
  }

  /** 整文档保存成功后调用：改动已经落库。 */
  markLayoutSaved(): void {
    this.layoutDirty = false;
  }

  /** 本次会话累计的布局编辑 ops（阶段 K 的存储侧通道入口）。 */
  layoutOps(): readonly SceneOp[] {
    return this.pendingEdits;
  }

  /**
   * 把事件 sequence 对到仓储里已有的进度（**续写**，不覆盖历史）。
   *
   * 服务端是持久的：场景第二次被录制时库里已有上一次的事件，不对齐就会撞上
   * "sequence 必须严格单调"。会话构造是同步的（不能 await 仓储），
   * 所以这一步由调用方显式调一次。
   *
   * @returns 对齐后的下一条 sequence；仓储里没有历史时为 1。
   */
  async resumeFromStorage(): Promise<number> {
    const latest = await this.storage.events.latestSequence(this.world.scene.id);
    return this.world.resumeFrom(latest);
  }

  /** 场景摘要：规模、类型构成、包围盒。导入后给用户一眼确认"装对了没有"。 */
  describeScene(): SceneSummary {
    return sceneSummary(this.world.scene);
  }

  /**
   * 当前场景里，能被已安装插件的行为识别的设备占比。
   *
   * 导入外部布局时最容易踩的坑是：几何进来了，但没有行为认得这些 `kind`，
   * 于是场景"跑不动"却毫无提示。这里给出一个粗略的可驱动率，UI 据此提醒。
   */
  drivableKinds(): { known: number; unknown: string[] } {
    // 行为靠 `capabilities` 认领实体，而不是靠 kind——所以按能力统计。
    // 物流插件认领的是 move/transfer/source/sink/store/load 这几类能力。
    const knownCapabilities = new Set(['move', 'transfer', 'source', 'sink', 'store', 'load', 'pack', 'inspect', 'fill']);
    const unknown = new Set<string>();
    let known = 0;
    for (const entity of this.world.scene.entities) {
      if (entity.capabilities.some((capability) => knownCapabilities.has(capability))) known += 1;
      else if (!CARGO_KINDS.has(entity.kind)) unknown.add(entity.kind);
    }
    return { known, unknown: [...unknown].sort() };
  }

  /** 时间轴上的最近事件（世界内存日志的尾部）。 */
  recentEvents(count = 8): WorldEvent[] {
    return this.world.getEventLog().slice(-count).reverse();
  }

  /** 已落库事件数，用来确认录制在跑。 */
  async storedEventCount(): Promise<number> {
    return this.storage.events.latestSequence(this.world.scene.id);
  }

  /** 当前产线指标（吞吐 / 积压 / 利用率 / 停机），全交给 analytics-core。 */
  metrics(): LineMetrics {
    return lineMetrics(this.world.getEventLog(), {
      bucketSize: Math.max(1 / 60, this.world.time / 20),
      // 闭环产线的"进/出"就是产出与运走：积压 = 在制 + 在库，正是老板要看的数。
      enterTypes: ['goods:produced'],
      exitTypes: ['goods:shipped'],
      busyStatuses: ['busy'],
      downStatuses: ['down'],
      until: this.world.time,
    });
  }

  /** HUD 遥测：从世界事件日志派生一组轻量快照，UI 直接展示，不在 Studio 重算语义。 */
  telemetry(): StudioTelemetry {
    const events = this.world.getEventLog();
    // 小货物与托盘都是**运行时生成**的，只能从世界状态里数（场景声明表里没有它们）。
    const live = this.world.listEntities();
    const active = live.filter((entity) => entity.kind === 'parcel').length;
    const pallets = live.filter((entity) => entity.kind === 'pallet').length;
    const spawned = events.filter((event) => event.type === 'goods:produced').length;
    const consumed = events.filter((event) => event.type === 'goods:shipped').length;
    const packed = events.filter((event) => event.type === 'goods:packed').length;
    const trucks = this.world.scene.entities
      .filter((entity) => entity.kind === 'truck')
      .map((entity) => {
        const attrs = this.world.getEntity(entity.id)?.attrs ?? {};
        return {
          id: entity.id,
          label: typeof entity.config?.label === 'string' ? entity.config.label : entity.id,
          state: typeof attrs.truckState === 'string' ? attrs.truckState : 'docked',
          load: typeof attrs.load === 'number' ? attrs.load : 0,
        };
      });
    const backlog = seriesLatest(this.metrics().backlog);
    const inspectors = this.world.scene.entities
      .filter((entity) => entity.kind === 'inspect')
      .map((device) => {
        const last = [...events].reverse().find((event) => event.type === 'entity:status' && event.entityId === device.id);
        const status = (last?.payload as { status?: string } | undefined)?.status;
        return { id: device.id, busy: status === 'busy' };
      });
    const stackers = this.world.scene.entities
      .filter((entity) => entity.kind === 'stacker')
      .map((crane) => {
        const mine = events.filter((event) => event.entityId === crane.id);
        const last = [...mine].reverse().find((event) => event.type === 'asrs:store');
        const payload = last?.payload as { column?: number; level?: number; side?: string } | undefined;
        return {
          id: crane.id,
          label: typeof crane.config?.label === 'string' ? crane.config.label : crane.id,
          z: this.world.getEntity(crane.id)?.transform.position[2] ?? 0,
          level: payload?.level ?? 0,
          side: payload?.side === 'near' ? '左' : payload?.side === 'far' ? '右' : '—',
          stores: mine.filter((event) => event.type === 'asrs:store').length,
        };
      });
    // 货架占用由 asrs-cycle 行为写进 rack.attrs（used / capacity），这里只读不重算。
    const racks = this.world.scene.entities
      .filter((entity) => entity.kind === 'asrs')
      .map((rack) => {
        const attrs = this.world.getEntity(rack.id)?.attrs ?? {};
        return {
          id: rack.id,
          label: typeof rack.config?.label === 'string' ? rack.config.label : rack.id,
          used: typeof attrs.used === 'number' ? attrs.used : 0,
          capacity: typeof attrs.capacity === 'number' ? attrs.capacity : 0,
        };
      });
    const externalLanes = this.world.scene.entities.filter((entity) => entity.kind === 'transport' && entity.id.startsWith('ext-')).length;
    const externalActive = this.world.scene.entities.filter((entity) => entity.id.startsWith('ext-cargo')).length;
    return {
      time: this.world.time,
      active,
      spawned,
      consumed,
      packed,
      pallets,
      trucks,
      truckTrips: events.filter((event) => event.type === 'truck:departed').length,
      backlog,
      inspectors,
      stackers,
      asrsStore: events.filter((event) => event.type === 'asrs:store').length,
      asrsRetrieve: events.filter((event) => event.type === 'asrs:retrieve').length,
      stock: racks.reduce((sum, rack) => sum + rack.used, 0),
      capacity: racks.reduce((sum, rack) => sum + rack.capacity, 0),
      racks,
      externalLanes,
      externalActive,
      recent: events.slice(-6).reverse(),
    };
  }

  /**
   * 方案分叉对比：以当前世界为基准，同一套场景、同一组行为，
   * 只把打包批量改掉（A = 2 合 1，B = 批量），输出结构化差异。
   *
   * 两条方案必须**跑同一组行为**——只换其中一个参数，否则比的是两个不同的产线。
   */
  compare(forkAt: number, horizon: number, batchB: number): ScenarioDiff {
    const behaviors = (batch?: number) => [
      createLogisticsBehavior(),
      createGoodsSourceBehavior(),
      createAsrsBehavior(),
      createPackingBehavior(batch ? { batch } : {}),
      createTruckBehavior(),
      createTransferBehavior(),
      createBufferFillBehavior(),
    ];
    const batch = Math.max(1, Math.round(batchB));
    // 用**当前**场景做基准：导入外部布局后，对比的也得是这份布局，
    // 否则比的是"模板场景的两个变体"，跟用户眼前看到的对不上。
    return compareScenarios({
      scene: structuredClone(this.world.scene),
      forkAt,
      horizon,
      variants: [
        { id: 'A', label: '2 合 1 打包', behaviors: behaviors() },
        { id: 'B', label: `${batch} 合 1 打包`, behaviors: behaviors(batch) },
      ],
    });
  }
}
