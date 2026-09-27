import { createSignal, For, Show } from 'solid-js';
import { fishById, LIFT_RESULT_LABEL, SIGNAL_LABEL, type FloatSignal, type SituationId } from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';
import { liftRod, readRig, recordCast, stepRigParam, type CastRecord } from './fishingWorld';

/**
 * 钓况 HUD —— 浮在画布右上角，开钓后一眼看到"我现在钓得怎么样"。
 *
 * 读：计数、灵钝、装备、漂相都来自 rig attrs（readRig）。
 * 写（都经 fishingWorld，可回放）：钓目滑块；模拟模式的「提杆」；实际做钓的逐竿记录（可选）。
 * 制造情况（走水 / 闹窝 / 降温）在助手里，HUD 只显示当前有哪些情况。
 *
 * 情况 chip 可点：直接把助手打开到对应情况的解答，看到问题的地方就能拿到对策。
 */

const ZONE_LABEL: Readonly<Record<string, string>> = {
  off_bottom: '未到底',
  sensitive: '偏灵',
  neutral: '不灵不钝',
  blunt: '偏钝',
  sinker_on_bottom: '铅坠触底',
};

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

/** 滑块上限：钓目到无钩调目 t0（d3）为止，再往上漂就只露出不到底了；当前值更高时放宽到当前值。 */
const depthMax = (rig: { t0: number; d: number }): number => Math.ceil(Math.max(rig.t0, rig.d) * 2) / 2;

const RECORDS: readonly { id: CastRecord; label: string }[] = [
  { id: 'none', label: '没口' },
  { id: 'caught', label: '🐟 中鱼' },
  { id: 'empty', label: '空钩' },
  { id: 'broken', label: '切线' },
];

const ZONE_CLASS: Readonly<Record<string, string>> = {
  off_bottom: 'zone-chip-off',
  sensitive: 'zone-chip-sens',
  neutral: 'zone-chip-neutral',
  blunt: 'zone-chip-blunt',
  sinker_on_bottom: 'zone-chip-lead',
};

export default function FishingHud(props: {
  session: StudioSession;
  tick: number;
  onReconfigure: () => void;
  onAsk: (situation: SituationId) => void;
}) {
  /** 实际做钓的逐竿记录：可选，默认不开——不记也能问助手做决策。 */
  const [recording, setRecording] = createSignal(false);
  const [issue, setIssue] = createSignal<string>();

  const rig = () => {
    props.tick;
    return readRig(props.session);
  };

  const signal = (): FloatSignal => {
    const value = rig()?.signal;
    return value === 'nod' || value === 'lift' || value === 'sink' || value === 'run' ? value : 'none';
  };

  return (
    <Show when={rig()}>
      {(current) => (
        <div class="fish-hud" aria-label="钓况">
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
            {/* 漂相与鱼种同一行、靠右：出现 / 消失都不改变 HUD 高度，下面的钓目滑块不会被顶动。 */}
            <Show when={current().mode === 'sim' && !current().manualLift && signal() !== 'none'}>
              <button type="button" class="fish-hud-signal" title="这是什么口？点开助手看怎么应对" onClick={() => props.onAsk('float_unclear')}>
                🔔 {SIGNAL_LABEL[signal()]}
              </button>
            </Show>
            <button type="button" class="fish-hud-btn" title="重新走一遍开钓向导（换鱼 / 换装备 / 重新调漂）" onClick={props.onReconfigure}>
              ⚙
            </button>
          </div>

          {/* 向导没走完（被 ✕ 关掉）：计数全是 0 没有意义，主操作是回去把钓组配好。 */}
          <Show when={!current().wizardDone}>
            <button type="button" class="onboard-next fish-hud-setup" onClick={props.onReconfigure}>
              🧭 钓组还没配好，继续开钓向导
            </button>
          </Show>

          {/* 钓目是开钓后最常调的一项：直接在 HUD 上拖滑块推漂（半目一格），灵钝区就在旁边。其余调目参数在右侧「钓组」页。 */}
          <Show when={current().wizardDone && current().state}>
            {(state) => (
              <div class="fish-hud-depth">
                <span>钓目</span>
                <input
                  type="range"
                  min="0"
                  max={String(depthMax(state().rig))}
                  step="0.5"
                  value={String(state().rig.d)}
                  aria-label="钓目（往左灵，往右钝）"
                  title="往左下推（往灵），往右上推（往钝）"
                  onInput={(event) => setIssue(stepRigParam(props.session, 'd', Number(event.currentTarget.value) - state().rig.d))}
                />
                <b>{fmt(state().rig.d)}</b>
                <span class={'zone-chip ' + (ZONE_CLASS[state().rig.zone] ?? '')}>{ZONE_LABEL[state().rig.zone]}</span>
              </div>
            )}
          </Show>
          <Show when={issue()}>{(message) => <p class="fish-hud-issue">{message()}</p>}</Show>

          {/* 模拟 + 手动提杆：漂动（有口）时按钮亮起并写出漂相，漂动完了还没提就算错过。 */}
          <Show when={current().wizardDone && current().mode === 'sim' && current().manualLift}>
            <button
              type="button"
              class={current().pendingBite ? 'fish-hud-lift fish-hud-lift-on' : 'fish-hud-lift'}
              title="看到漂动就提杆；没口乱提算空提"
              onClick={() => liftRod(props.session)}
            >
              {current().pendingBite ? '🎣 提杆！' + SIGNAL_LABEL[signal()] : '🎣 提杆'}
            </button>
            <p class="fish-hud-result" aria-live="polite">
              {current().lastLift ? LIFT_RESULT_LABEL[current().lastLift!] : '等漂动…'}
            </p>
          </Show>

          {/* 实际做钓：鱼口在真实钓点，这里只在用户愿意时逐竿记一笔（计数喂给助手的「现状」判断）。 */}
          <Show when={current().wizardDone && current().mode === 'real'}>
            <button type="button" class="fish-hud-drill fish-hud-record-toggle" aria-expanded={recording() ? 'true' : 'false'} onClick={() => setRecording(!recording())}>
              📝 记录{recording() ? ' ▴' : ' ▾'}
            </button>
            <Show when={recording()}>
              <div class="fish-hud-records" role="group" aria-label="记一竿">
                <For each={RECORDS}>
                  {(item) => (
                    <button type="button" class="gear-opt" onClick={() => recordCast(props.session, item.id)}>
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <div class="fish-hud-stats" hidden={!current().wizardDone || (current().mode === 'real' && !recording() && current().counts.casts === 0)}>
            <span>
              抛 <b>{current().counts.casts}</b>
            </span>
            <span>
              口 <b>{current().counts.bites}</b>
            </span>
            <span class="up">
              中 <b>{current().counts.catches}</b>
              {/* 中口率回答"打得准不准"：有口才有意义。 */}
              <Show when={current().counts.bites > 0}>
                <em class="fish-hud-rate"> {Math.round((100 * current().counts.catches) / current().counts.bites)}%</em>
              </Show>
            </span>
            <span>
              空 <b>{current().counts.emptyHooks}</b>
            </span>
            <Show when={current().counts.missed > 0}>
              <span title="漂动了没提，错过的口">
                漏 <b>{current().counts.missed}</b>
              </span>
            </Show>
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
          </div>

        </div>
      )}
    </Show>
  );
}
