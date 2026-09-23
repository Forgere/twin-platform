import { createSignal, For, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { LineMetrics } from '@twin-platform/analytics-core';
import { StudioSession, type StudioTelemetry } from '../scene/studioSession';
import { DEFAULT_PLUGIN_IDS, entryFor, resolvePlugins } from '../plugins/catalog';
import { TwinSceneController, type CameraPreset, type TwinEntityView } from '../scene/TwinSceneController';
import { selectionCard, type SelectionCard } from '../scene/selectionCard';
import type { ThemeName } from '../scene/theme';
import { parseSceneDocument, sceneFileName, serializeSceneDocument, type SceneOp, type TwinScene, type TwinTransform } from '@twin-platform/scene-schema';
import { createHttpStorage, pingServer } from '@twin-platform/storage-http';
import { resolveServerUrl } from '../scene/serverUrl';
import type { SceneSummary as StoredSceneSummary } from '@twin-platform/storage-contracts';
import ScenePanel, { type SceneExportPayload, type SceneImportOutcome, type ServerState } from './ScenePanel';
import PoseEditor, { copyTransform } from './PoseEditor';
import DataSourcePanel from './DataSourcePanel';
import EventLogPanel from './EventLogPanel';
import TimelineBar from './TimelineBar';
import PluginsPanel from './PluginsPanel';
import DecisionPanel from './DecisionPanel';
import FishingSandbox from './FishingSandbox';
import FishingOnboarding from './fishing/FishingOnboarding';
import FishingHud from './fishing/FishingHud';
import FishingAssistant from './fishing/FishingAssistant';
import RigInspector from './fishing/RigInspector';
import { hasRig, readRig } from './fishing/fishingWorld';
import { defaultTab, inspectorTabs, sceneProfileOf, type InspectorTab, type SceneProfile } from '../scene/sceneProfile';
import MetricsPanel from './MetricsPanel';
import ScenarioComparePanel from './ScenarioComparePanel';

/**
 * Studio 主视口。
 *
 * 只做三件事：把三维视口挂上去、把命令转给控制器与相机、把世界状态显示出来。
 * 世界怎么推演、事件怎么落库、时间轴怎么重算、指标怎么算、方案怎么比，
 * 全在各包里，这里一行都不写。
 *
 * 布局约束（本轮改动的重点）：
 * - 整页锁在 100vh 内，只有视口与右侧面板内部可以滚动，页面本身不滚；
 * - 右侧检视区是**互斥标签页**，一次只显示一个面板；实体页内设备/物料也是互斥切换；
 *   标签组由场景画像决定（scene/sceneProfile.ts）：钓场看钓组 / 剖面，物流看指标 / 对比；
 * - 右侧是**编辑器**；应用本身（开钓向导、钓况 HUD、钓鱼助手）浮在画布上；
 * - 画布上常驻的只有左上角一列小按钮，其余（遥测浮层、仿真控制条、区域列表）
 *   默认全部收起，点了才展开，把画面尽量让给场景。
 */

type EntityFilter = 'device' | 'cargo';

/** 属于"物料"的实体类型，其余都算设备。 */
const CARGO_KINDS = new Set(['parcel', 'pallet']);

/** 画布操作提示：只在区域浮层底部出现，不再常驻占一条高度。 */
const VIEW_HINT = '拖动旋转 · 右键平移 · 滚轮缩放 · 点击可选中';

/** 区域 / 机位：点工具条上的相机按钮呼出。 */
const REGIONS: { id: CameraPreset; icon: string; label: string }[] = [
  { id: 'overview', icon: '🌐', label: '全局' },
  { id: 'infeed', icon: '📥', label: '入料' },
  { id: 'inspection', icon: '🔎', label: '质检' },
  { id: 'sorter', icon: '🔀', label: '分拣' },
  { id: 'warehouse', icon: '🏗️', label: '立库' },
  { id: 'aisle', icon: '🚋', label: '巷道' },
  { id: 'outfeed', icon: '📤', label: '出库' },
  { id: 'external', icon: '🔗', label: '外部' },
];

// ---------------------------------------------------------------------------
// 上次选择的记忆（localStorage）：插件集与场景文档分开存。
// 场景存的是**完整文档**而不是 id——纯静态部署没有服务端，也能原样恢复。
// ---------------------------------------------------------------------------

const PLUGIN_MEMORY_KEY = 'twin.plugins.v1';
const SCENE_MEMORY_KEY = 'twin.scene.v1';

/** 恢复上次的插件集；id 逐个校验，旧配置里的已删插件不会把页面卡死。 */
function restorePluginIds(): readonly string[] {
  if (typeof localStorage === 'undefined') return [...DEFAULT_PLUGIN_IDS];
  try {
    const raw = localStorage.getItem(PLUGIN_MEMORY_KEY);
    if (!raw) return [...DEFAULT_PLUGIN_IDS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_PLUGIN_IDS];
    const ids = parsed.filter((id): id is string => typeof id === 'string' && entryFor(id) !== undefined);
    return ids.length > 0 ? ids : [...DEFAULT_PLUGIN_IDS];
  } catch {
    return [...DEFAULT_PLUGIN_IDS];
  }
}

/** 恢复上次的场景文档；解析 / 校验失败就当没存过（回落到插件模板）。 */
function restoreScene(): TwinScene | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(SCENE_MEMORY_KEY);
    if (!raw) return undefined;
    const parsed = parseSceneDocument(raw);
    return parsed.ok ? parsed.scene : undefined;
  } catch {
    return undefined;
  }
}

function rememberScene(scene: TwinScene): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SCENE_MEMORY_KEY, serializeSceneDocument(scene));
  } catch {
    // 配额满 / 隐私模式：记不住就不记，功能不受影响。
  }
}

function rememberPlugins(ids: readonly string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PLUGIN_MEMORY_KEY, JSON.stringify(ids));
  } catch {
    // 同上：记忆失败不阻塞主流程。
  }
}

export default function TwinViewport() {
  /**
   * 会话是**可替换**的信号，不是常量：导入外部场景要整个换掉（世界、录制器、
   * 时间轴控制器全得重建），旧的那一份必须停掉，否则两个世界会同时推进。
   */
  const [activePlugins, setActivePlugins] = createSignal<readonly string[]>(restorePluginIds());
  /** 机位：物流的产线机位只在物流领域包在场时才列；否则只留全景（全景按包围盒自动取景）。 */
  const regionPresets = () => (activePlugins().includes('logistics') ? REGIONS : REGIONS.filter((item) => item.id === 'overview'));
  const [session, setSession] = createSignal(
    new StudioSession(restoreScene(), undefined, resolvePlugins(activePlugins())),
  );
  /** 场景画像：决定右侧标签组、画布浮层（钓场才有向导 / HUD / 助手）。 */
  const profileFor = (target: StudioSession): SceneProfile =>
    sceneProfileOf({ hasRig: hasRig(target), plugins: target.pluginIds });
  const profile = (): SceneProfile => profileFor(session());
  const tabs = () => inspectorTabs(profile(), session().host.decisions.length > 0);
  let controller: TwinSceneController | undefined;
  let hostEl: HTMLDivElement | undefined;

  const [selected, setSelected] = createSignal<TwinEntityView>();
  const [entities, setEntities] = createSignal<TwinEntityView[]>([]);
  const [tab, setTab] = createSignal<InspectorTab>(untrack(() => defaultTab(profile())));
  /**
   * 开钓向导浮层：进钓场且钓组还没配过就自动打开——"从一开始就有人带着"，
   * 不让新手自己猜从哪儿开始。配过之后随时可从 HUD 的 ⚙ / 钓组页重新打开。
   *
   * 存的是"给哪个会话开的向导"而不是布尔：换会话时旧向导必须卸掉、新会话另起一个
   * （向导持有会话做写入与暂停，不能在一个活着的向导底下偷换会话）。
   */
  const onboardingTarget = (target: StudioSession): StudioSession | undefined =>
    profileFor(target) === 'fishing' && readRig(target)?.wizardDone !== true ? target : undefined;
  const [onboardingFor, setOnboardingFor] = createSignal<StudioSession | undefined>(untrack(() => onboardingTarget(session())));
  const openOnboarding = (): void => {
    setOnboardingFor(session());
  };
  const [filter, setFilter] = createSignal<EntityFilter>('device');
  /** 遥测浮层：默认**收起**，点工具条的小按钮才显示（"隐藏浮层"的默认值）。 */
  const [hud, setHud] = createSignal(false);
  /** 仿真控制条：不常用，默认收起；点工具条按钮或画布左下角的时间胶囊才展开。 */
  const [controls, setControls] = createSignal(false);
  /** 区域 / 机位浮层：点相机按钮呼出，选完即关。 */
  const [regions, setRegions] = createSignal(false);
  const [theme, setTheme] = createSignal<ThemeName>('pastel');
  const [view, setView] = createSignal<{
    time: number;
    duration: number;
    playing: boolean;
    speed: number;
    events: WorldEvent[];
    stored: number;
  }>({ time: 0, duration: 0, playing: true, speed: 1, events: [], stored: 0 });
  const [metrics, setMetrics] = createSignal<LineMetrics>(untrack(() => session().metrics()));
  const [telemetry, setTelemetry] = createSignal<StudioTelemetry>(untrack(() => session().telemetry()));
  /** 采样节拍：实体详情里的实时状态（货位、库存、当前任务）按它刷新。 */
  const [tick, setTick] = createSignal(0);
  /** 右键菜单：记下弹在哪、对哪个实体，以及刚复制了什么（用来给个即时反馈）。 */
  const [menu, setMenu] = createSignal<{ x: number; y: number; entity: TwinEntityView; note?: string } | null>(
    null,
  );

  const copyText = async (text: string, note: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 非安全上下文（http://）下 clipboard 不可用，退回到隐藏 textarea + execCommand。
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    const current = menu();
    if (current) setMenu({ ...current, note });
  };

  const openMenu = (event: MouseEvent, entity: TwinEntityView): void => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, entity });
  };

  /**
   * 在同一个挂载点上（重新）建三维控制器。换场景与首次挂载共用这条路径。
   *
   * 会话必须显式传进来：Solid 2 的信号写入在 flush 之前对非响应式读取不可见，
   * `setSession(next)` 之后紧接着读 `session()` 拿到的还是旧会话——以前换插件 / 换场景后
   * 三维视图会接着驱动旧的（已暂停的）世界，时钟停在 0。
   */
  const buildController = (target: StudioSession) => {
    if (!hostEl) return;
    controller?.dispose();
    controller = new TwinSceneController(
      hostEl,
      (entity) => {
        setSelected(entity);
        // 点中场景里的东西就把实体页翻出来，不然选中了也看不见。
        if (entity) setTab('entity');
      },
      {
        scene: target.world.scene,
        controller: target.controller,
        // 拖拽松手才提交（回调在用户操作时才执行，晚于下方这些 const 定义，无 TDZ 问题）。
        onDragCommit: (entityId, position) => commitDrag(entityId, position),
      },
    );
    // 换场景 / 换插件后按包围盒重新取景：写死机位会让小场景（台钓钓场）直接看不见。
    controller.setCameraPreset('overview');
    setEntities(controller.entities);
    setTheme(controller.themeName);
  };

  const mountViewport = (host: HTMLDivElement) => {
    hostEl = host;
    buildController(untrack(session));
  };

  /**
   * 换掉整个会话：旧的先暂停（否则两个世界同时推进、同时写录），
   * 再重建三维控制器把新场景画出来。
   */
  const replaceSession = (next: StudioSession) => {
    session().controller.pause();
    setSession(next);
    setSelected(undefined);
    // 以下一律用 next，不读 session()（见 buildController 的注释）。
    buildController(next);
    // 换了场景就换一套检视页；钓场且没配过钓组 → 向导重新浮出来。
    setTab(defaultTab(profileFor(next)));
    setOnboardingFor(onboardingTarget(next));
  };

  /**
   * 换会话的统一入口：**先对齐事件序号，再让世界开始跑**。
   *
   * 顺序是这一条 Pipeline 的全部要点。世界一动就发事件，事件的 sequence 是会话内
   * 自增的游标；而"库里已经写到几号了"要等一次网络往返才知道。两者并行，
   * 第一批事件就是 1..N（新会话的号），而服务端库里早有 1 —— 它不敢猜这批事件
   * 该插在哪（拼出来是两条时间线接起来的假历史），于是 409 拒收。
   * 构造时必须 `autoPlay: false`，把这个顺序让给这里。
   *
   * @param next 已经构造好但**尚未开跑**的会话。
   * @param persisted 服务端仓储；不传（离线、纯内存）就没有历史要接，直接跑。
   */
  const adoptSession = async (next: StudioSession, persisted?: ReturnType<typeof createHttpStorage>): Promise<void> => {
    replaceSession(next);
    if (!persisted) return; // 内存仓储：构造时已经自动开跑。
    try {
      await next.resumeFromStorage();
    } catch (error) {
      setServer((current) =>
        current
          ? {
              ...current,
              note: `对齐事件序号失败：${error instanceof Error ? error.message : String(error)}`,
            }
          : current,
      );
    } finally {
      // 对齐失败也要开跑：画面继续，写库会被拒收并由面板明示（见 refresh 里的 writeErrors）。
      next.start();
    }
  };

  /** 导入场景 JSON：解析 + 迁移 + 校验，成功才换会话。 */
  const importScene = (raw: string): SceneImportOutcome => {
    const parsed = parseSceneDocument(raw);
    if (!parsed.ok || !parsed.scene) {
      return { ok: false, applied: parsed.applied, issues: parsed.issues };
    }
    // 三处修复叠加：既带服务端仓储（否则导入的场景悄悄退回内存，刷新即丢），
    // 也带当前插件集（否则切换过的插件会在导入后被打回默认领域包），
    // 还要先对齐序号再开跑（库里已有事件时用新会话的 1 去撞，会被 409 拒收）。
    const persisted = serverStorage();
    const next = new StudioSession(parsed.scene, persisted, resolvePlugins(activePlugins()), { autoPlay: !persisted });
    rememberScene(parsed.scene);
    void adoptSession(next, persisted);
    return {
      ok: true,
      name: parsed.scene.name,
      scene: parsed.scene,
      applied: parsed.applied,
      issues: parsed.issues,
      summary: parsed.summary,
    };
  };

  /** 导出当前场景。 */
  const exportScene = (): SceneExportPayload | undefined => {
    const scene = session().currentScene();
    return { text: serializeSceneDocument(scene), fileName: sceneFileName(scene) };
  };

  /** 还原到所选领域包的模板场景（服务端在线时继续用服务端仓储）。 */
  const resetScene = () => {
    // 模板场景的 id 也可能是"库里录过"的那个（例如重建台钓钓场），所以一样要对齐。
    const persisted = serverStorage();
    const next = new StudioSession(undefined, persisted, resolvePlugins(activePlugins()), { autoPlay: !persisted });
    rememberScene(next.world.scene);
    void adoptSession(next, persisted);
  };

  /**
   * 换插件集：行为在 TwinWorld 构造时固定，且插件集是回放输入的一部分，
   * 所以只能"停旧会话 + 用新插件集重建"，不能热插拔。
   */
  const applyPlugins = (ids: string[]) => {
    setActivePlugins(ids);
    rememberPlugins(ids);
    const persisted = serverStorage();
    const next = new StudioSession(undefined, persisted, resolvePlugins(ids), { autoPlay: !persisted });
    rememberScene(next.world.scene);
    void adoptSession(next, persisted);
  };

  // ---------------------------------------------------------------------------
  // 服务端：在就接管存储（场景能存下来），不在就纯静态跑（导入导出仍可用）。
  // ---------------------------------------------------------------------------
  const [server, setServer] = createSignal<ServerState>();
  const [serverStorage, setServerStorage] = createSignal<ReturnType<typeof createHttpStorage>>();

  const refreshServerScenes = async (): Promise<void> => {
    const storage = serverStorage();
    if (!storage) return;
    try {
      const scenes = await storage.scenes.listScenes();
      setServer((current) => (current ? { ...current, scenes } : current));
    } catch (error) {
      setServer((current) =>
        current ? { ...current, note: `读取列表失败：${error instanceof Error ? error.message : String(error)}` } : current,
      );
    }
  };

  const withBusy = async (note: string, action: () => Promise<string>): Promise<void> => {
    setServer((current) => (current ? { ...current, busy: true, note: '处理中…' } : current));
    try {
      const message = await action();
      setServer((current) => (current ? { ...current, busy: false, note: message } : current));
    } catch (error) {
      setServer((current) =>
        current
          ? { ...current, busy: false, note: `${note}失败：${error instanceof Error ? error.message : String(error)}` }
          : current,
      );
    }
    await refreshServerScenes();
  };

  const saveToServer = () =>
    withBusy('保存', async () => {
      const storage = serverStorage();
      if (!storage) throw new Error('服务端未连接。');
      const scene = session().currentScene();
      await storage.scenes.putScene(scene);
      session().markLayoutSaved(); // 手动保存也把布局改动算作已落库
      return `已保存「${scene.name}」（${scene.entities.length} 个实体）。`;
    });

  const loadFromServer = (id: string) =>
    withBusy('加载', async () => {
      const storage = serverStorage();
      if (!storage) throw new Error('服务端未连接。');
      const scene = await storage.scenes.getScene(id);
      if (!scene) throw new Error(`服务端上没有场景 ${id}。`);
      // 这个场景可能已经被录制过，事件要接着写而不是从头覆盖：先对齐，再开跑。
      const persisted = storage;
      const next = new StudioSession(scene, persisted, resolvePlugins(activePlugins()), { autoPlay: false });
      rememberScene(scene);
      await adoptSession(next, persisted);
      return `已加载「${scene.name}」。`;
    });

  const deleteFromServer = (id: string) =>
    withBusy('删除', async () => {
      const storage = serverStorage();
      if (!storage) throw new Error('服务端未连接。');
      await (storage.scenes as unknown as { remove(id: string): Promise<boolean> }).remove(id);
      return `已删除 ${id}。`;
    });

  /**
   * 启动时探一次服务端。
   *
   * 探不到是**正常状态**（纯静态部署），不报错、不弹提示，只是场景面板少了
   * "服务端"那一块。探到了就把会话换成 HTTP 仓储，之后场景与事件都落服务端。
   */
  onSettled(() => {
    // onSettled 要求回调返回「清理函数或 undefined」；原 onMount 是 fire-and-forget，
    // 这里把异步体包成 IIFE 再以 void 返回，等价于挂载后只探一次服务端。
    void (async () => {
      // 线上同源（经 Cloudflare Worker，token 由 Worker 注入）时这两个都是空：
      // URL 走 origin，前端不带 token，也带不了——它根本不知道 token。
      // 本地跨源联调才用 VITE_TWIN_SERVER / VITE_TWIN_API_TOKEN 覆盖。
      // dev 同样走同源：vite.config.ts 的 /api 代理会反代到 :8787 并注入 token，
      // 于是 dev 与部署是同一条拓扑（不再靠 CORS + hostname:8787 的跨源回落）。
      const url = resolveServerUrl();
      const token = import.meta.env.VITE_TWIN_API_TOKEN || undefined;
      const ping = await pingServer(url, { token });
      if (ping.status === 'offline') return; // 纯静态部署：正常状态，不打扰。
      if (ping.status === 'unauthorized') {
        // 服务端在但拒绝了我们。**不能**静默降级成内存仓储——那会让人以为
        // 存下来了，刷新才发现全丢。把原因写进场景面板，让人看得见。
        setServer({ url, scenes: [], busy: false, note: `鉴权失败：${ping.message}` });
        return;
      }
      const storage = createHttpStorage({ baseUrl: url, token });
      setServerStorage(storage);
      setServer({ url, scenes: [], busy: false });
      // 事件流是 append-only 的：库里已有历史就接着写，不能从头覆盖。
      // 同样是"先对齐再开跑"，顺序反了就是上一版每 120ms 一条 409 的那条路径。
      const next = new StudioSession(restoreScene(), storage, resolvePlugins(activePlugins()), { autoPlay: false });
      await adoptSession(next, storage);
      await refreshServerScenes();
    })();
  });

  onCleanup(() => {
    // 攒批的事件别丢在页面关闭这一刻。
    void serverStorage()?.flush();
  });

  /**
   * 服务端拒收过写入时，把原因摆到场景面板上。
   *
   * 静默是最坏的结果：画面还在跑、指标还在跳，人以为录了下来，其实仓库一根事件都
   * 没收。HTTP 仓储对 4xx 是**丢弃 + 熔断**（重试只会再撞一次），所以这里必须给一条
   * 明话，并告诉人怎么恢复。只有文案变化时才写信号，避免每拍重建一个对象。
   */
  const reportWriteErrors = (): void => {
    const failures = serverStorage()?.writeErrors();
    if (!failures || failures.size === 0) return;
    const why = [...failures.entries()].map(([id, reason]) => `${id}：${reason}`).join('；');
    const note = `写入被服务端拒收，录制已停止：${why}。刷新页面会重新对齐事件序号。`;
    setServer((current) => (current && current.note !== note ? { ...current, note } : current));
  };

  // 面板按固定频率采样，而不是每帧刷新：UI 不需要 60Hz 的事件流，
  // 每帧写信号只会把渲染循环拖进响应式更新里。
  const refresh = async () => {
    const current = session();
    // 落库条数读失败不能打断整个采样节拍——面板照常刷新，原因由 writeErrors 明示。
    // （不 catch 的话，它会变成未处理的 Promise rejection：控制台每 120ms 一条。）
    let stored = untrack(() => view().stored);
    try {
      stored = await current.storedEventCount();
    } catch {
      /* 上面已经保底，错误另行呈现 */
    }
    setView({
      time: current.controller.time,
      duration: current.controller.duration,
      playing: current.controller.playing,
      speed: current.controller.speed,
      events: current.recentEvents(8),
      stored,
    });
    reportWriteErrors();
    setMetrics(current.metrics());
    setTelemetry(current.telemetry());
    setTick((value) => value + 1);
  };
  const timer = setInterval(() => void refresh(), 120);

  onCleanup(() => {
    clearInterval(timer);
    controller?.dispose();
  });

  /**
   * "当前选择"卡片的取数：唯一入口是 `selectionCard()`（scene/selectionCard.ts）——
   * 面板渲染它，工具与 AI 也调它，人看到的和模型看到的是同一份数据。
   *
   * 这里只补两样只有 UI 才知道的：采样节拍（实时状态存在世界 attrs 里，不走信号，
   * 得靠节拍显式拉取——和遥测 HUD 同一个套路）与渲染来源（模型溯源，渲染层答得上来）。
   *
   * 注意：**别拿它的返回值当 `<Show when>`** —— 每拍都是新对象，
   * 会把子树（含 PoseEditor 输入框）整个重挂，输入框就打不了字了。
   */
  const selectedCard = (): SelectionCard | undefined => {
    const entity = selected();
    if (!entity) return undefined;
    tick();
    return selectionCard(session().world, entity.id, controller?.codePath(entity.id));
  };

  // ---------------------------------------------------------------------------
  // 布局编辑（阶段 J）：改**场景声明**，产物是结构化 ops（阶段 K 的存储侧入口）
  // ---------------------------------------------------------------------------

  /** 编辑版本号：一次提交成功 +1。PoseEditor 只认它回填输入框（不挂采样节拍）。 */
  const [editRevision, setEditRevision] = createSignal(0);
  const [editError, setEditError] = createSignal<string>();
  /** 还没落库的布局改动。纯静态部署时永远为 true，面板如实提示"刷新会丢"。 */
  const [layoutDirty, setLayoutDirty] = createSignal(false);
  let layoutSaveTimer: ReturnType<typeof setTimeout> | undefined;

  const applyEdit = (ops: readonly SceneOp[]): boolean => {
    const outcome = session().applyEdit(ops);
    if (!outcome.ok) {
      setEditError(outcome.error); // 内核的人话，直接显示（一条都不会被改）
      return false;
    }
    setEditError(undefined);
    setLayoutDirty(true);
    setEditRevision((value) => value + 1);
    scheduleLayoutSave();
    return true;
  };

  /** 去抖自动保存：连着服务端时过一拍把整文档落库——否则"拖完刷新就没"。 */
  const scheduleLayoutSave = (): void => {
    if (layoutSaveTimer !== undefined) clearTimeout(layoutSaveTimer);
    if (!serverStorage()) return; // 纯静态：与其它数据一样刷新即丢，面板如实提示
    layoutSaveTimer = setTimeout(() => void saveLayoutNow(), 900);
  };

  const saveLayoutNow = async (): Promise<void> => {
    const storage = serverStorage();
    const current = session();
    if (!storage || !current.hasLayoutEdits()) return;
    const scene = current.currentScene();
    try {
      await storage.scenes.putScene(scene);
      current.markLayoutSaved();
      setLayoutDirty(false);
      setServer((state) => (state ? { ...state, note: `布局已自动保存（${scene.entities.length} 个实体）。` } : state));
    } catch (error) {
      setServer((state) =>
        state
          ? { ...state, note: `自动保存布局失败：${error instanceof Error ? error.message : String(error)}` }
          : state,
      );
    }
  };

  onCleanup(() => {
    if (layoutSaveTimer !== undefined) clearTimeout(layoutSaveTimer);
  });

  /** 拼一条 setTransform op 并应用；`before` 取自当前声明（乐观校验，对不上就拒）。 */
  const commitPose = (entityId: string, next: TwinTransform): boolean => {
    const before = session().declaredTransform(entityId);
    if (!before) return false;
    return applyEdit([{ type: 'setTransform', entityId, before: copyTransform(before), after: next }]);
  };

  /**
   * 画布拖拽松手：只改位置，朝向与缩放保持声明值。
   * 拖拽预览只动了渲染层的网格，所以这里的 `before` 依然是拖之前的声明，天然对得上。
   */
  const commitDrag = (entityId: string, position: [number, number, number]): boolean => {
    const before = session().declaredTransform(entityId);
    if (!before) return false;
    return commitPose(entityId, { ...copyTransform(before), position });
  };

  /**
   * 实体列表：场景声明的 + 运行时生成出来的（发生器产的小货物、打包出的托盘…）。
   *
   * 读 `tick()` 是为了在采样节拍上重算——生成的实体不经过信号，
   * 只能按节拍从世界状态里拉（和实时状态行同一个套路）。
   */
  const visibleEntities = (): TwinEntityView[] => {
    tick();
    const all = controller ? controller.listEntities() : entities();
    return filter() === 'device'
      ? all.filter((entity) => !CARGO_KINDS.has(entity.kind))
      : all.filter((entity) => CARGO_KINDS.has(entity.kind));
  };

  return (
    <main class="studio-shell">
      <header class="studio-heading">
        <span class="brand">TWIN STUDIO</span>
        {/* 标题跟着场景走：导入外部布局后，这里显示的就是那个场景的名字。 */}
        <h1>{session().world.scene.name}</h1>
      </header>

      <div class="studio-grid">
        <section class="viewport-panel">
          <div class="viewport-frame">
            <div ref={mountViewport} class="viewport" aria-label="数字孪生三维场景" />

            {/* 画布左上角一列小按钮：区域 / 遥测 / 主题 / 仿真控制，各自点了才展开内容。 */}
            <div class="vp-toolbar" aria-label="视图工具">
              <button
                type="button"
                class={regions() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-expanded={regions()}
                aria-label="选择区域 / 机位"
                title={`选择区域 / 机位（${VIEW_HINT}）`}
                onClick={() => setRegions(!regions())}
              >
                📷
              </button>
              <Show when={profile() === 'logistics'}>
              <button
                type="button"
                class={hud() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={hud()}
                aria-label="显示 / 隐藏遥测浮层"
                title={hud() ? '隐藏浮层' : '显示浮层'}
                onClick={() => setHud(!hud())}
              >
                📡
              </button>
              </Show>
              <button
                type="button"
                class={theme() === 'industrial' ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={theme() === 'industrial'}
                aria-label="切换设备主题"
                title={`设备主题：${theme() === 'pastel' ? '玩具工厂' : '工业涂装'}（点击切换）`}
                onClick={() => {
                  const next: ThemeName = theme() === 'pastel' ? 'industrial' : 'pastel';
                  controller?.setTheme(next);
                  setTheme(next);
                }}
              >
                🎨
              </button>
              <button
                type="button"
                class={controls() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={controls()}
                aria-label="显示 / 隐藏仿真控制条"
                title={controls() ? '收起仿真控制条' : '展开仿真控制条'}
                onClick={() => setControls(!controls())}
              >
                ⏱
              </button>
              <button
                type="button"
                class={tab() === 'scene' ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={tab() === 'scene'}
                aria-label="场景导入导出"
                title={`场景导入 / 导出（当前：${session().sceneSource === 'imported' ? '外部导入' : '插件模板'}）`}
                onClick={() => setTab(tab() === 'scene' ? defaultTab(profile()) : 'scene')}
              >
                🗂
              </button>
            </div>

            {/* 区域列表：点相机呼出，选一个就飞过去并关掉，不常驻占高度。 */}
            <Show when={regions()}>
              <>
                <div class="vp-backdrop" onMouseDown={() => setRegions(false)} />
                <div class="vp-popover" aria-label="选择区域">
                  <div class="vp-popover-head">区域 / 机位</div>
                  <div class="vp-regions">
                    <For each={regionPresets()}>
                      {(region) => (
                        <button
                          type="button"
                          class="vp-region"
                          onClick={() => {
                            controller?.setCameraPreset(region.id);
                            setRegions(false);
                          }}
                        >
                          <span aria-hidden="true">{region.icon}</span> {region.label}
                        </button>
                      )}
                    </For>
                  </div>
                  <p class="vp-hint">{VIEW_HINT}</p>
                </div>
              </>
            </Show>

            <Show when={hud() && profile() === 'logistics'}>

              <div class="telemetry-hud" aria-label="仿真遥测">
                <h3>📡 Sim Telemetry · t = {view().time.toFixed(1)}s</h3>
                <div class="telemetry-grid">
                  <div class="tele-cell">
                    <span class="tele-label">在制小件</span>
                    <span class="tele-value">{telemetry().active}</span>
                  </div>
                  <div class="tele-cell">
                    <span class="tele-label">已产出</span>
                    <span class="tele-value">{telemetry().spawned}</span>
                  </div>
                  <div class="tele-cell">
                    <span class="tele-label">已打包</span>
                    <span class="tele-value">{telemetry().packed}</span>
                  </div>
                  <div class="tele-cell">
                    <span class="tele-label">已运走</span>
                    <span class="tele-value">{telemetry().consumed}</span>
                  </div>
                  <div class="tele-cell">
                    <span class="tele-label">在制托盘</span>
                    <span class="tele-value">{telemetry().pallets}</span>
                  </div>
                  <div class="tele-cell">
                    <span class="tele-label">立库库存</span>
                    <span class="tele-value">
                      {telemetry().stock}/{telemetry().capacity}
                    </span>
                  </div>
                  {/* 原来顶栏状态条里的两个计数，移到遥测里统一展示 */}
                  <div class="tele-cell">
                    <span class="tele-label">累计入库</span>
                    <span class="tele-value">{telemetry().asrsStore}</span>
                  </div>
                  <div class="tele-cell">
                    <span class="tele-label">累计出库</span>
                    <span class="tele-value">{telemetry().asrsRetrieve}</span>
                  </div>
                </div>

                <div class="tele-section">
                  <span class="tele-label">卡车</span>
                  <div class="tele-chips">
                    <For each={telemetry().trucks}>
                      {(truck) => (
                        <span class="chip chip-idle">
                          {truck.label}{' '}
                          {truck.state === 'docked'
                            ? `装车中 ${truck.load}`
                            : truck.state === 'departing'
                              ? '驶离中'
                              : truck.state === 'away'
                                ? '在门外'
                                : '回场中'}
                        </span>
                      )}
                    </For>
                    <span class="chip chip-idle">已发车 {telemetry().truckTrips} 趟</span>
                  </div>
                </div>

                <div class="tele-section">
                  <span class="tele-label">检测站</span>
                  <div class="tele-chips">
                    <For each={telemetry().inspectors}>
                      {(inspector) => (
                        <span class={inspector.busy ? 'chip chip-busy' : 'chip chip-idle'}>
                          {inspector.id} {inspector.busy ? '●' : '○'}
                        </span>
                      )}
                    </For>
                  </div>
                </div>

                <div class="tele-section">
                  <span class="tele-label">堆垛机</span>
                  <div class="tele-stackers">
                    <For each={telemetry().stackers}>
                      {(stacker) => (
                        <span class="tele-stacker">
                          <b>{stacker.label}</b>
                          <em>
                            z {stacker.z.toFixed(1)}m · 层 {stacker.level.toFixed(2)}m · {stacker.side} · 入库 {stacker.stores}
                          </em>
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </Show>

            {/* 钓场：钓况 HUD（右上）+ 钓鱼助手（右下）常驻；开钓向导浮在画布中央。 */}
            <Show when={profile() === 'fishing'}>
              <FishingHud session={session()} tick={tick()} onReconfigure={openOnboarding} />
              <FishingAssistant session={session()} />
            </Show>
            {/* keyed：每个会话一个向导实例；会话一换，旧向导卸掉、新会话另起。 */}
            <Show when={onboardingFor() === session() ? onboardingFor() : undefined} keyed>
              {(target: StudioSession) => <FishingOnboarding session={target} onClose={() => setOnboardingFor(undefined)} />}
            </Show>

            {/* 控制条收起时，左下角只留一枚时间胶囊；点它（或工具条 ⏱）才展开完整控制条。 */}
            <Show when={!controls()}>
              <button
                type="button"
                class="vp-clock"
                title="展开仿真控制条"
                onClick={() => setControls(true)}
              >
                <span class="status-dot" />
                t {view().time.toFixed(1)}s
                <em>{view().playing ? `▶ ${view().speed}×` : '⏸'}</em>
              </button>
            </Show>
          </div>

          {/* 仿真控制不常用：默认不渲染，明确点开才出现。 */}
          <Show when={controls()}>
            <TimelineBar
              time={view().time}
              duration={view().duration}
              playing={view().playing}
              speed={view().speed}
              onPlay={() => session().controller.play()}
              onPause={() => session().controller.pause()}
              onSpeed={(speed) => session().controller.setSpeed(speed)}
              onSeek={(time) => void session().controller.seek(time)}
              onStep={(steps) => session().controller.stepFrames(steps)}
              onCollapse={() => setControls(false)}
            />
          </Show>
        </section>

        <aside class="inspector" aria-label="场景控制与实体详情">
          <div class="tab-bar" role="tablist" aria-label="检视面板">
            <For each={tabs()}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  class={tab() === item.id ? 'tab tab-active' : 'tab'}
                  aria-selected={tab() === item.id}
                  onClick={() => setTab(item.id)}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              )}
            </For>
          </div>

          {/* 六个面板互斥：同一时刻只有一个被渲染，不会堆成一长条。 */}
          <div class="tab-panel">
            <Show when={tab() === 'entity'}>
              {/* 卡片放最上面 + sticky（App.css），实体列表再长也不会把它顶出屏幕；
                  列表自己限高滚动，滚动发生在卡片下方。 */}
              <section class="entity-detail" aria-live="polite">
                <h2>🎯 当前选择</h2>
                <Show when={selected()} fallback={<p>点击场景中的设备或物料，或从下方列表选择。</p>}>
                  {(entity) => {
                    // 卡片数据只从 selectionCard() 取（工具 / AI 同款），它每拍现算，
                    // 所以下面一律用普通表达式消费，不能再套一层 <Show when={卡片}>。
                    const card = selectedCard;
                    return (
                      <>
                        <strong onContextMenu={(event) => openMenu(event, entity())} title="右键可复制名字 / ID">
                          {card()?.label ?? entity().label}
                        </strong>
                        <span>
                          {card()?.kind ?? entity().kind} · {entity().id}
                        </span>
                        <Show when={(card()?.stateLines.length ?? 0) > 0}>
                          <dl class="entity-state">
                            <For each={card()?.stateLines}>
                              {(line) => <dd>{line}</dd>}
                            </For>
                          </dl>
                        </Show>
                        <span class="code-path">渲染来源：{card()?.codePath ?? '—'}</span>
                        <PoseEditor
                          entityId={entity().id}
                          revision={editRevision()}
                          getDeclared={() => session().declaredTransform(entity().id)}
                          locked={card()?.editability.editable ? undefined : card()?.editability.reason}
                          onCommit={(next) => commitPose(entity().id, next)}
                        />
                        <Show when={editError()}>
                          {(message) => <p class="pose-error">⚠️ {message()}</p>}
                        </Show>
                        <Show when={layoutDirty()}>
                          <p class="pose-dirty">
                            ● 有未保存的布局改动{serverStorage() ? '（马上自动保存）' : '（纯静态部署，刷新会丢）'}
                          </p>
                        </Show>
                        <button type="button" onClick={() => controller?.focusEntity(entity().id)}>
                          聚焦此实体
                        </button>
                      </>
                    );
                  }}
                </Show>
              </section>

              <div class="segmented" role="group" aria-label="实体类别">
                <button
                  type="button"
                  class={filter() === 'device' ? 'seg seg-active' : 'seg'}
                  aria-pressed={filter() === 'device'}
                  onClick={() => setFilter('device')}
                >
                  设备
                </button>
                <button
                  type="button"
                  class={filter() === 'cargo' ? 'seg seg-active' : 'seg'}
                  aria-pressed={filter() === 'cargo'}
                  onClick={() => setFilter('cargo')}
                >
                  物料
                </button>
              </div>

              <div class="entity-list">
                <For each={visibleEntities()}>
                  {(entity) => (
                    <button
                      type="button"
                      class={selected()?.id === entity.id ? 'selected' : undefined}
                      onClick={() => controller?.selectEntity(entity.id)}
                      onContextMenu={(event) => openMenu(event, entity)}
                      title="左键选中，右键复制名字 / ID"
                    >
                      {entity.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show when={tab() === 'metrics'}>
              <MetricsPanel metrics={metrics()} />
            </Show>

            <Show when={tab() === 'compare'}>
              <ScenarioComparePanel onCompare={(forkAt, horizon, zoneB) => session().compare(forkAt, horizon, zoneB)} />
            </Show>

            <Show when={tab() === 'data'}>
              <DataSourcePanel
                onLoad={(text) => {
                  const loaded = session().loadCsv(text);
                  void session().controller.seek(0);
                  session().controller.play();
                  return loaded;
                }}
                onReset={() => {
                  session().useSimulation();
                  void session().controller.seek(0);
                }}
              />
            </Show>

            <Show when={tab() === 'scene'}>
              <ScenePanel
                sceneId={session().world.scene.id}
                sceneName={session().world.scene.name}
                source={session().sceneSource}
                summary={session().describeScene()}
                unknownKinds={session().drivableKinds().unknown}
                onImport={importScene}
                onExport={exportScene}
                onReset={resetScene}
                server={server()}
                onSaveToServer={saveToServer}
                onLoadFromServer={loadFromServer}
                onDeleteFromServer={deleteFromServer}
                onRefreshServer={refreshServerScenes}
              />
            </Show>

            <Show when={tab() === 'events'}>
              <EventLogPanel events={view().events} stored={view().stored} />
            </Show>

            <Show when={tab() === 'rig'}>
              <RigInspector session={session()} tick={tick()} onReconfigure={openOnboarding} />
            </Show>

            <Show when={tab() === 'sandbox'}>
              <FishingSandbox session={session()} tick={tick()} />
            </Show>

            <Show when={tab() === 'decision'}>
              <DecisionPanel session={session()} />
            </Show>

            <Show when={tab() === 'plugins'}>
              <PluginsPanel host={session().host} activeIds={activePlugins()} onChange={applyPlugins} />
            </Show>
          </div>
        </aside>
      </div>

      {/* 右键菜单：设备/物料名字上点右键弹出，复制名字、ID 或渲染来源。 */}
      <Show when={menu()}>
        {(state) => (
          <>
            <div
              class="ctx-backdrop"
              onMouseDown={() => setMenu(null)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu(null);
              }}
            />
            <div
              class="ctx-menu"
              style={{
                left: `${Math.max(8, Math.min(state().x, window.innerWidth - 200))}px`,
                top: `${Math.max(8, Math.min(state().y, window.innerHeight - 180))}px`,
              }}
            >
              <div class="ctx-title" title={state().entity.id}>
                {state().entity.label}
              </div>
              <button type="button" onClick={() => void copyText(state().entity.label, '已复制名字')}>
                📋 复制名字
              </button>
              <button type="button" onClick={() => void copyText(state().entity.id, '已复制 ID')}>
                🏷️ 复制 ID
              </button>
              <button
                type="button"
                onClick={() => void copyText(controller?.codePath(state().entity.id) ?? '', '已复制渲染来源')}
              >
                🧭 复制渲染来源
              </button>
              <Show when={state().note}>
                <div class="ctx-note">{state().note}</div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </main>
  );
}
