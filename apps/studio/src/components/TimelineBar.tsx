import { For, Show } from 'solid-js';

/**
 * 时间轴条：播放/暂停、倍速、单步、拖拽定位。
 *
 * 所有操作都转发给 `ReplayController`：拖拽不是"跳到某个缓存帧"，
 * 而是"恢复快照 + 按固定步长重算"，所以拖到哪里都是真结果。
 */

const SPEEDS = [0.25, 0.5, 1, 2, 10, 50];

/**
 * 时间轴上的一处审计标记：一次违例发生在哪一刻。
 *
 * 只画**有时刻**的违例：连哪件事都定位不出来的违例没法在轴上给出位置，
 * 那条归面板里的文字，不在这里伪造一个刻度。
 */
export interface TimelineAuditMark {
  readonly id: string;
  readonly t: number;
  readonly status: 'fail' | 'error';
  readonly label: string;
}

export interface TimelineBarProps {
  time: number;
  duration: number;
  playing: boolean;
  speed: number;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: number) => void;
  onSeek: (time: number) => void;
  onStep: (steps: number) => void;
  /** 收起控制条（仿真操作不常用，用完就收回去）。 */
  onCollapse?: () => void;
  /** 审计违例在轴上的刻度：点一下就 seek 到那一刻（同样是重算，不是跳缓存帧）。 */
  marks?: readonly TimelineAuditMark[];
  /** 巡演正在看的那一条，给个实心的当前状态。 */
  activeMarkId?: string;
}

export default function TimelineBar(props: TimelineBarProps) {
  const max = () => Math.max(props.duration, 1);

  return (
    <section class="timeline" aria-label="时间轴">
      <div class="timeline-controls">
        <button type="button" onClick={() => (props.playing ? props.onPause() : props.onPlay())}>
          {props.playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button type="button" onClick={() => props.onSeek(0)}>
          ⏮ 起点
        </button>
        <button type="button" onClick={() => props.onStep(1)}>
          单步
        </button>
        <button type="button" onClick={() => props.onStep(30)}>
          +0.5s
        </button>
        <label class="speed-select">
          倍速
          <select
            value={String(props.speed)}
            onChange={(event) => props.onSpeed(Number(event.currentTarget.value))}
          >
            <For each={SPEEDS}>{(speed) => <option value={String(speed)}>{speed}×</option>}</For>
          </select>
        </label>
        <Show when={props.onCollapse}>
          <button type="button" class="timeline-collapse" title="收起控制条" onClick={() => props.onCollapse?.()}>
            ✕
          </button>
        </Show>
      </div>

      <div class="timeline-track">
        <Show when={(props.marks?.length ?? 0) > 0}>
          <div class="timeline-marks" aria-label="审计违例刻度">
            <For each={props.marks}>
              {(mark) => (
                <button
                  type="button"
                  class={
                    mark.id === props.activeMarkId
                      ? `timeline-mark audit-mark-${mark.status} timeline-mark-live`
                      : `timeline-mark audit-mark-${mark.status}`
                  }
                  style={{ left: `${(Math.min(mark.t, max()) / max()) * 100}%` }}
                  title={`${mark.label} · t=${mark.t.toFixed(2)}s（点击跳到这一刻）`}
                  onClick={() => props.onSeek(mark.t)}
                />
              )}
            </For>
          </div>
        </Show>
        <input
          class="timeline-range"
          type="range"
          min="0"
          max={max()}
          step="0.05"
          value={Math.min(props.time, max())}
          onInput={(event) => props.onSeek(Number(event.currentTarget.value))}
          aria-label="定位到仿真时刻"
        />
      </div>
      <Show when={(props.marks?.length ?? 0) > 0}>
        <p class="timeline-audit-note">
          轴上的红点是审计违例：点它就回溯到那一刻重算现场（回跳按契约分叉，之后的事件会被截断）。
        </p>
      </Show>

      <p class="timeline-readout">
        t = {props.time.toFixed(2)}s / {props.duration.toFixed(2)}s · {props.playing ? '播放中' : '已暂停'} ·{' '}
        {props.speed}× · 拖动即重算（恢复最近快照后按固定步长推进）
      </p>
    </section>
  );
}
