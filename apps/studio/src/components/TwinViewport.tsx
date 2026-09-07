import { createSignal, For, onCleanup, Show } from 'solid-js';
import type { WorldEvent } from '@twin-platform/world-kernel';
import { demoScene } from '../scene/demoScene';
import { StudioSession } from '../scene/studioSession';
import { TwinSceneController, type TwinEntityView } from '../scene/TwinSceneController';
import DataSourcePanel from './DataSourcePanel';
import EventLogPanel from './EventLogPanel';
import TimelineBar from './TimelineBar';

/**
 * Studio 主视口。
 *
 * 只做三件事：把三维视口挂上去、把命令转给控制器与相机、把世界状态显示出来。
 * 世界怎么推演、事件怎么落库、时间轴怎么重算，全在各包里，这里一行都不写。
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

  const mountViewport = (host: HTMLDivElement) => {
    controller = new TwinSceneController(host, setSelected, { scene: demoScene, controller: session.controller });
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
          <h1>物流产线概览</h1>
          <p>原生 Three.js 视口 · SolidJS 工作台 · world-kernel 驱动 · 可回放</p>
        </div>
        <div class="scene-status" aria-label="场景状态">
          <span class="status-dot" />
          场景已加载 · 仿真 t = {view().time.toFixed(1)}s
        </div>
      </section>

      <section class="studio-grid">
        <div class="viewport-panel">
          <div ref={mountViewport} class="viewport" aria-label="数字孪生三维场景" />
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
            <h2>机位</h2>
            <div class="button-row">
              <button type="button" onClick={() => controller?.setCameraPreset('overview')}>
                全局视角
              </button>
              <button type="button" onClick={() => controller?.setCameraPreset('line')}>
                产线视角
              </button>
            </div>
          </section>

          <section>
            <h2>实体</h2>
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
            <h2>当前选择</h2>
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
