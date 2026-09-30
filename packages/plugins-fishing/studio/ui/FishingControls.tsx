import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { BAITS, fishById, LIFT_RESULT_LABEL, SIGNAL_LABEL, type FishProfile, type FloatSignal } from '@twin-platform/plugins-fishing';
import type { WorldEvent } from '@twin-platform/world-kernel';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { castRod, liftRod, readRig, recordCast, RIG_ID, switchBait, type CastRecord } from './fishingWorld';
import { createBiteAudio } from './biteAudio';

const RECORDS: readonly { id: CastRecord; label: string }[] = [
  { id: 'none', label: '没口' }, { id: 'caught', label: '🐟 中鱼' }, { id: 'empty', label: '空钩' }, { id: 'broken', label: '切线' },
];
const BAIT_LABEL = { worm: '蚯蚓', grain: '谷物', commercial: '商品饵', corn: '玉米' } as const;

/** 画布下方中央的单一操作位；反馈不拦截指针，也不接管键盘焦点。 */
export default function FishingControls(props: { session: StudioSessionPort; tick: number }) {
  const rig = createMemo(() => {
    props.tick;
    return readRig(props.session);
  }, { name: 'fishing.controls.rig' });
  const [sound, setSound] = createSignal(true, { name: 'fishing.sound' });
  const [recording, setRecording] = createSignal(false, { name: 'fishing.recording' });
  const [caught, setCaught] = createSignal<FishProfile | undefined>(undefined, { name: 'fishing.catch' });
  const audio = createBiteAudio();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previous: { session: StudioSessionPort; time: number; event?: WorldEvent; casts: number; active: boolean } | undefined;

  const clearCatch = (): void => {
    clearTimeout(timer);
    timer = undefined;
    setCaught(undefined);
  };

  // 只消费游标后的事件；普通采样、重新挂载、回退和换场景都不能重复播历史反馈。
  createEffect(
    () => {
      props.tick;
      const session = props.session;
      return { session, rig: rig(), time: session.world.time };
    },
    ({ session, rig: current, time }) => {
      const events = session.world.getEventLog();
      const last = events[events.length - 1];
      const active = current?.mode === 'sim' && current.ready;
      const casts = current?.counts.casts ?? 0;
      const reset = !previous || previous.session !== session || time < previous.time || casts < previous.casts || previous.active !== active
        || (last?.sequence ?? 0) < (previous.event?.sequence ?? 0)
        || (last?.sequence === previous.event?.sequence && last !== previous.event);
      const cursor = previous?.event?.sequence ?? 0;
      previous = { session, time, event: last, casts, active };
      if (reset || !active) {
        clearCatch();
        audio.silence();
        return;
      }
      let bite = false;
      let fish: FishProfile | undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]!;
        if (event.sequence <= cursor) break;
        if (event.entityId !== RIG_ID) continue;
        if ((event.type === 'fish:bite' || event.type === 'fish:cast') && event.payload?.bite === true) bite = true;
        if (!fish && ((event.type === 'fish:lift' && event.payload?.result === 'caught') || (event.type === 'fish:cast' && event.payload?.caught === true))) {
          const id = event.payload?.fishId;
          if (typeof id === 'string') fish = fishById(id);
        }
      }
      if (bite && sound()) audio.play();
      if (fish) {
        clearTimeout(timer);
        setCaught(fish);
        timer = setTimeout(clearCatch, 3000);
      }
    },
    { name: 'fishing.feedback' },
  );
  onCleanup(() => {
    clearTimeout(timer);
    audio.dispose();
  });

  const signal = (): string => SIGNAL_LABEL[(rig()?.signal ?? 'none') as FloatSignal] ?? '';
  // 老版模拟仍可提竿，收竿后可通过抛竿按钮切入新的手动流程。
  const lifting = (): boolean => !!rig()?.inWater || !!rig()?.pendingBite;
  const act = (): void => {
    if (sound()) audio.unlock();
    if (lifting()) liftRod(props.session);
    else castRod(props.session);
  };
  const hint = (): string => {
    const current = rig();
    if (!current?.ready) return '先在钓鱼助手中完成钓组配置';
    if (current.pendingBite) return `${signal()} · 鱼来了，快提竿！`;
    if (current.inWater) return '等待鱼口… 提竿可收回，收竿后可换饵';
    return current.lastLift ? LIFT_RESULT_LABEL[current.lastLift] : '选好鱼饵，抛竿开始';
  };

  return (
    <Show when={rig()}>
      {(current) => (
        <div class="fish-controls" aria-label="钓鱼操作">
          <div class="fish-catch" role="status" aria-live="polite" aria-atomic="true">
            <Show when={caught()}>
              {(fish) => (
                <div class="fish-catch-card">
                  <svg class="fish-catch-icon" viewBox="0 0 100 64" aria-hidden="true">
                    <path d="M28 32 7 14v36Zm8-16L49 4l13 12Zm7 31 12 13 11-14Z" fill="currentColor" opacity="0.65" />
                    <path d="M23 32C35 7 76 8 94 32 76 56 35 57 23 32Z" fill="currentColor" />
                    <path d="M64 20q-9 12 0 24" fill="none" stroke="var(--cream-card)" stroke-width="2" opacity="0.65" />
                    <circle cx="77" cy="27" r="3" fill="var(--cream-card)" />
                  </svg>
                  <div><span class="fish-catch-kicker">钓到了！</span><strong>{fish().label}</strong></div>
                </div>
              )}
            </Show>
          </div>
          <Show when={current().mode === 'sim'} fallback={
            <div class="fish-controls-real">
              <button type="button" disabled={!current().ready} aria-expanded={recording() ? 'true' : 'false'} onClick={() => setRecording(!recording())}>📝 记录一竿</button>
              <Show when={recording()}>
                <div class="fish-controls-records" role="group" aria-label="记一竿">
                  <For each={RECORDS}>{(item) => <button type="button" disabled={!current().ready} onClick={() => recordCast(props.session, item.id)}>{item.label}</button>}</For>
                </div>
              </Show>
            </div>
          }>
            <p class="fish-controls-hint" aria-live="polite">{hint()}</p>
            <button
              type="button"
              class={'fish-primary' + (current().pendingBite ? ' fish-primary-bite' : '')}
              disabled={!current().ready}
              onClick={act}
            >
              <svg class="fish-control-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 21 9-18h8v12a4 4 0 0 1-8 0v-2l2 2" /></svg>
              {lifting() ? (current().pendingBite ? '提竿！' : '提竿') : '抛竿'}
            </button>
            <div class="fish-controls-baits" role="group" aria-label="快速换饵">
              <For each={BAITS}>
                {(bait) => (
                  <button
                    type="button"
                    class="fish-bait"
                    aria-label={bait.label}
                    aria-pressed={current().loadout.bait === bait.id ? 'true' : 'false'}
                    disabled={!current().ready || lifting()}
                    title={lifting() ? '收竿后可换饵' : bait.note}
                    onClick={() => switchBait(props.session, bait.id)}
                  >{BAIT_LABEL[bait.id]}</button>
                )}
              </For>
              <button
                type="button"
                class="fish-sound"
                aria-label="鱼口音效"
                aria-pressed={sound() ? 'true' : 'false'}
                title={sound() ? '关闭鱼口音效' : '开启鱼口音效'}
                onClick={() => {
                  const enabled = !sound();
                  setSound(enabled);
                  if (enabled) audio.unlock();
                  else audio.silence();
                }}
              >
                <svg class="fish-control-icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M11 4 5 9H2v6h3l6 5Z" />
                  <Show when={sound()} fallback={<path d="m16 9 6 6m0-6-6 6" />}>
                    <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
                  </Show>
                </svg>
              </button>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
