import { createSignal, For, Show } from 'solid-js';
import { fishById, SIGNAL_LABEL, type FloatSignal, type SituationId } from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';
import { readRig, writeRig } from './fishingWorld';

/**
 * 钓况 HUD —— 浮在画布右上角，开钓后一眼看到"我现在钓得怎么样"。
 *
 * 只读：计数、灵钝、装备、漂相都来自 rig attrs（readRig）。
 * 唯一的写入是「情况演练」：给新手制造走水 / 闹窝 / 降温，练习应对。
 * 这些写进 attrs，和真实变化一样可回放、可被助手读到。
 *

const ZONE_LABEL: Readonly<Record<string, string>> = {
  off_bottom: '未到底',
  sensitive: '偏灵',
  neutral: '不灵不钝',
  blunt: '偏钝',
  sinker_on_bottom: '铅坠触底',
};

const ZONE_CLASS: Readonly<Record<string, string>> = {
  off_bottom: 'zone-chip-off',
  sensitive: 'zone-chip-sens',
  neutral: 'zone-chip-neutral',
  blunt: 'zone-chip-blunt',
  sinker_on_bottom: 'zone-chip-lead',
};

 * 情况 chip 可点：直接把助手打开到对应情况的解答，看到问题的地方就能拿到对策。
 */
export default function FishingHud(props: {
  session: StudioSession;
  tick: number;
  onReconfigure: () => void;
  onAsk: (situation: SituationId) => void;
}) {
  const [drill, setDrill] = createSignal(false);

  const rig = () => {
    props.tick;
    return readRig(props.session);
  };

  const signal = (): FloatSignal => {
    const value = rig()?.signal;
    return value === 'nod' || value === 'lift' || value === 'sink' || value === 'run' ? value : 'none';
  };

  const drills = () => {
    const current = rig();
    if (!current) return [];
    const { conditions } = current;
    return [
      { id: 'drift', label: '🌊 起风走水', on: conditions.drift, apply: () => writeRig(props.session, { drift: !conditions.drift, antiDrift: false }) },
      { id: 'small', label: '🐟 小鱼闹窝', on: conditions.smallFish, apply: () => writeRig(props.session, { smallFish: !conditions.smallFish }) },
      {
        id: 'cold',
        label: '🥶 降温到 8℃',
        on: conditions.waterTemperature < 12,
        apply: () => writeRig(props.session, { waterTemperature: conditions.waterTemperature < 12 ? 20 : 8 }),
      },
    ];
  };

  return (
    <Show when={rig()}>
      {(current) => (
        <div class="fish-hud" aria-label="钓况">
          <Show when={signal() !== 'none'}>
            <button type="button" class="fish-hud-signal" title="这是什么口？点开助手看怎么应对" onClick={() => props.onAsk('float_unclear')}>
              🔔 {SIGNAL_LABEL[signal()]}
            </button>
          </Show>

          <div class="fish-hud-row">
            <span
              class="fish-hud-fish"
              title={
                current().loadout.rodLength + 'm · 主' + current().loadout.mainLine + '/子' + current().loadout.subLine + ' · ' +
                current().loadout.hookSize + '号钩 · ' + current().loadout.floatSize + 'g漂（在右侧「钓组」页修改）'
              }
            >
              {fishById(current().loadout.targetFish)?.emoji} {fishById(current().loadout.targetFish)?.label}
            </span>
            <Show when={current().state}>
              {(state) => <span class={'zone-chip ' + (ZONE_CLASS[state().rig.zone] ?? '')}>{ZONE_LABEL[state().rig.zone]}</span>}
            </Show>
            <button type="button" class="fish-hud-btn" title="重新走一遍开钓向导（换鱼 / 换装备 / 重新调漂）" onClick={props.onReconfigure}>
              ⚙
            </button>
          </div>

          <div class="fish-hud-stats">
            <span>
              抛 <b>{current().counts.casts}</b>
            </span>
            <span>
              口 <b>{current().counts.bites}</b>
            </span>
            <span class="up">
              中 <b>{current().counts.catches}</b>
            </span>
            <span>
              空 <b>{current().counts.emptyHooks}</b>
            </span>
            <Show when={current().counts.breaks > 0}>
              <button type="button" class="fish-hud-ask down" title="切线跑鱼怎么办？" onClick={() => props.onAsk('line_break')}>
                切 <b>{current().counts.breaks}</b>
              </button>
            </Show>
          </div>

          <div class="fish-hud-conds">
            <Show when={current().conditions.drift}>
              <button type="button" class="chip chip-busy chip-ask" title="走水怎么办？" onClick={() => props.onAsk('drift')}>
                走水{current().conditions.antiDrift ? '（已加铅）' : ''} ›
              </button>
            </Show>
            <Show when={current().conditions.smallFish}>
              <button type="button" class="chip chip-busy chip-ask" title="小鱼闹窝怎么办？" onClick={() => props.onAsk('small_fish')}>
                小鱼闹窝 ›
              </button>
            </Show>
            <Show when={current().conditions.waterTemperature < 12}>
              <button type="button" class="chip chip-idle chip-ask" title="降温怎么钓？" onClick={() => props.onAsk('cold')}>
                水温 {current().conditions.waterTemperature}℃ ›
              </button>
            </Show>
            <Show when={props.session.world.time < current().conditions.nestUntil}>
              <span class="chip chip-idle">窝料在效</span>
            </Show>
            <button type="button" class="fish-hud-drill" aria-expanded={drill() ? 'true' : 'false'} onClick={() => setDrill(!drill())}>
              情况演练 {drill() ? '▴' : '▾'}
            </button>
          </div>

          <Show when={drill()}>
            <div class="fish-hud-drills">
              <For each={drills()}>
                {(item) => (
                  <button type="button" class={item.on ? 'gear-opt gear-opt-on' : 'gear-opt'} aria-pressed={item.on ? 'true' : 'false'} onClick={item.apply}>
                    {item.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
