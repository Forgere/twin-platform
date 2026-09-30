import { createMemo, Show } from 'solid-js';
import { fishById, SIGNAL_LABEL, type FloatSignal } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { readRig } from './fishingWorld';

/** 右上角只读钓况；操作集中在底部，调目与装备在「钓组」页。 */
const ZONE_LABEL: Readonly<Record<string, string>> = {
  off_bottom: '未到底', sensitive: '偏灵', neutral: '不灵不钝', blunt: '偏钝', sinker_on_bottom: '铅坠触底',
};
const ZONE_CLASS: Readonly<Record<string, string>> = {
  off_bottom: 'zone-chip-off', sensitive: 'zone-chip-sens', neutral: 'zone-chip-neutral', blunt: 'zone-chip-blunt', sinker_on_bottom: 'zone-chip-lead',
};
const fmt = (value: number): string => String(Math.round(value * 100) / 100);

export default function FishingHud(props: { session: StudioSessionPort; tick: number }) {
  const rig = createMemo(() => {
    props.tick;
    return readRig(props.session);
  }, { name: 'fishing.hud.rig' });
  const signal = (): FloatSignal => {
    const value = rig()?.signal;
    return value === 'nod' || value === 'lift' || value === 'sink' || value === 'run' ? value : 'none';
  };

  return (
    <Show when={rig()}>
      {(current) => (
        <section class="fish-hud" aria-label="钓况">
          <div class="fish-hud-row">
            <span class="fish-hud-fish">
              {fishById(current().loadout.targetFish)?.emoji} {fishById(current().loadout.targetFish)?.label}
            </span>
            <Show when={current().mode === 'sim' && signal() !== 'none'}>
              <span class="fish-hud-signal">{SIGNAL_LABEL[signal()]}</span>
            </Show>
          </div>
          <p class="fish-hud-gear">
            {current().loadout.rodLength}m · 主{current().loadout.mainLine}/子{current().loadout.subLine} · {current().loadout.hookSize}号钩
          </p>
          <Show when={!current().wizardDone}>
            <p class="fish-hud-gear">请在钓鱼助手中完成开钓向导</p>
          </Show>
          <Show when={current().wizardDone && current().state}>
            {(state) => (
              <div class="fish-hud-depth">
                <span>钓目</span><b>{fmt(state().rig.d)}</b>
                <span class={'zone-chip ' + (ZONE_CLASS[state().rig.zone] ?? '')}>{ZONE_LABEL[state().rig.zone]}</span>
              </div>
            )}
          </Show>
          <Show when={current().wizardDone && (current().mode === 'sim' || current().counts.casts > 0)}>
            <div class="fish-hud-stats">
              <span>抛 <b>{current().counts.casts}</b></span>
              <span>口 <b>{current().counts.bites}</b></span>
              <span class="up">中 <b>{current().counts.catches}</b>
                <Show when={current().counts.bites > 0}>
                  <em class="fish-hud-rate"> {Math.round(100 * current().counts.catches / current().counts.bites)}%</em>
                </Show>
              </span>
              <span>空 <b>{current().counts.emptyHooks}</b></span>
              <Show when={current().counts.missed > 0}><span>漏 <b>{current().counts.missed}</b></span></Show>
              <Show when={current().counts.breaks > 0}><span class="down">切 <b>{current().counts.breaks}</b></span></Show>
            </div>
          </Show>
          <div class="fish-hud-conds">
            <Show when={current().conditions.drift}><span class="chip chip-busy">走水{current().conditions.antiDrift ? '（已加铅）' : ''}</span></Show>
            <Show when={current().conditions.smallFish}><span class="chip chip-busy">小鱼闹窝</span></Show>
            <Show when={current().conditions.waterTemperature < 12}><span class="chip chip-idle">水温 {current().conditions.waterTemperature}℃</span></Show>
            <Show when={props.session.world.time < current().conditions.nestUntil}><span class="chip chip-idle">窝料在效</span></Show>
          </div>
        </section>
      )}
    </Show>
  );
}
