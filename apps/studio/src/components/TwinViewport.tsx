import { createSignal, For, onCleanup, onSettled, Show, untrack } from 'solid-js';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { LineMetrics } from '@twin-platform/analytics-core';
import { StudioSession, type StudioTelemetry } from '../scene/studioSession';
import { TwinSceneController, type CameraPreset, type TwinEntityView } from '../scene/TwinSceneController';
import { selectionCard, type SelectionCard } from '../scene/selectionCard';
import type { ThemeName } from '../scene/theme';
import { parseSceneDocument, sceneFileName, serializeSceneDocument, type SceneOp, type TwinTransform } from '@twin-platform/scene-schema';
import { createHttpStorage, defaultServerUrl, pingServer } from '@twin-platform/storage-http';
import type { SceneSummary as StoredSceneSummary } from '@twin-platform/storage-contracts';
import ScenePanel, { type SceneExportPayload, type SceneImportOutcome, type ServerState } from './ScenePanel';
import PoseEditor, { copyTransform } from './PoseEditor';
import DataSourcePanel from './DataSourcePanel';
import EventLogPanel from './EventLogPanel';
import TimelineBar from './TimelineBar';
import PluginsPanel from './PluginsPanel';
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
 * - 画布上常驻的只有左上角一列小按钮，其余（遥测浮层、仿真控制条、区域列表）
 *   默认全部收起，点了才展开，把画面尽量让给场景。
 */

type InspectorTab = 'entity' | 'metrics' | 'compare' | 'data' | 'scene' | 'events' | 'plugins';
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

const TABS: { id: InspectorTab; icon: string; label: string }[] = [
  { id: 'entity', icon: '🧩', label: '实体' },
  { id: 'metrics', icon: '📊', label: '指标' },
  { id: 'compare', icon: '⚖️', label: '对比' },
  { id: 'data', icon: '📡', label: '数据' },
  { id: 'scene', icon: '🗂️', label: '场景' },
  { id: 'events', icon: '📜', label: '事件' },
  { id: 'plugins', icon: '🔌', label: '插件' },
];

export default function TwinViewport() {
  /**
   * 会话是**可替换**的信号，不是常量：导入外部场景要整个换掉（世界、录制器、
   * 时间轴控制器全得重建），旧的那一份必须停掉，否则两个世界会同时推进。
   */
  const [session, setSession] = createSignal(new StudioSession());
  let controller: TwinSceneController | undefined;
  let hostEl: HTMLDivElement | undefined;

  const [selected, setSelected] = createSignal<TwinEntityView>();
  const [entities, setEntities] = createSignal<TwinEntityView[]>([]);
  const [tab, setTab] = createSignal<InspectorTab>('entity');
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

  /** 在同一个挂载点上（重新）建三维控制器。换场景与首次挂载共用这条路径。 */
  const buildController = () => {
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
        scene: untrack(() => session().world.scene),
        controller: untrack(() => session().controller),
        // 拖拽松手才提交（回调在用户操作时才执行，晚于下方这些 const 定义，无 TDZ 问题）。
        onDragCommit: (entityId, position) => commitDrag(entityId, position),
      },
    );
    setEntities(controller.entities);
    setTheme(controller.themeName);
  };

  const mountViewport = (host: HTMLDivElement) => {
    hostEl = host;
    buildController();
  };

  /**
   * 换掉整个会话：旧的先暂停（否则两个世界同时推进、同时写录），
   * 再重建三维控制器把新场景画出来。
   */
  const replaceSession = (next: StudioSession) => {
    session().controller.pause();
    setSession(next);
    setSelected(undefined);
    buildController();
  };

  /** 导入场景 JSON：解析 + 迁移 + 校验，成功才换会话。 */
  const importScene = (raw: string): SceneImportOutcome => {
    const parsed = parseSceneDocument(raw);
    if (!parsed.ok || !parsed.scene) {
      return { ok: false, applied: parsed.applied, issues: parsed.issues };
    }
    // 导入也必须带上服务端仓储：漏了这一个参数，导入的场景会悄悄退回内存仓储，
    // 事件/快照/场景全部刷新即丢（resetScene / loadFromServer 一直带着，就这里漏过）。
    const next = new StudioSession(parsed.scene, serverStorage());
    replaceSession(next);
    // 这个 id 以前存过服务端的话，库里已有事件，不接着写会撞上"sequence 必须严格单调"。
    // 构造是同步的（SceneImportOutcome 要同步返回），所以异步对齐一次。
    if (serverStorage()) {
      void next.resumeFromStorage().catch((error: unknown) => {
        setServer((current) =>
          current
            ? {
                ...current,
                note: `导入后对齐事件序号失败：${error instanceof Error ? error.message : String(error)}`,
              }
            : current,
        );
      });
    }
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

  /** 还原到插件模板场景（服务端在线时继续用服务端仓储）。 */
  const resetScene = () => replaceSession(new StudioSession(undefined, serverStorage()));

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
      const next = new StudioSession(scene, storage);
      replaceSession(next);
      // 这个场景可能已经被录制过，事件要接着写而不是从头覆盖。
      await next.resumeFromStorage();
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
      const url =
        import.meta.env.VITE_TWIN_SERVER ||
        (import.meta.env.DEV ? location.origin : defaultServerUrl());
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
      // 换仓储要重建会话（录制器绑定着 storage 实例）。
      const next = new StudioSession(undefined, storage);
      replaceSession(next);
      // 事件流是 append-only 的：库里已有历史就接着写，不能从头覆盖。
      await next.resumeFromStorage();
      await refreshServerScenes();
    })();
  });

  onCleanup(() => {
    // 攒批的事件别丢在页面关闭这一刻。
    void serverStorage()?.flush();
  });

  // 面板按固定频率采样，而不是每帧刷新：UI 不需要 60Hz 的事件流，
  // 每帧写信号只会把渲染循环拖进响应式更新里。
  const refresh = async () => {
    const current = session();
    setView({
      time: current.controller.time,
      duration: current.controller.duration,
      playing: current.controller.playing,
      speed: current.controller.speed,
      events: current.recentEvents(8),
      stored: await current.storedEventCount(),
    });
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
                onClick={() => setTab(tab() === 'scene' ? 'entity' : 'scene')}
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
                    <For each={REGIONS}>
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

            <Show when={hud()}>

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
            <For each={TABS}>
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

            <Show when={tab() === 'plugins'}>
              <PluginsPanel host={session().host} />
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
