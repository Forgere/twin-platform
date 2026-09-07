import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { LineMetrics } from '@twin-platform/analytics-core';
import { StudioSession, type StudioTelemetry } from '../scene/studioSession';
import { TwinSceneController, type TwinEntityView } from '../scene/TwinSceneController';
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
 * UI 沿用 VividFactory 的浅色马卡龙 + 玻璃拟态语言：标题卡（左下浮于画布）、
 * Sim Telemetry HUD（右上浮于画布）、相机机位条（画布下方）。
 */
export default function TwinViewport() {
  const session = new StudioSession();
  let controller: TwinSceneController | undefined;

  const [selected, setSelected] = createSignal<TwinEntityView>();
  const [entities, setEntities] = createSignal<TwinEntityView[]>([]);
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

  const mountViewport = (host: HTMLDivElement) => {
    controller = new TwinSceneController(host, setSelected, { scene: session.world.scene, controller: session.controller });
    setEntities(controller.entities);
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
  };
  const timer = setInterval(() => void refresh(), 120);

  onCleanup(() => {
    clearInterval(timer);
    controller?.dispose();
  });

  return (
    <main class="studio-shell">
      <section class="studio-heading">
        <div>
          <p class="eyebrow">TWIN PLATFORM / STUDIO</p>
          <h1>物流工厂概览</h1>
          <p>插件驱动 · world-kernel 仿真 · analytics-core 指标 · 可回放 · 可方案对比</p>
        </div>
        <div class="scene-status" aria-label="场景状态">
          <span class="status-dot" />
          场景已加载 · 仿真 t = {view().time.toFixed(1)}s
        </div>
      </section>

      <section class="studio-grid">
        <div class="viewport-panel">
          <div class="viewport-frame">
            <div ref={mountViewport} class="viewport" aria-label="数字孪生三维场景" />

            <div class="title-card">
              <h1>物流工厂 🏭</h1>
              <p>插件驱动 · world-kernel 仿真 · analytics-core 指标</p>
            </div>

            <div class="telemetry-hud" aria-label="仿真遥测">
              <h3>📡 Sim Telemetry</h3>
              <div class="telemetry-grid">
                <div class="tele-cell">
                  <span class="tele-label">在制</span>
                  <span class="tele-value">{telemetry().active}</span>
                </div>
                <div class="tele-cell">
                  <span class="tele-label">已生成</span>
                  <span class="tele-value">{telemetry().spawned}</span>
                </div>
                <div class="tele-cell">
                  <span class="tele-label">已消耗</span>
                  <span class="tele-value">{telemetry().consumed}</span>
                </div>
                <div class="tele-cell">
                  <span class="tele-label">积压</span>
                  <span class="tele-value">{telemetry().backlog}</span>
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
                <span class="tele-label">外部车道</span>
                <span class="tele-value-sm">
                  {telemetry().externalLanes} 条 · 在途 {telemetry().externalActive}
                </span>
              </div>

              <div class="tele-section tele-events">
                <span class="tele-label">最近事件</span>
                <For each={telemetry().recent}>
                  {(event) => (
                    <span class="tele-event">
                      {event.type}
                      <em>@{event.occurredAt.toFixed(1)}s</em>
                    </span>
                  )}
                </For>
              </div>
            </div>
          </div>

          <div class="camera-bar" aria-label="相机机位">
            <button type="button" onClick={() => controller?.setCameraPreset('overview')}>
              🌐 全局
            </button>
            <button type="button" onClick={() => controller?.setCameraPreset('infeed')}>
              📥 入料
            </button>
            <button type="button" onClick={() => controller?.setCameraPreset('inspection')}>
              🔎 质检
            </button>
            <button type="button" onClick={() => controller?.setCameraPreset('sorter')}>
              🔀 分拣
            </button>
            <button type="button" onClick={() => controller?.setCameraPreset('packaging')}>
              📦 包装
            </button>
            <button type="button" onClick={() => controller?.setCameraPreset('outfeed')}>
              📤 出料
            </button>
            <button type="button" onClick={() => controller?.setCameraPreset('external')}>
              🔗 外部
            </button>
          </div>

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
          />
          <div class="viewport-hint">拖动旋转 · 右键平移 · 滚轮缩放 · 点击设备选择</div>
        </div>

        <aside class="inspector" aria-label="场景控制与实体详情">
          <section>
            <h2>🧩 实体</h2>
            <div class="entity-list">
              <For each={entities()}>
                {(entity) => (
                  <button
                    type="button"
                    class={selected()?.id === entity.id ? 'selected' : undefined}
                    onClick={() => controller?.selectEntity(entity.id)}
                  >
                    {entity.label}
                  </button>
                )}
              </For>
            </div>
          </section>

          <section class="entity-detail" aria-live="polite">
            <h2>🎯 当前选择</h2>
            <Show when={selected()} fallback={<p>请选择场景中的一个实体。</p>}>
              {(entity) => (
                <>
                  <strong>{entity().label}</strong>
                  <span>{entity().kind}</span>
                  <button type="button" onClick={() => controller?.focusEntity(entity().id)}>
                    聚焦此设备
                  </button>
                </>
              )}
            </Show>
          </section>

          <PluginsPanel host={session.host} />
          <MetricsPanel metrics={metrics()} />
          <ScenarioComparePanel onCompare={(forkAt, horizon, zoneB) => session.compare(forkAt, horizon, zoneB)} />

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

          <EventLogPanel events={view().events} stored={view().stored} />
        </aside>
      </section>
    </main>
  );
}
