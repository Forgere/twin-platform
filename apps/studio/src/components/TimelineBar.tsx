import { For, Show } from 'solid-js';

/**
 * 时间轴条：播放/暂停、倍速、单步、拖拽定位。
 *
 * 所有操作都转发给 `ReplayController`：拖拽不是"跳到某个缓存帧"，
 * 而是"恢复快照 + 按固定步长重算"，所以拖到哪里都是真结果。
 */

const SPEEDS = [0.25, 0.5, 1, 2, 10, 50];

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

      <p class="timeline-readout">
        t = {props.time.toFixed(2)}s / {props.duration.toFixed(2)}s · {props.playing ? '播放中' : '已暂停'} ·{' '}
        {props.speed}× · 拖动即重算（恢复最近快照后按固定步长推进）
      </p>
    </section>
  );
}
