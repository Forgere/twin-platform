import { createEffect, createMemo, createSignal, flush, For, onCleanup, onSettled, Show, untrack } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { presentationFor } from '../plugins/presentations';
import { createWorkspace, type WorkspaceHandle } from '../plugins/workspace';
import { requestApi } from '../plugins/requestApi';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { LineMetrics } from '@twin-platform/analytics-core';
import { StudioSession, type StudioTelemetry } from '../scene/studioSession';
import { DEFAULT_PLUGIN_IDS, entryFor, resolvePlugins } from '../plugins/catalog';
import { TwinSceneController, type CameraPreset, type TwinEntityView } from '../scene/TwinSceneController';
import { selectionCard, type SelectionCard } from '../scene/selectionCard';
import type { ThemeName } from '../scene/theme';
import { parseSceneDocument, sceneFileName, serializeSceneDocument, type TwinScene } from '@twin-platform/scene-schema';
import { createHttpStorage, pingServer } from '@twin-platform/storage-http';
import { resolveServerUrl } from '../scene/serverUrl';
import type { SceneSummary as StoredSceneSummary } from '@twin-platform/storage-contracts';
import ScenePanel, { type SceneExportPayload, type SceneImportOutcome, type ServerState } from './ScenePanel';
import DataSourcePanel from './DataSourcePanel';
import EventLogPanel from './EventLogPanel';
import TimelineBar, { type TimelineAuditMark } from './TimelineBar';
import PluginsPanel from './PluginsPanel';
import { defaultTab, inspectorTabs, sceneProfileOf, type SceneProfile } from '../scene/sceneProfile';
import MetricsPanel from './MetricsPanel';
import AuditPanel from './AuditPanel';
import ScenarioComparePanel from './ScenarioComparePanel';
import { runtimeInvariantsFor } from '@twin-platform/plugins-logistics';
import { auditScene, auditSpots, type AuditTarget, type SceneAuditView } from '../scene/sceneAudit';

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
 *   标签组由领域展示插件或通用回退画像提供；
 * - 领域应用挂到舞台与视口插槽，通用视口不解释领域状态；
 * - 画布上常驻的只有左上角一列小按钮，其余（遥测浮层、仿真控制条、区域列表）
 *   默认全部收起，点了才展开，把画面尽量让给场景。
 */

type EntityFilter = 'device' | 'cargo';

/** 属于"物料"的实体类型，其余都算设备。 */
const CARGO_KINDS = new Set(['parcel', 'pallet']);

/** 画布操作提示：只在区域浮层底部出现，不再常驻占一条高度。 */
const VIEW_HINT = '单指旋转 · 双指缩放/平移 · 轻点选中；鼠标拖动旋转、右键平移、滚轮缩放';

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
    new StudioSession(restoreScene(), undefined, resolvePlugins(untrack(activePlugins))),
  );
  /** 展示插件自行匹配场景；导入文档不会凭安装列表启用无关的领域 UI。 */
  const profileFor = (target: StudioSession): SceneProfile =>
    sceneProfileOf({
      plugins: target.host.list().filter((record) => record.state === 'active').map((record) => record.manifest.id),
      presentation: presentationFor(target),
    });
  const profile = (): SceneProfile => profileFor(session());
  const tabs = () => inspectorTabs(profile());
  let controller: TwinSceneController | undefined;
  let hostEl: HTMLDivElement | undefined;

  const [selected, setSelected] = createSignal<TwinEntityView>();
  const [entities, setEntities] = createSignal<TwinEntityView[]>([]);
  const [tab, setTab] = createSignal(untrack(() => defaultTab(profile())), { name: 'studio.inspectorTab' });
  const [mobileInspector, setMobileInspector] = createSignal(false, { name: 'studio.mobileInspector' });
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
  /**
   * 审计结论：和 CLI 同一个执行器算出来的报告，每 5 拍（~600ms）重算一次。
   * 不跟 60Hz、也不跟 8Hz 采样拍：不变量要扫事件日志，没必要每帧都扫一遍。
   */
  const [audit, setAudit] = createSignal<SceneAuditView>(
    untrack(() => auditScene(session().world, runtimeInvariantsFor(session().world.scene))),
  );
  /** 审计重算的节拍计数（不参与渲染）。 */
  let auditBeat = 0;
  /**
   * 正在从审计面板定位：此时选中实体**不**把检视区翻到实体页。
   * 否则一点定位，审计证据就从眼前消失了——飞相机跟看证据必须能同时发生。
   */
  let locating = false;
  const [telemetry, setTelemetry] = createSignal<StudioTelemetry>(untrack(() => session().telemetry()));
  /** 采样节拍：实体详情里的实时状态（货位、库存、当前任务）按它刷新。 */
  const [tick, setTick] = createSignal(0, { name: 'studio.tick' });
  const workspaceFor = (target: StudioSession): WorkspaceHandle => createWorkspace(presentationFor(target), {
    session: { world: target.world, controller: target.controller, host: target.host, request: requestApi },
    tick,
    closeInspector: () => setMobileInspector(false),
  });
  const [workspace, setWorkspace] = createSignal<WorkspaceHandle | undefined>(untrack(() => workspaceFor(session())), { name: 'studio.workspace' });
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
        // 但从审计面板定位过来的例外：证据面板得留在原地，只有相机飞过去。
        if (entity && !locating) {
          setTab('entity');
          setMobileInspector(true);
        }
      },
      {
        scene: target.world.scene,
        controller: target.controller,
        presentation: presentationFor(target)?.createScene,
        // 数字孪生只看不改：不传 onDragCommit，画布上的物体不可拖拽。
      },
    );
    // 插件可提供领域取景；否则按包围盒自动取景。
    controller.setCameraPreset('overview');
    setEntities(controller.entities);
    setTheme(controller.themeName);
    // 新建的控制器是一张白纸：把当前审计结论立刻画上去，不等下一次面板重算。
    stopTour();
    controller.setAuditSpots(untrack(spots));
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
    const previous = session();
    const oldWorkspace = workspace();
    // 先同步卸载旧插槽，使其清理不能在新会话启动后恢复旧世界的播放。
    setWorkspace(undefined);
    flush();
    oldWorkspace?.dispose();
    previous.controller.pause();
    setSession(next);
    setSelected(undefined);
    // 以下一律用 next，不读 session()（见 buildController 的注释）。
    buildController(next);
    setTab(defaultTab(profileFor(next)));
    setMobileInspector(false);
    setWorkspace(workspaceFor(next));
    // 换会话立刻重算一次：不等下一拍，否则新场景会在旧结论下停最多 600ms。
    auditBeat = 0;
    setLocateNote(undefined);
    setAudit(auditScene(next.world, runtimeInvariantsFor(next.world.scene)));
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
    // 模板场景的 id 也可能是库里录过的那个，所以一样要对齐。
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

  /**
   * 审计面板的定位提醒。回跳是按契约分叉：旧时间线之后的事件会被截断，
   * 于是守恒类不变量看上去“突然不守恒了”。那是真结果，但必须说明为什么，
   * 否则审计会自己吓自己。
   */
  const [locateNote, setLocateNote] = createSignal<string>();
  /** 审计巡演停在第几条违例；-1 表示没在巡演。 */
  const [tourIndex, setTourIndex] = createSignal(-1, { name: 'studio.auditTour' });

  /**
   * 时间轴定位的**唯一入口**。
   *
   * 两件事必须一起做，缺一件就出 bug：
   * 1. `seek()` 返回的帧差量要交给渲染层（`applyFrame`）。回跳是靠恢复快照 + 截断
   *    + 重算实现的，差量只在这一帧里；渲染循环的 `advance()` 事后问世界，
   *    拿到的 `removed` 已经是空的——不交回来，画面上就留着上一条时间线的货物。
   * 2. 定位完立刻重算一次审计：旧时间线被截断了，证据窗口已经变了，
   *    再等采样节拍（最多 600ms）就会把"上一窗口的结论"当成当前结论。
   */
  const seekTo = async (time: number): Promise<void> => {
    const frame = await session().controller.seek(time);
    controller?.applyFrame(frame);
    controller?.syncEntitiesFromWorld();
    auditBeat = 0;
    const current = session();
    setAudit(auditScene(current.world, runtimeInvariantsFor(current.world.scene)));
    setTick((value) => value + 1);
  };

  /**
   * 审计定位：把"证据"变成画面上的动作——回到那一刻，相机飞到那个实体。
   *
   * 两个顺序都是硬的：
   * - **先暂停再 seek**：位置是那一刻的证据，世界继续跑的话证据立刻就被冲走了；
   * - **先 seek 再选中**：要选的是**那一刻**的实体，不是现在的它
   *   （回跳后实体可能已经不在了，`selectEntity` 找不到就不装选中）。
   *
   * 回跳按回放规则就是分叉：恢复快照后重算，旧时间线之后的事件会被截断。
   * 这是"回到现场"的代价，也是它能被复现的原因。
   */
  /**
   * @param quiet 巡演里连续跳点，不再每跳一次都往面板里贴一条分叉提醒。
   */
  const locate = async (target: AuditTarget, quiet = false): Promise<void> => {
    const current = session();
    const before = current.world.time;
    current.controller.pause();
    if (target.at !== undefined) {
      try {
        await seekTo(target.at);
      } catch (error) {
        setServer((state) =>
          state ? { ...state, note: `定位失败：${error instanceof Error ? error.message : String(error)}` } : state,
        );
        return;
      }
      // seek 往回跳 = 分叉：事件游标回掤，旧时间线之后的记录按契约截断。
      if (!quiet) {
        setLocateNote(
          target.at < before - 1e-6
            ? `已回放到 t=${target.at.toFixed(2)}s（原 t=${before.toFixed(2)}s）：这是分叉回放，之后的事件已按契约截断，审计按新的证据窗口重算。`
            : undefined,
        );
      }
    }
    if (target.entityId) {
      locating = true;
      try {
        controller?.selectEntity(target.entityId);
      } finally {
        locating = false;
      }
      controller?.focusEntity(target.entityId);
    }
    setTick((value) => value + 1);
  };

  // ---------------------------------------------------------------------------
  // 审计在画面上的那一层：三维插旗 + 时间轴刻度 + 巡演
  // ---------------------------------------------------------------------------

  /**
   * 报告里有画面位置的违例。
   *
   * 判定还是 scene-audit 的，这里只是把结论翻译成画面位置。
   * 走不出位置的违例（缺失的那一环）不进这张表——它只属于面板里的文字。
   */
  const spots = createMemo(() => auditSpots(audit()), undefined);

  /** 轴上的刻度：只收有时刻的那些；id 里带上 check 与实体，点上去才知道点的是哪一条。 */
  const auditMarks = createMemo<TimelineAuditMark[]>(
    () =>
      spots().flatMap((spot) =>
        spot.at === undefined
          ? []
          : [
              {
                id: `${spot.checkId}|${spot.entityId ?? '-'}|${spot.at}`,
                t: spot.at,
                status: spot.severity,
                label: `${spot.check} · ${spot.message}`,
              },
            ],
      ),
    undefined,
  );
  const auditMarkId = createMemo(() => {
    const spot = spots()[tourIndex()];
    return spot?.at === undefined ? undefined : `${spot.checkId}|${spot.entityId ?? '-'}|${spot.at}`;
  }, undefined);

  /** 三维那一层随审计结论更新；换会话时在 buildController 里再推一次。 */
  createEffect(
    () => spots(),
    (list) => controller?.setAuditSpots(list),
  );

  /**
   * 审计巡演：把每一处违例按时间顺序演一遍——暂停、回溯到那一刻、相机落到那个实体。
   *
   * 手动上/下一个会打断自动播放：人一旦接手，上一轮的定时器就不该再拽镜头。
   */
  const DWELL_MS = 2600;
  let tourToken = 0;
  const stopTour = (): void => {
    tourToken += 1;
    setTourIndex(-1);
  };
  const showSpot = async (index: number): Promise<void> => {
    const list = spots();
    if (list.length === 0) return;
    tourToken += 1; // 手动优先：把还在跑的自动巡演停在这一处
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    setTourIndex(clamped);
    const spot = list[clamped];
    if (spot) await locate(spot, true);
  };
  const runTour = async (): Promise<void> => {
    const list = spots();
    if (list.length === 0) return;
    const token = ++tourToken;
    for (let index = 0; index < list.length; index += 1) {
      if (token !== tourToken) return;
      setTourIndex(index);
      const spot = list[index];
      if (spot) await locate(spot, true);
      if (token !== tourToken) return;
      await new Promise((resolve) => setTimeout(resolve, DWELL_MS));
    }
    if (token === tourToken) setTourIndex(-1);
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
    // 审计每 5 拍（~600ms）重算一次：要扫事件日志，没必要跟 8Hz 采样同频。
    // 先量后改：只有两条不变量、事件量级几千，600ms 已经足够看清趋势。
    auditBeat += 1;
    if (auditBeat % 5 === 0) setAudit(auditScene(current.world, runtimeInvariantsFor(current.world.scene)));
    setTick((value) => value + 1);
  };
  const timer = setInterval(() => void refresh(), 120);

  onCleanup(() => {
    clearInterval(timer);
    workspace()?.dispose();
    session().controller.pause();
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
   * 会把子树整个重挂（闪烁、丢失展开状态）。
   */
  const selectedCard = (): SelectionCard | undefined => {
    const entity = selected();
    if (!entity) return undefined;
    tick();
    return selectionCard(session().world, entity.id, controller?.codePath(entity.id));
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
    <main class={mobileInspector() ? 'studio-shell studio-inspecting' : 'studio-shell'}>
      <header class="studio-heading">
        <span class="brand">TWIN STUDIO</span>
        {/* 标题跟着场景走：导入外部布局后，这里显示的就是那个场景的名字。 */}
        <h1>{session().world.scene.name}</h1>
        <button
          type="button"
          class="mobile-inspector-toggle"
          aria-expanded={mobileInspector() ? 'true' : 'false'}
          aria-controls="studio-inspector"
          onClick={() => setMobileInspector(!mobileInspector())}
        >
          {mobileInspector() ? '收起面板' : profile().label ?? '详情 / 面板'}
        </button>
      </header>

      <div class="studio-grid">
        <section class="viewport-panel">
          <div class="viewport-frame">
            <div class="scene-stage">
            <div ref={mountViewport} class="viewport" aria-label="数字孪生三维场景" />

            {/* 画布左上角一列小按钮：区域 / 遥测 / 主题 / 仿真控制，各自点了才展开内容。 */}
            <div class="vp-toolbar" aria-label="视图工具">
              <button
                type="button"
                class={regions() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-expanded={regions() ? 'true' : 'false'}
                aria-label="选择区域 / 机位"
                title={`选择区域 / 机位（${VIEW_HINT}）`}
                onClick={() => setRegions(!regions())}
              >
                📷
              </button>
              <Show when={profile().id === 'logistics'}>
              <button
                type="button"
                class={hud() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={hud() ? 'true' : 'false'}
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
                aria-pressed={theme() === 'industrial' ? 'true' : 'false'}
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
              {/* 审计是张伟要给的主角：有违例就把入口摆在画布上，点开按时间顺序演一遍。 */}
              <Show when={spots().length > 0}>
                <button
                  type="button"
                  class={tourIndex() >= 0 ? 'vp-btn vp-btn-on' : 'vp-btn vp-btn-alert'}
                  aria-pressed={tourIndex() >= 0 ? 'true' : 'false'}
                  aria-label={tourIndex() >= 0 ? '结束审计巡演' : '播放审计巡演'}
                  title={
                    tourIndex() >= 0
                      ? '结束审计巡演'
                      : `审计巡演：依次回到 ${spots().length} 处违例的现场（暂停 + 回溯 + 相机落点）`
                  }
                  onClick={() => (tourIndex() >= 0 ? stopTour() : void runTour())}
                >
                  {tourIndex() >= 0 ? '✖' : '⚖'}
                  <span class="vp-badge">{spots().length}</span>
                </button>
              </Show>
              <button
                type="button"
                class={controls() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={controls() ? 'true' : 'false'}
                aria-label="显示 / 隐藏仿真控制条"
                title={controls() ? '收起仿真控制条' : '展开仿真控制条'}
                onClick={() => setControls(!controls())}
              >
                ⏱
              </button>
              <button
                type="button"
                class={tab() === 'scene' ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={tab() === 'scene' ? 'true' : 'false'}
                aria-label="场景导入导出"
                title={`场景导入 / 导出（当前：${session().sceneSource === 'imported' ? '外部导入' : '插件模板'}）`}
                onClick={() => {
                  const closing = tab() === 'scene' && mobileInspector();
                  setTab(closing ? defaultTab(profile()) : 'scene');
                  setMobileInspector(!closing);
                }}
              >
                🗂
              </button>
            </div>

            {/* 区域列表：点相机呼出，选一个就飞过去并关掉，不常驻占高度。 */}
            <Show when={regions()}>
              <>
                <div class="vp-backdrop" onPointerDown={() => setRegions(false)} />
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

            <Show when={hud() && profile().id === 'logistics'}>

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
            <Dynamic component={workspace()?.views.Stage} />
            </div>

            {/* 插件浮层保留原有布局插槽；会话切换时整体卸载。 */}
            <Dynamic component={workspace()?.views.Overlay} />

            {/* 巡演卡片：跟着当前这一条违例走，同时永远给出怎么定位到这里的理由。 */}
            <Show when={tourIndex() >= 0 && spots()[tourIndex()]}>
              {(spot) => (
                <div class="audit-tour" aria-label="审计巡演" aria-live="polite">
                  <div class="audit-tour-head">
                    <span class="audit-tour-step">
                      违例 {tourIndex() + 1} / {spots().length}
                    </span>
                    <strong>{spot().check}</strong>
                  </div>
                  <p class="audit-tour-msg">{spot().message}</p>
                  <p class="audit-tour-why">{spot().evidence}</p>
                  <div class="audit-tour-actions">
                    <button
                      type="button"
                      disabled={tourIndex() <= 0}
                      onClick={() => void showSpot(tourIndex() - 1)}
                    >
                      ← 上一处
                    </button>
                    <button
                      type="button"
                      disabled={tourIndex() >= spots().length - 1}
                      onClick={() => void showSpot(tourIndex() + 1)}
                    >
                      下一处 →
                    </button>
                    <button type="button" class="audit-tour-stop" onClick={stopTour}>
                      结束
                    </button>
                  </div>
                </div>
              )}
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
              onSeek={(time) => void seekTo(time)}
              onStep={(steps) => session().controller.stepFrames(steps)}
              onCollapse={() => setControls(false)}
              marks={auditMarks()}
              activeMarkId={auditMarkId()}
            />
          </Show>
        </section>

        <aside id="studio-inspector" class="inspector" aria-label="场景控制与实体详情">
          <div class="tab-bar" role="tablist" aria-label="检视面板">
            <For each={tabs()}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  class={tab() === item.id ? 'tab tab-active' : 'tab'}
                  aria-selected={tab() === item.id ? 'true' : 'false'}
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
                        <span class="part-id">partId：{entity().partId ?? '—'}</span>
                        <Show when={(card()?.stateLines.length ?? 0) > 0}>
                          <dl class="entity-state">
                            <For each={card()?.stateLines}>
                              {(line) => <dd>{line}</dd>}
                            </For>
                          </dl>
                        </Show>
                        <span class="code-path">渲染来源：{card()?.codePath ?? '—'}</span>
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
                  aria-pressed={filter() === 'device' ? 'true' : 'false'}
                  onClick={() => setFilter('device')}
                >
                  设备
                </button>
                <button
                  type="button"
                  class={filter() === 'cargo' ? 'seg seg-active' : 'seg'}
                  aria-pressed={filter() === 'cargo' ? 'true' : 'false'}
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

            <Show when={tab() === 'audit'}>
              <AuditPanel audit={audit()} notice={locateNote()} onLocate={(target) => void locate(target)} />
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
                  void seekTo(0).then(() => session().controller.play());
                  return loaded;
                }}
                onReset={() => {
                  session().useSimulation();
                  void seekTo(0);
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

            <Dynamic component={workspace()?.views.panels?.[tab()]} />

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
