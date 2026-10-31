import { createEffect, createMemo, For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import Icon from './Icon';
import { handleTabKeys } from '../ui/keyboard';

/**
 * 时间轴条：专业剪辑轨与时序中枢。
 *
 * 结合三大时序功能：
 *   1. 审计 (Audit)：契约违例尖角 marker + hover 证据卡 + 展开审计抽屉；
 *   2. 事件流 (Events)：轨上事件微密度点 + 展开事件流抽屉；
 *   3. 方案对比 (Compare)：轨上分叉时刻标记 + 展开分叉对比抽屉。
 *
 * 布局：
 *   - 抽屉展开时：上方平滑滑出磨砂抽屉面板（.timeline-drawer）；
 *   - 轴本体（单行）：
 *     左：28px 极简图标控制组（回到起点 / 播放暂停 / 单步 / +0.5s / 倍速）
 *     中：主刻度尺 + 交替条带 + 事件点 + 违例尖角 + 分叉点 + 播放头 + 透明交互 range
 *     右：透镜切换药丸按钮组（审计 / 事件 / 对比）
 */

const SPEEDS = [0.25, 0.5, 1, 2, 10, 50];

/** 候选刻度步长（秒）：挑一个让主刻度落在 4~8 根之间的，长短场景都不挤不疏。 */
const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];

/**
 * 时间轴上的一处审计标记：一次违例发生在哪一刻。
 */
export interface TimelineAuditMark {
  readonly id: string;
  readonly t: number;
  readonly status: 'fail' | 'error';
  readonly label: string;
}

export type TimelineLens = 'audit' | 'events' | 'compare';

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
  /** 审计违例在轴上的刻度：点一下就 seek 到那一刻。 */
  marks?: readonly TimelineAuditMark[];
  /** 巡演正在看的那一条，给个实心的当前状态。 */
  activeMarkId?: string;
  /** 当前展开的时间轴透镜；undefined 表示收起抽屉。 */
  activeLens?: TimelineLens;
  onLensChange?: (lens: TimelineLens | undefined) => void;
  /** 审计不符项数量，用于角标提示。 */
  failingCount?: number;
  /** 事件总数或保留数，用于角标。 */
  eventCount?: number;
  /** 方案对比分叉时刻（秒），在轨上标记分叉点。 */
  compareForkAt?: number;
  /** 最近事件样本，用于轨上刻画事件微密度。 */
  recentEvents?: readonly { occurredAt: number }[];
  /** 抽屉面板内容。 */
  children?: JSX.Element;
}

/** 刻度标签：短场景按秒读数，过分钟按 mm:ss，亚秒步长留一位小数。 */
function tickLabel(t: number, step: number): string {
  if (step >= 60) return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
  if (step >= 1) return `${Math.round(t)}s`;
  return `${t.toFixed(1)}s`;
}

export default function TimelineBar(props: TimelineBarProps) {
  /** 总时长兜底为 1s：空场景不能让百分比计算除零。 */
  const span = (): number => Math.max(props.duration, 1);
  const fillPct = createMemo(() => (Math.min(props.time, span()) / span()) * 100);
  /** 抽屉开着时按 Esc 收起：和时间轴自身的高度无关，读屏用户也能退出来。 */
  createEffect(
    () => props.activeLens,
    (lens) => {
      if (!lens) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        props.onLensChange?.(undefined);
      };
      document.addEventListener('keydown', onKeyDown);
      return () => document.removeEventListener('keydown', onKeyDown);
    },
  );

  /** 主刻度：均匀分布，末尾补一个终点刻度，右侧永远知道"一共多长"。 */
  const ticks = createMemo(() => {
    const total = span();
    const step = TICK_STEPS.find((candidate) => span() / candidate <= 8) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const out: { t: number; pct: number; label: string }[] = [];
    for (let t = 0; t <= total + 1e-6; t += step) out.push({ t, pct: (t / total) * 100, label: tickLabel(t, step) });
    const last = out[out.length - 1];
    if (last && total - last.t > step * 0.2) out.push({ t: total, pct: 100, label: tickLabel(total, step) });
    return out;
  });

  /** 深浅交替的条带：一格一段，边界取相邻主刻度，所以条带和刻度永远对得上。 */
  const bands = createMemo(() =>
    ticks()
      .slice(0, -1)
      .map((tick, index) => ({ left: tick.pct, width: ticks()[index + 1].pct - tick.pct })),
  );

  const markPct = (t: number): number => (Math.min(t, span()) / span()) * 100;

  return (
    <section class="timeline" aria-label="时间轴">
      {/* 时间轴展开抽屉：聚合审计、事件流、方案对比三个时序透镜 */}
      <Show when={props.activeLens}>
        <div class="timeline-drawer" role="region" aria-label="时间轴透镜详情">
          <div class="tl-drawer-head">
            <div
              class="tl-drawer-tabs"
              role="tablist"
              aria-label="时间轴透镜"
              onKeyDown={(e) =>
                handleTabKeys(
                  e,
                  ['audit', 'events', 'compare'] as const,
                  props.activeLens,
                  (id) => props.onLensChange?.(id),
                )
              }
            >
              <button
                type="button"
                role="tab"
                class={props.activeLens === 'audit' ? 'tl-drawer-tab is-active' : 'tl-drawer-tab'}
                aria-selected={props.activeLens === 'audit' ? 'true' : 'false'}
                tabindex={props.activeLens === 'audit' ? 0 : -1}
                onClick={() => props.onLensChange?.('audit')}
              >
                <Icon name="shield" size={13} />
                <span>审计透镜</span>
                <Show when={props.failingCount !== undefined}>
                  <span class={props.failingCount! > 0 ? 'tl-badge tl-badge-bad' : 'tl-badge tl-badge-ok'}>
                    {props.failingCount}
                  </span>
                </Show>
              </button>
              <button
                type="button"
                role="tab"
                class={props.activeLens === 'events' ? 'tl-drawer-tab is-active' : 'tl-drawer-tab'}
                aria-selected={props.activeLens === 'events' ? 'true' : 'false'}
                tabindex={props.activeLens === 'events' ? 0 : -1}
                onClick={() => props.onLensChange?.('events')}
              >
                <Icon name="list" size={13} />
                <span>事件流</span>
                <Show when={props.eventCount !== undefined}>
                  <span class="tl-badge">{props.eventCount}</span>
                </Show>
              </button>
              <button
                type="button"
                role="tab"
                class={props.activeLens === 'compare' ? 'tl-drawer-tab is-active' : 'tl-drawer-tab'}
                aria-selected={props.activeLens === 'compare' ? 'true' : 'false'}
                tabindex={props.activeLens === 'compare' ? 0 : -1}
                onClick={() => props.onLensChange?.('compare')}
              >
                <Icon name="git-branch" size={13} />
                <span>方案对比</span>
              </button>
            </div>
            <button
              type="button"
              class="tl-drawer-close"
              aria-label="收起抽屉"
              title="收起抽屉"
              onClick={() => props.onLensChange?.(undefined)}
            >
              <Icon name="close" size={13} />
            </button>
          </div>
          <div class="tl-drawer-body">{props.children}</div>
        </div>
      </Show>

      <div class="timeline-row">
        <div class="timeline-controls">
          <button type="button" class="tl-btn" aria-label="回到起点" title="回到起点" onClick={() => props.onSeek(0)}>
            <Icon name="skip-start" />
          </button>
          <button
            type="button"
            class="tl-btn tl-btn-play"
            aria-label={props.playing ? '暂停' : '播放'}
            title={props.playing ? '暂停' : '播放'}
            onClick={() => (props.playing ? props.onPause() : props.onPlay())}
          >
            <Icon name={props.playing ? 'pause' : 'play'} />
          </button>
          <button type="button" class="tl-btn" aria-label="单步 +1帧" title="单步 +1帧" onClick={() => props.onStep(1)}>
            <Icon name="step-forward" />
          </button>
          <button type="button" class="tl-btn" aria-label="前进 0.5 秒" title="前进 0.5 秒" onClick={() => props.onStep(30)}>
            <Icon name="fast-forward" />
          </button>
          <label class="tl-speed">
            <span class="tl-speed-label">速</span>
            <select value={String(props.speed)} onChange={(event) => props.onSpeed(Number(event.currentTarget.value))}>
              <For each={SPEEDS}>{(speed) => <option value={String(speed)}>{speed}×</option>}</For>
            </select>
          </label>
        </div>

        <div class="timeline-track">
          <div class="timeline-ruler" aria-hidden="true">
            <For each={ticks()}>
              {(tick, index) => (
                <>
                  <span class="tl-tick tl-tick-major" style={{ left: `${tick.pct}%` }} />
                  <span
                    class={{ 'tl-tick-label': true, 'is-edge': index() > 0 && tick.pct >= 100 }}
                    style={{ left: `${tick.pct}%` }}
                  >
                    {tick.label}
                  </span>
                </>
              )}
            </For>
          </div>

          <div class="timeline-bands" aria-hidden="true">
            <For each={bands()}>{(band) => <span class="timeline-band" style={{ 'flex': `0 0 ${band.width}%` }} />}</For>
          </div>

          {/* 最近事件微密度点：在轨上呈现事件发生时的微细短线 */}
          <Show when={(props.recentEvents?.length ?? 0) > 0}>
            <div class="timeline-event-ticks" aria-hidden="true">
              <For each={props.recentEvents}>
                {(ev) => <span class="timeline-event-tick" style={{ left: `${markPct(ev.occurredAt)}%` }} />}
              </For>
            </div>
          </Show>

          <div class="timeline-fill" aria-hidden="true">
            <div class="timeline-fill-bar" style={{ width: `${fillPct()}%` }} />
          </div>

          {/* 方案对比分叉时刻标记 */}
          <Show when={props.compareForkAt !== undefined}>
            <div
              class="timeline-fork-mark"
              style={{ left: `${markPct(props.compareForkAt!)}%` }}
              title={`方案对比分叉点 t=${props.compareForkAt!.toFixed(2)}s`}
            >
              <Icon name="git-branch" size={11} />
            </div>
          </Show>

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
                    style={{ left: `${markPct(mark.t)}%` }}
                    aria-label={`${mark.label}，t=${mark.t.toFixed(2)} 秒，点击跳到这一刻`}
                    onClick={() => props.onSeek(mark.t)}
                  >
                    <span class="tl-evidence">
                      <b>{mark.label}</b>
                      <i>t={mark.t.toFixed(2)}s</i>
                      <span>点击跳到这一刻</span>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>

          <div class="timeline-playhead" aria-hidden="true" style={{ left: `${fillPct()}%` }} />

          {/* 原生 range 透明覆在轨上负责交互：保住键盘操作与无障碍语义 */}
          <input
            class="timeline-range"
            type="range"
            min="0"
            max={span()}
            step="0.05"
            value={Math.min(props.time, span())}
            onInput={(event) => props.onSeek(Number(event.currentTarget.value))}
            aria-label="定位到仿真时刻"
            aria-valuetext={`${props.time.toFixed(2)}s`}
          />
        </div>

        {/* 右侧时序透镜入口：审计、事件、方案对比 */}
        <div class="timeline-lenses" role="toolbar" aria-label="时间轴透镜">
          <button
            type="button"
            class={props.activeLens === 'audit' ? 'tl-lens-btn is-active' : 'tl-lens-btn'}
            aria-pressed={props.activeLens === 'audit' ? 'true' : 'false'}
            aria-label="审计透镜"
            title="审计透镜：契约判定与违例现场"
            onClick={() => props.onLensChange?.(props.activeLens === 'audit' ? undefined : 'audit')}
          >
            <Icon name="shield" size={13} />
            <span class="tl-lens-text">审计</span>
            <Show when={props.failingCount !== undefined}>
              <span class={props.failingCount! > 0 ? 'tl-badge tl-badge-bad' : 'tl-badge tl-badge-ok'}>
                {props.failingCount}
              </span>
            </Show>
          </button>
          <button
            type="button"
            class={props.activeLens === 'events' ? 'tl-lens-btn is-active' : 'tl-lens-btn'}
            aria-pressed={props.activeLens === 'events' ? 'true' : 'false'}
            aria-label="事件透镜"
            title="事件透镜：时序事件流"
            onClick={() => props.onLensChange?.(props.activeLens === 'events' ? undefined : 'events')}
          >
            <Icon name="list" size={13} />
            <span class="tl-lens-text">事件</span>
          </button>
          <button
            type="button"
            class={props.activeLens === 'compare' ? 'tl-lens-btn is-active' : 'tl-lens-btn'}
            aria-pressed={props.activeLens === 'compare' ? 'true' : 'false'}
            aria-label="方案对比透镜"
            title="方案对比透镜：从当前时刻分叉推演"
            onClick={() => props.onLensChange?.(props.activeLens === 'compare' ? undefined : 'compare')}
          >
            <Icon name="git-branch" size={13} />
            <span class="tl-lens-text">对比</span>
          </button>
        </div>
      </div>
    </section>
  );
}
