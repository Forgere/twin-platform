import { For, Show } from 'solid-js';
import type { WorldEvent } from '@twin-platform/world-kernel';

/**
 * 事件流面板：显示世界最近产生的事件。
 *
 * 事件是唯一真相——状态可以由事件重放出来，反过来不行。所以这个面板显示的
 * 就是落库到 `twin_events` 的同一批数据。
 */
export default function EventLogPanel(props: { events: WorldEvent[]; stored: number }) {
  return (
    <section class="event-log" aria-live="polite">
      <h2>事件流</h2>
      <p class="event-log-meta">
        已落库 {props.stored} 条 · 内存保留 {props.events.length} 条
      </p>
      <Show when={props.events.length > 0} fallback={<p class="event-empty">还没有事件。</p>}>
        <ul>
          <For each={props.events}>
            {(event) => (
              <li>
                <span class="event-seq">#{event.sequence}</span>
                <span class="event-type">{event.type}</span>
                <span class="event-meta">
                  {event.occurredAt.toFixed(2)}s{event.entityId ? ` · ${event.entityId}` : ''}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
