import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { LineMetrics } from '@twin-platform/analytics-core';
import { StudioSession, type StudioTelemetry } from '../scene/studioSession';
import { TwinSceneController, type CameraPreset, type TwinEntityView } from '../scene/TwinSceneController';
import type { ThemeName } from '../scene/theme';
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

type InspectorTab = 'entity' | 'metrics' | 'compare' | 'data' | 'events' | 'plugins';
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
  { id: 'events', icon: '📜', label: '事件' },
  { id: 'plugins', icon: '🔌', label: '插件' },
];

export default function TwinViewport() {
  const session = new StudioSession();
  let controller: TwinSceneController | undefined;

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
  const [metrics, setMetrics] = createSignal<LineMetrics>(session.metrics());
  const [telemetry, setTelemetry] = createSignal<StudioTelemetry>(session.telemetry());
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

  const mountViewport = (host: HTMLDivElement) => {
    controller = new TwinSceneController(
      host,
      (entity) => {
        setSelected(entity);
        // 点中场景里的东西就把实体页翻出来，不然选中了也看不见。
        if (entity) setTab('entity');
      },
      { scene: session.world.scene, controller: session.controller },
    );
    setEntities(controller.entities);
    setTheme(controller.themeName);
  };

  // 面板按固定频率采样，而不是每帧刷新：UI 不需要 60Hz 的事件流，
  // 每帧写信号只会把渲染循环拖进响应式更新里。
  const refresh = async () => {
    setView({
      time: session.controller.time,
      duration: session.controller.duration,
      playing: session.controller.playing,
      speed: session.controller.speed,
      events: session.recentEvents(8),
      stored: await session.storedEventCount(),
    });
    setMetrics(session.metrics());
    setTelemetry(session.telemetry());
    setTick((value) => value + 1);
  };
  const timer = setInterval(() => void refresh(), 120);

  onCleanup(() => {
    clearInterval(timer);
    controller?.dispose();
  });

  /**
   * 当前选中实体的实时状态行。
   *
   * 读一下 `tick()` 是为了让这段在采样节拍上重算——状态存在世界 attrs 里，
   * 不经过信号，必须靠节拍显式拉取（和遥测 HUD 同一个套路）。
   */
  const selectedState = (): string[] => {
    tick();
    const entity = selected();
    return entity && controller ? controller.describeEntity(entity.id) : [];
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
        <h1>智能物流中心</h1>
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
              onPlay={() => session.controller.play()}
              onPause={() => session.controller.pause()}
              onSpeed={(speed) => session.controller.setSpeed(speed)}
              onSeek={(time) => void session.controller.seek(time)}
              onStep={(steps) => session.controller.stepFrames(steps)}
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

              <section class="entity-detail" aria-live="polite">
                <h2>🎯 当前选择</h2>
                <Show when={selected()} fallback={<p>点击场景中的设备或物料，或从上方列表选择。</p>}>
                  {(entity) => (
                    <>
                      <strong onContextMenu={(event) => openMenu(event, entity())} title="右键可复制名字 / ID">
                        {entity().label}
                      </strong>
                      <span>
                        {entity().kind} · {entity().id}
                      </span>
                      <Show when={selectedState().length > 0}>
                        <dl class="entity-state">
                          <For each={selectedState()}>
                            {(line) => <dd>{line}</dd>}
                          </For>
                        </dl>
                      </Show>
                      <span class="code-path">
                        渲染来源：{controller ? controller.codePath(entity().id) : '—'}
                      </span>
                      <button type="button" onClick={() => controller?.focusEntity(entity().id)}>
                        聚焦此实体
                      </button>
                    </>
                  )}
                </Show>
              </section>
            </Show>

            <Show when={tab() === 'metrics'}>
              <MetricsPanel metrics={metrics()} />
            </Show>

            <Show when={tab() === 'compare'}>
              <ScenarioComparePanel onCompare={(forkAt, horizon, zoneB) => session.compare(forkAt, horizon, zoneB)} />
            </Show>

            <Show when={tab() === 'data'}>
              <DataSourcePanel
                onLoad={(text) => {
                  const loaded = session.loadCsv(text);
                  void session.controller.seek(0);
                  session.controller.play();
                  return loaded;
                }}
                onReset={() => {
                  session.useSimulation();
                  void session.controller.seek(0);
                }}
              />
            </Show>

            <Show when={tab() === 'events'}>
              <EventLogPanel events={view().events} stored={view().stored} />
            </Show>

            <Show when={tab() === 'plugins'}>
              <PluginsPanel host={session.host} />
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
