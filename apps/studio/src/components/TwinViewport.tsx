import { createEffect, createMemo, createSignal, flush, For, onCleanup, onSettled, Show, untrack } from 'solid-js';
import { Dynamic } from '@solidjs/web';
import { presentationFor } from '../plugins/presentations';
import { createWorkspace, type WorkspaceHandle } from '../plugins/workspace';
import { requestApi } from '../plugins/requestApi';
import type { WorldEvent } from '@twin-platform/world-kernel';
import { seriesLatest, seriesTotal, type LineMetrics } from '@twin-platform/analytics-core';
import { StudioSession, type StudioTelemetry } from '../scene/studioSession';
import { DEFAULT_PLUGIN_IDS, entryFor, resolvePlugins } from '../plugins/catalog';
import { TwinSceneController, type CameraPreset, type TwinEntityView } from '../scene/TwinSceneController';
import { selectionCard, type SelectionCard } from '../scene/selectionCard';
import type { ThemeName } from '../scene/theme';
import { diffScenes, parseSceneDocument, sceneFileName, serializeSceneDocument, type TwinScene } from '@twin-platform/scene-schema';
import { createHttpStorage, pingServer } from '@twin-platform/storage-http';
import { resolveServerUrl } from '../scene/serverUrl';
import ScenePanel, {
  type SceneExportPayload,
  type SceneHistoryState,
  type SceneImportOutcome,
  type ServerState,
} from './ScenePanel';
import DataSourcePanel from './DataSourcePanel';
import EventLogPanel from './EventLogPanel';
import TimelineBar, { type TimelineAuditMark, type TimelineLens } from './TimelineBar';
import PluginsPanel from './PluginsPanel';
import { defaultTab, inspectorTabs, sceneProfileOf, type SceneProfile } from '../scene/sceneProfile';
import AuditPanel from './AuditPanel';
import ScenarioComparePanel from './ScenarioComparePanel';
import { runtimeInvariantsFor } from '@twin-platform/plugins-logistics';
import { auditScene, auditSpots, type AuditTarget, type SceneAuditView } from '../scene/sceneAudit';
import Icon, { isIconName } from './Icon';
import { VIEWPORT_BACKDROP } from '../viewportBackdrop';
import { FOCUSABLE_SELECTOR, handleTabKeys, isTypingTarget, trapTabKey } from '../ui/keyboard';
import { ENTITY_STATUS_LABEL, entityStatus, type EntityStatus } from '../scene/entityStatus';

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
 * - 画布上常驻的只有左上角一列小按钮与底部时间轴，其余（遥测浮层、区域列表）
 *   默认收起，点了才展开，把画面尽量让给场景。
 */

type EntityFilter = 'device' | 'cargo';

/** 属于"物料"的实体类型，其余都算设备。静态成员表用 Record，不用 Set。 */
const CARGO_KINDS: Record<string, true> = { parcel: true, pallet: true };

/** 画布操作提示：只在区域浮层底部出现，不再常驻占一条高度。 */
const VIEW_HINT = '单指旋转 · 双指缩放/平移 · 轻点选中；鼠标拖动旋转、右键平移、滚轮缩放';

/** 胶囊浮岛的时间读数：`mm:ss.d`，位数固定，跳动时不抖。 */
const clockText = (seconds: number): string =>
  `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}s`;

/**
 * 把「键：值」一行拆成属性网格的两列（`describeEntityState` 的行都是这个格式）。
 * 没有冒号的整行进值列，键列留空。
 */
function splitStateLine(line: string): [string, string] {
  const at = line.indexOf('：');
  return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : ['', line];
}

/** 区域 / 机位：点工具条上的相机按钮呼出。 */
const REGIONS: { id: CameraPreset; label: string }[] = [
  { id: 'overview', label: '全局' },
  { id: 'infeed', label: '入料' },
  { id: 'inspection', label: '质检' },
  { id: 'sorter', label: '分拣' },
  { id: 'warehouse', label: '立库' },
  { id: 'aisle', label: '巷道' },
  { id: 'outfeed', label: '出库' },
  { id: 'external', label: '外部' },
];

// ---------------------------------------------------------------------------
// 上次选择的记忆（localStorage）：插件集与场景文档分开存。
// 场景存的是**完整文档**而不是 id——纯静态部署没有服务端，也能原样恢复。
// ---------------------------------------------------------------------------

const PLUGIN_MEMORY_KEY = 'twin.plugins.v1';
const SCENE_MEMORY_KEY = 'twin.scene.v1';
const THEME_MEMORY_KEY = 'twin.theme.v1';

/** 恢复上次的设备涂装；值不合法就回落到默认档。 */
function restoreTheme(): ThemeName {
  if (typeof localStorage === 'undefined') return 'pastel';
  try {
    return localStorage.getItem(THEME_MEMORY_KEY) === 'industrial' ? 'industrial' : 'pastel';
  } catch {
    return 'pastel';
  }
}

function rememberTheme(name: ThemeName): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(THEME_MEMORY_KEY, name);
  } catch {
    // 配额满 / 隐私模式：记不住就不记。
  }
}

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
  /** 每个检视页记住自己的滚动位置：切回来时人还在原处，不被重置到顶部。 */
  let tabPanelEl: HTMLDivElement | undefined;
  const tabScroll = new Map<string, number>();
  const selectTab = (id: string): void => {
    const current = tab();
    if (id === current) return;
    if (tabPanelEl) tabScroll.set(current, tabPanelEl.scrollTop);
    setTab(id);
    flush();
    if (tabPanelEl) tabPanelEl.scrollTop = tabScroll.get(id) ?? 0;
  };
  const [mobileInspector, setMobileInspector] = createSignal(false, { name: 'studio.mobileInspector' });
  const [filter, setFilter] = createSignal<EntityFilter>('device');
  /** 遥测浮层：默认**收起**，点工具条的小按钮才显示（"隐藏浮层"的默认值）。 */
  const [hud, setHud] = createSignal(false);
  /** 区域 / 机位浮层：点相机按钮呼出，选完即关。 */
  const [regions, setRegions] = createSignal(false);
  const [theme, setTheme] = createSignal<ThemeName>(restoreTheme());
  /**
   * 渲染节拍的**实测**值：由控制器的 `onStats` 回调（半秒一个窗口）喂进来。
   * 初值 0 = 还没测到；HUD 在 0 的时候不显示帧率，宁缺毋假。
   */
  const [stats, setStats] = createSignal({ fps: 0, frameMs: 0 }, { name: 'studio.stats' });
  /** 卡片头上的复制微反馈：记下刚复制了什么，1.6s 后自己消失。 */
  const [copied, setCopied] = createSignal<string>();
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const markCopied = (note: string): void => {
    setCopied(note);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(undefined), 1600);
  };
  /** 时间轴展开抽屉透镜：审计 / 事件 / 方案对比 */
  const [activeTimelineLens, setActiveTimelineLens] = createSignal<TimelineLens>();
  /** 方案对比分叉时刻（秒），在时间轴上画出分叉指示 */
  const [compareFork, setCompareFork] = createSignal<number>();
  /**
   * 右上角指标浮岛：桌面默认展开（三块独立磨砂卡，不挡画布主体）；
   * 手机档画布只有两三百像素高，默认收起，要看点工具栏再展开。
   */
  const [metricsFloating, setMetricsFloating] = createSignal(
    window.matchMedia?.('(max-width: 760px)').matches !== true,
  );
  /** 场景与插件悬浮切换层 */
  const [switchPopover, setSwitchPopover] = createSignal<'scene' | 'plugins' | false>(false);
  /** 剩余配置弹窗：外部数据源 / 场景高级文件管理 */
  const [configModal, setConfigModal] = createSignal<'data' | 'scene' | false>(false);
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
    markCopied(note);
    const current = menu();
    if (current) setMenu({ ...current, note });
  };

  const openMenu = (event: MouseEvent, entity: TwinEntityView): void => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, entity });
  };

  /**
   * 浮层的焦点契约：打开时把焦点送进去，关闭时送回触发它的控件。
   * 弹窗用 `container`（先让读屏念标题），轻量浮层用 `first`（直接落到第一项）。
   */
  let modalEl: HTMLDivElement | undefined;
  let menuEl: HTMLDivElement | undefined;
  let regionsEl: HTMLDivElement | undefined;
  let switchEl: HTMLDivElement | undefined;
  const useOverlayFocus = (
    isOpen: () => boolean,
    root: () => HTMLElement | undefined,
    initial: 'first' | 'container' = 'first',
  ): void => {
    let wasOpen = false;
    let returnFocus: HTMLElement | null = null;
    createEffect(
      () => isOpen(),
      (open) => {
        if (open && !wasOpen) {
          wasOpen = true;
          returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          queueMicrotask(() => {
            const el = root();
            if (!el) return;
            if (initial === 'container') el.focus();
            else {
              const first = el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
              if (first) first.focus();
              else el.focus();
            }
          });
        } else if (!open && wasOpen) {
          wasOpen = false;
          returnFocus?.focus();
          returnFocus = null;
        }
      },
    );
  };
  useOverlayFocus(() => Boolean(configModal()), () => modalEl, 'container');
  useOverlayFocus(() => Boolean(menu()), () => menuEl);
  useOverlayFocus(() => regions(), () => regionsEl);
  useOverlayFocus(() => Boolean(switchPopover()), () => switchEl);

  /** Esc 的关闭顺序：先关最上层的临时层，再关常驻面板；永远只做一件事。 */
  const closeTopLayer = (): boolean => {
    if (menu()) {
      setMenu(null);
      return true;
    }
    if (configModal()) {
      setConfigModal(false);
      return true;
    }
    if (switchPopover()) {
      setSwitchPopover(false);
      return true;
    }
    if (regions()) {
      setRegions(false);
      return true;
    }
    if (activeTimelineLens()) {
      setActiveTimelineLens(undefined);
      return true;
    }
    if (selected()) {
      setSelected(undefined);
      return true;
    }
    // 指标浮岛默认就是开的：它是常驻卡，排在临时层后面。
    if (metricsFloating()) {
      setMetricsFloating(false);
      return true;
    }
    if (mobileInspector()) {
      setMobileInspector(false);
      return true;
    }
    return false;
  };

  /**
   * 全局键盘：Esc 逐层关闭；空格播放/暂停；左右单步。
   *
   * 播放键只在焦点不落在控件上时接管——按钮上的空格属于按钮自己，
   * 否则一次空格会同时点击按钮和切换播放。
   */
  const onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape') {
      if (closeTopLayer()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (menu() || configModal()) return;

    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      const controller = session().controller;
      if (controller.playing) controller.pause();
      else controller.play();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const controller = session().controller;
      const frames = event.shiftKey ? 30 : 1;
      controller.pause();
      if (event.key === 'ArrowRight') controller.stepFrames(frames);
      else void seekTo(Math.max(0, view().time - frames * session().world.stepSize));
    }
  };
  if (typeof window !== 'undefined') window.addEventListener('keydown', onWindowKeyDown);
  onCleanup(() => window.removeEventListener('keydown', onWindowKeyDown));

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
          selectTab('entity');
          setMobileInspector(true);
        }
      },
      {
        scene: target.world.scene,
        controller: target.controller,
        presentation: presentationFor(target)?.createScene,
        // 数字孪生只看不改：不传 onDragCommit，画布上的物体不可拖拽。
        // 帧率/帧耗时走真实测量，胶囊浮岛只报控制器测到的数。
        onStats: setStats,
      },
    );
    // 插件可提供领域取景；否则按包围盒自动取景。
    controller.setCameraPreset('overview');
    setEntities(controller.entities);
    // 涂装是用户偏好：上次选的工业档在重建控制器后也要接着用。
    const activeTheme = untrack(theme);
    controller.setTheme(activeTheme);
    setTheme(activeTheme);
    // 视口底色与界面同色（明亮档），否则视口边缘会露出一圈不同色的框。
    controller.setBackdrop(VIEWPORT_BACKDROP);
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
    tabScroll.clear();
    if (tabPanelEl) tabPanelEl.scrollTop = 0;
    setMobileInspector(false);
    setWorkspace(workspaceFor(next));
    // 换会话立刻重算一次：不等下一拍，否则新场景会在旧结论下停最多 600ms。
    auditBeat = 0;
    setLocateNote(undefined);
    setSceneHistory(undefined);
    setAudit(auditScene(next.world, runtimeInvariantsFor(next.world.scene)));
  };

  const [sceneHistory, setSceneHistory] = createSignal<SceneHistoryState>();

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

  /** 打开某个场景的版本历史（已展开则收起）。 */
  const toggleSceneHistory = async (id: string): Promise<void> => {
    if (untrack(sceneHistory)?.sceneId === id) {
      setSceneHistory(undefined);
      return;
    }
    await openSceneHistory(id);
  };

  const openSceneHistory = async (id: string): Promise<void> => {
    const storage = serverStorage();
    if (!storage) return;
    setSceneHistory({ sceneId: id, versions: [], busy: true });
    try {
      const versions = await storage.scenes.listVersions(id);
      setSceneHistory((current) => (current && current.sceneId === id ? { ...current, versions, busy: false } : current));
    } catch (error) {
      setSceneHistory((current) =>
        current && current.sceneId === id
          ? { ...current, busy: false, note: `读取版本失败：${error instanceof Error ? error.message : String(error)}` }
          : current,
      );
    }
  };

  /** 对比"当前文档 → 选中版本"：列出的就是回滚会改的东西。 */
  const showVersionDiff = async (id: string, version: number): Promise<void> => {
    const storage = serverStorage();
    const current = untrack(sceneHistory);
    if (!storage || !current || current.sceneId !== id) return;
    setSceneHistory({ ...current, selected: version, diff: undefined, busy: true });
    try {
      const [target, latest] = await Promise.all([
        storage.scenes.getVersion(id, version),
        storage.scenes.getScene(id),
      ]);
      if (!target || !latest) throw new Error(`版本 v${version} 不存在。`);
      setSceneHistory((state) =>
        state && state.sceneId === id
          ? { ...state, selected: version, diff: diffScenes(latest, target), busy: false }
          : state,
      );
    } catch (error) {
      setSceneHistory((state) =>
        state && state.sceneId === id
          ? { ...state, busy: false, note: `读取版本失败：${error instanceof Error ? error.message : String(error)}` }
          : state,
      );
    }
  };

  /**
   * 回滚：把旧版本的文档**作为新版本**写回去，历史只增不减。
   * 回滚后重建会话，事件序号仍然先对齐再开跑（走 `adoptSession`）。
   */
  const rollbackSceneVersion = async (id: string, version: number): Promise<void> => {
    const storage = serverStorage();
    if (!storage) return;
    await withBusy('回滚', async () => {
      const scene = await storage.scenes.getVersion(id, version);
      if (!scene) throw new Error(`服务端上没有 v${version}。`);
      const summary = await storage.scenes.putScene(scene);
      const next = new StudioSession(scene, storage, resolvePlugins(activePlugins()), { autoPlay: false });
      rememberScene(scene);
      await adoptSession(next, storage);
      return `已回滚到 v${version}，当前版本 v${summary.version}。`;
    });
    // replaceSession 清空了历史面板，这里按回滚后的场景重新展开。
    await openSceneHistory(id);
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
        if (target.at < before - 1e-6) {
          setLocateNote(
            `已回溯至 t=${target.at.toFixed(2)}s（基准 t=${before.toFixed(2)}s）· 观察窗已按回溯时刻同步重算`,
          );
          setActiveTimelineLens('audit');
        } else {
          setLocateNote(undefined);
        }
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
      ? all.filter((entity) => CARGO_KINDS[entity.kind] !== true)
      : all.filter((entity) => CARGO_KINDS[entity.kind] === true);
  };

  /**
   * 列表行的状态点：只读世界真实 attrs（背压 > 忙 > 任务 > 卡车 > 设备态），读不到就是空闲。
   * 只允许在 JSX 里调（那是追踪作用域）；在 <For> 的回调体里直接读 session() 会被诊断判为未跟踪。
   */
  const statusOf = (id: string): EntityStatus => entityStatus(session().world.getEntity(id));

  return (
    <main class={mobileInspector() ? 'studio-shell studio-inspecting' : 'studio-shell'}>
      <header class="studio-heading">
        <span class="brand">TWIN STUDIO</span>
        {/* 标题跟着场景走：导入外部布局后，这里显示的就是那个场景的名字。 */}
        <h1>{session().world.scene.name}</h1>
        {/* 界面只有明亮一档：暗色档暂缓，不做半成品，所以这里没有明暗切换。 */}
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
          {/* 透镜抽屉展开时，画布底部的胶囊与实体卡让位：抽屉自带播放条，且卡片会压住审计正文。 */}
          <div class={activeTimelineLens() ? 'viewport-frame lens-open' : 'viewport-frame'}>
            <div class="scene-stage">
            <div ref={mountViewport} class="viewport" aria-label="数字孪生三维场景" />

            {/* 画布左上角药丸工具条：区域 / 指标看板 / 场景插件 / 涂装 / 遥测 / 巡演 / 配置 */}
            <div class="vp-toolbar" aria-label="视图工具">
              <button
                type="button"
                class={regions() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-expanded={regions() ? 'true' : 'false'}
                aria-label="选择区域 / 机位"
                title={`选择区域 / 机位（${VIEW_HINT}）`}
                onClick={() => setRegions(!regions())}
              >
                <Icon name="camera" />
              </button>
              <button
                type="button"
                class={metricsFloating() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={metricsFloating() ? 'true' : 'false'}
                aria-label="指标看板悬浮窗"
                title={metricsFloating() ? '关闭指标看板' : '弹出指标看板'}
                onClick={() => setMetricsFloating(!metricsFloating())}
              >
                <Icon name="bars" />
              </button>
              <button
                type="button"
                class={switchPopover() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={switchPopover() ? 'true' : 'false'}
                aria-label="场景与插件切换"
                title="场景与插件悬浮切换"
                onClick={() => setSwitchPopover(switchPopover() ? false : 'scene')}
              >
                <Icon name="folder" />
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
                  <Icon name="radar" />
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
                  rememberTheme(next);
                }}
              >
                <Icon name="palette" />
              </button>
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
                  <Icon name={tourIndex() >= 0 ? 'close' : 'shield'} />
                  <span class="vp-badge">{spots().length}</span>
                </button>
              </Show>
              <button
                type="button"
                class={configModal() ? 'vp-btn vp-btn-on' : 'vp-btn'}
                aria-pressed={configModal() ? 'true' : 'false'}
                aria-label="系统与数据配置"
                title="数据源与场景高级配置"
                onClick={() => setConfigModal(configModal() ? false : 'data')}
              >
                <Icon name="settings" />
              </button>
            </div>

            {/* 时间胶囊浮岛：画布底部正中，只放一眼要看的东西。
                帧率/帧耗时是控制器每半秒实测的，没测到就整块不显示——不摆假数字。 */}
            <div class="vp-hud" aria-label="播放状态">
              <span class="hud-dot" data-playing={view().playing ? 'true' : 'false'} />
              <b class="hud-time">{clockText(view().time)}</b>
              <Show when={stats().fps > 0}>
                <span class="hud-sep" />
                <span class="hud-metric">{stats().fps.toFixed(0)} FPS</span>
                <span class="hud-metric muted">帧 {stats().frameMs.toFixed(1)}ms</span>
              </Show>
            </div>

            {/* 区域列表：点相机呼出，选一个就飞过去并关掉，不常驻占高度。 */}
            <Show when={regions()}>
              <>
                <div class="vp-backdrop" onPointerDown={() => setRegions(false)} />
                <div class="vp-popover" aria-label="选择区域" ref={(el) => (regionsEl = el)}>
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
                          {region.label}
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
                <h3>Sim Telemetry · t = {view().time.toFixed(1)}s</h3>
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
            {/* 设备详情：选中实体时浮在画布**右下角**，不抢右上角的指标视线 */}
            <Show when={selected()}>
              {(entity) => {
                const card = selectedCard;
                return (
                  <aside class="floating-entity-card" aria-label="设备详情悬浮窗">
                    <div class="ed-head">
                      <span
                        class="ed-title"
                        onContextMenu={(event) => openMenu(event, entity())}
                        title="右键可复制名字 / ID"
                      >
                        {card()?.label ?? entity().label}
                      </span>
                      <span class="ed-actions">
                        <button
                          type="button"
                          class="icon-btn"
                          aria-label="复制实体 ID"
                          title="复制实体 ID"
                          onClick={() => void copyText(entity().id, '已复制 ID')}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                        <button
                          type="button"
                          class="icon-btn"
                          aria-label="在场景中定位"
                          title="在场景中定位"
                          onClick={() => controller?.focusEntity(entity().id)}
                        >
                          <Icon name="locate" size={13} />
                        </button>
                        <button
                          type="button"
                          class="icon-btn ed-close-btn"
                          aria-label="关闭设备详情"
                          title="关闭详情卡"
                          onClick={() => setSelected(undefined)}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      </span>
                    </div>
                    <div class="ed-sub">
                      <span class="ed-kind">{card()?.kind ?? entity().kind}</span>
                      <span class="ed-id">{entity().id}</span>
                    </div>
                    <div class="ed-sub">
                      <span class={entity().partId ? 'part-id' : 'part-id is-none'}>
                        partId：{entity().partId ?? '—'}
                      </span>
                      <span class="badge-src">来源 mesh.name</span>
                      <Show when={entity().partId}>
                        <button
                          type="button"
                          class="icon-btn"
                          aria-label="复制件号"
                          title="复制件号"
                          onClick={() => void copyText(entity().partId ?? '', '已复制件号')}
                        >
                          <Icon name="copy" size={13} />
                        </button>
                      </Show>
                      <Show when={copied()}>
                        <span class="ed-copied">{copied()}</span>
                      </Show>
                    </div>
                    <Show when={(card()?.stateLines.length ?? 0) > 0}>
                      <dl class="entity-state">
                        <For each={card()?.stateLines}>
                          {(line) => {
                            const [key, value] = splitStateLine(line);
                            return (
                              <>
                                <dt>{key}</dt>
                                <dd>{value}</dd>
                              </>
                            );
                          }}
                        </For>
                      </dl>
                    </Show>
                    <span class="code-path">渲染来源：{card()?.codePath ?? '—'}</span>
                  </aside>
                );
              }}
            </Show>

            {/* 右上角指标浮岛：三块各自独立的磨砂玻璃卡，不堆进一张大卡片。
                数字全部来自 session().metrics()（analytics-core 实算），没有就不摆。 */}
            <Show when={metricsFloating()}>
              <div class="metric-pods" aria-label="产线指标看板">
                <div class="metric-pod">
                  <div class="pod-head">
                    <span class="pod-title">
                      <Icon name="bars" size={12} />
                      产线实时
                    </span>
                    <button
                      type="button"
                      class="pod-close"
                      aria-label="关闭指标看板"
                      title="收起指标浮岛"
                      onClick={() => setMetricsFloating(false)}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                  <div class="pod-kpis">
                    <div class="pod-kpi">
                      <b>{seriesTotal(metrics().throughput).toFixed(0)}</b>
                      <span>吞吐（件）</span>
                    </div>
                    <div class="pod-kpi">
                      <b>{seriesLatest(metrics().backlog).toFixed(0)}</b>
                      <span>积压（件）</span>
                    </div>
                  </div>
                </div>

                <Show when={metrics().utilization.length > 0}>
                  <div class="metric-pod">
                    <div class="pod-head">
                      <span class="pod-title">设备利用率</span>
                    </div>
                    <ul class="pod-rows">
                      <For each={metrics().utilization.slice(0, 4)}>
                        {(row) => (
                          <li>
                            <span class="pod-name">{row.entityId}</span>
                            <span class="pod-bar" aria-hidden="true">
                              <span style={{ width: `${Math.min(row.utilization, 1) * 100}%` }} />
                            </span>
                            <span class="pod-num">{(row.utilization * 100).toFixed(0)}%</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>

                <Show when={metrics().downtime.length > 0}>
                  <div class="metric-pod">
                    <div class="pod-head">
                      <span class="pod-title">停机</span>
                    </div>
                    <ul class="pod-rows">
                      <For each={metrics().downtime.slice(0, 3)}>
                        {(row) => (
                          <li>
                            <span class="pod-name">{row.entityId}</span>
                            <span class="pod-num">
                              {row.downtime.toFixed(1)}s · {row.occurrences} 次
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </div>
                </Show>
              </div>
            </Show>

            {/* 场景与插件悬浮切换层 */}
            <Show when={switchPopover()}>
              <>
                <div class="vp-backdrop" onPointerDown={() => setSwitchPopover(false)} />
                <div class="floating-switch-popover" aria-label="场景与插件切换" ref={(el) => (switchEl = el)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setSwitchPopover(false); } trapTabKey(e, switchEl); }}>
                  <div class="floating-switch-head">
                    <div
                      class="segmented"
                      role="tablist"
                      aria-label="场景与插件"
                      onKeyDown={(e) =>
                        handleTabKeys(
                          e,
                          ['scene', 'plugins'] as const,
                          switchPopover() || undefined,
                          (id) => setSwitchPopover(id),
                        )
                      }
                    >
                      <button
                        type="button"
                        role="tab"
                        class={switchPopover() === 'scene' ? 'seg seg-active' : 'seg'}
                        aria-selected={switchPopover() === 'scene' ? 'true' : 'false'}
                        tabindex={switchPopover() === 'scene' ? 0 : -1}
                        onClick={() => setSwitchPopover('scene')}
                      >
                        场景预设
                      </button>
                      <button
                        type="button"
                        role="tab"
                        class={switchPopover() === 'plugins' ? 'seg seg-active' : 'seg'}
                        aria-selected={switchPopover() === 'plugins' ? 'true' : 'false'}
                        tabindex={switchPopover() === 'plugins' ? 0 : -1}
                        onClick={() => setSwitchPopover('plugins')}
                      >
                        插件生态
                      </button>
                    </div>
                    <button
                      type="button"
                      class="icon-btn"
                      aria-label="关闭切换面板"
                      onClick={() => setSwitchPopover(false)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>

                  <div class="floating-switch-body">
                    <Show when={switchPopover() === 'scene'}>
                      <div class="switch-scene-section">
                        <div class="switch-scene-info">
                          <span class="switch-info-label">当前场景</span>
                          <strong class="switch-info-name">{session().world.scene.name}</strong>
                          <span class="switch-info-meta">
                            ID: {session().world.scene.id} · 来源: {session().sceneSource === 'imported' ? '外部导入' : '内置模板'}
                          </span>
                        </div>
                        <div class="switch-actions">
                          <button
                            type="button"
                            class="btn-secondary"
                            onClick={() => {
                              resetScene();
                              setSwitchPopover(false);
                            }}
                          >
                            还原为默认模板场景
                          </button>
                          <button
                            type="button"
                            class="btn-secondary"
                            onClick={() => {
                              setSwitchPopover(false);
                              setConfigModal('scene');
                            }}
                          >
                            导入 / 导出 / 云端同步…
                          </button>
                        </div>
                      </div>
                    </Show>

                    <Show when={switchPopover() === 'plugins'}>
                      <div class="switch-plugins-section">
                        <PluginsPanel host={session().host} activeIds={activePlugins()} onChange={applyPlugins} />
                      </div>
                    </Show>
                  </div>
                </div>
              </>
            </Show>

            {/* 剩余配置弹窗：外部数据源与场景高级文件/服务端管理 */}
            <Show when={configModal()}>
              <>
                <div class="studio-modal-backdrop" onPointerDown={() => setConfigModal(false)} />
                <div
                  class="studio-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-label="数据与场景高级配置"
                  tabindex={-1}
                  ref={(el) => (modalEl = el)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setConfigModal(false);
                    }
                    trapTabKey(e, modalEl);
                  }}
                >
                  <div class="studio-modal-head">
                    <div
                      class="modal-tabs"
                      role="tablist"
                      onKeyDown={(e) =>
                        handleTabKeys(
                          e,
                          ['data', 'scene'] as const,
                          configModal() || undefined,
                          (id) => setConfigModal(id),
                        )
                      }
                    >
                      <button
                        type="button"
                        role="tab"
                        class={configModal() === 'data' ? 'modal-tab is-active' : 'modal-tab'}
                        aria-selected={configModal() === 'data' ? 'true' : 'false'}
                        tabindex={configModal() === 'data' ? 0 : -1}
                        onClick={() => setConfigModal('data')}
                      >
                        <Icon name="database" size={14} />
                        <span>外部数据源</span>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        class={configModal() === 'scene' ? 'modal-tab is-active' : 'modal-tab'}
                        aria-selected={configModal() === 'scene' ? 'true' : 'false'}
                        tabindex={configModal() === 'scene' ? 0 : -1}
                        onClick={() => setConfigModal('scene')}
                      >
                        <Icon name="folder" size={14} />
                        <span>场景管理与云端</span>
                      </button>
                    </div>
                    <button
                      type="button"
                      class="icon-btn modal-close"
                      aria-label="关闭配置弹窗"
                      onClick={() => setConfigModal(false)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>

                  <div class="studio-modal-body">
                    <Show when={configModal() === 'data'}>
                      <DataSourcePanel
                        onLoad={(text) => {
                          const loaded = session().loadCsv(text);
                          void seekTo(0).then(() => session().controller.play());
                          setConfigModal(false);
                          return loaded;
                        }}
                        onReset={() => {
                          session().useSimulation();
                          void seekTo(0);
                          setConfigModal(false);
                        }}
                      />
                    </Show>

                    <Show when={configModal() === 'scene'}>
                      <ScenePanel
                        sceneId={session().world.scene.id}
                        sceneName={session().world.scene.name}
                        source={session().sceneSource}
                        summary={session().describeScene()}
                        unknownKinds={session().drivableKinds().unknown}
                        onImport={(raw) => {
                          const res = importScene(raw);
                          if (res.ok) setConfigModal(false);
                          return res;
                        }}
                        onExport={exportScene}
                        onReset={() => {
                          resetScene();
                          setConfigModal(false);
                        }}
                        server={server()}
                        onSaveToServer={saveToServer}
                        onLoadFromServer={async (id) => {
                          await loadFromServer(id);
                          setConfigModal(false);
                        }}
                        onDeleteFromServer={deleteFromServer}
                        onRefreshServer={refreshServerScenes}
                        history={sceneHistory()}
                        onListVersions={toggleSceneHistory}
                        onShowVersionDiff={showVersionDiff}
                        onRollbackVersion={rollbackSceneVersion}
                      />
                    </Show>
                  </div>
                </div>
              </>
            </Show>
          </div>

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
            marks={auditMarks()}
            activeMarkId={auditMarkId()}
            activeLens={activeTimelineLens()}
            onLensChange={setActiveTimelineLens}
            failingCount={audit().counts.fail + audit().counts.error}
            eventCount={view().events.length}
            compareForkAt={compareFork()}
            recentEvents={view().events}
          >
            <Show when={activeTimelineLens() === 'audit'}>
              <div class="tl-drawer-audit">
                <Show when={spots().length > 0}>
                  <div class="tl-audit-tour-bar">
                    <button
                      type="button"
                      class="btn-sm btn-secondary"
                      onClick={() => (tourIndex() >= 0 ? stopTour() : void runTour())}
                    >
                      <Icon name={tourIndex() >= 0 ? 'close' : 'shield'} size={12} />
                      <span>{tourIndex() >= 0 ? '结束审计巡演' : `依次回到 ${spots().length} 处违例现场`}</span>
                    </button>
                  </div>
                </Show>
                <AuditPanel
                  audit={audit()}
                  notice={locateNote()}
                  onCloseNotice={() => setLocateNote(undefined)}
                  onLocate={(target) => void locate(target)}
                />
              </div>
            </Show>

            <Show when={activeTimelineLens() === 'events'}>
              <EventLogPanel events={view().events} stored={view().stored} />
            </Show>

            <Show when={activeTimelineLens() === 'compare'}>
              <ScenarioComparePanel
                currentTime={view().time}
                onCompare={(forkAt, horizon, zoneB) => session().compare(forkAt, horizon, zoneB)}
                onForkMark={(forkAt) => setCompareFork(forkAt)}
              />
            </Show>
          </TimelineBar>
        </section>

        <aside id="studio-inspector" class="inspector" aria-label="场景控制与实体详情">
          {/* 标签条：左侧是互斥页签，右侧「更多」打开高级配置弹窗。 */}
          <div class="tab-bar">
            <div
              class="tab-list"
              role="tablist"
              aria-label="检视面板"
              onKeyDown={(e) => handleTabKeys(e, tabs().map((t) => t.id), tab(), selectTab)}
            >
              <For each={tabs()}>
                {(item) => {
                  // 页签自带 icon 字符串：是本站图标名就用线性图标，否则退回它的字形。
                  const glyph = isIconName(item.icon) ? item.icon : undefined;
                  return (
                    <button
                      type="button"
                      role="tab"
                      class={tab() === item.id ? 'tab tab-active' : 'tab'}
                      aria-selected={tab() === item.id ? 'true' : 'false'}
                      aria-label={item.label}
                      title={item.label}
                      onClick={() => selectTab(item.id)}
                      tabindex={tab() === item.id ? 0 : -1}
                    >
                      {glyph ? <Icon name={glyph} /> : <span aria-hidden="true">{item.icon}</span>}
                    </button>
                  );
                }}
              </For>
            </div>
            <button
              type="button"
              class="tab tab-more"
              aria-label="更多功能"
              title="外部数据源 / 场景文件与云端同步"
              onClick={() => setConfigModal('data')}
            >
              <Icon name="more" />
            </button>
          </div>

          {/* 六个面板互斥：同一时刻只有一个被渲染，不会堆成一长条。 */}
          <div class="tab-panel" ref={(el) => (tabPanelEl = el)}>
            <Show when={tab() === 'entity'}>
              {/* 选中详情已搬到画布右下角的悬浮卡（.floating-entity-card）：
                  同一份数据不在这里再铺一遍。这里只留“挑实体”。 */}
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
                      class={{ selected: selected()?.id === entity.id }}
                      onClick={() => controller?.selectEntity(entity.id)}
                      onContextMenu={(event) => openMenu(event, entity)}
                      title={`${entity.label} · ${ENTITY_STATUS_LABEL[statusOf(entity.id)]}（右键可复制）`}
                    >
                      <span class={{ 'st-dot': true, [`st-${statusOf(entity.id)}`]: true }} aria-hidden="true" />
                      <span class="st-name">{entity.label}</span>
                      <span class="st-id">{entity.id}</span>
                    </button>
                  )}
                </For>
              </div>
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
              role="menu"
              aria-label={`${menu()?.entity.label ?? ''} 操作`}
              ref={(el) => (menuEl = el)}
              style={{
                left: `${Math.max(8, Math.min((menu()?.x ?? 0), window.innerWidth - 200))}px`,
                top: `${Math.max(8, Math.min((menu()?.y ?? 0), window.innerHeight - 180))}px`,
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); setMenu(null); }
                trapTabKey(e, menuEl);
              }}
            >
              <div class="ctx-title" title={state().entity.id}>
                {state().entity.label}
              </div>
              <button type="button" role="menuitem" onClick={() => void copyText(state().entity.label, '已复制名字')}>
                复制名字
              </button>
              <button type="button" role="menuitem" onClick={() => void copyText(state().entity.id, '已复制 ID')}>
                复制 ID
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void copyText(controller?.codePath(state().entity.id) ?? '', '已复制渲染来源')}
              >
                复制渲染来源
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
