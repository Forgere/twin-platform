import { createSignal, For, Show } from 'solid-js';
import {
  BAITS,
  GEAR_OPTIONS,
  TARGET_FISH,
  loadoutChecks,
  type Loadout,
} from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';
import { readRig, stepRigParam, writeRig } from './fishingWorld';
import FishingSandbox from '../FishingSandbox';
import DecisionPanel from '../DecisionPanel';

/**
 * 钓组页 —— 右侧检视区里钓场的**唯一**一页。
 *
 * 分工：HUD 只读钓况，底部负责抛竿/提竿/快捷换饵；向导管「从 0 配到开钓」。
 * 这一页管剖面、钓目与装备，测量值及判断者记录默认收起。
 * 每次改动都先过 calculateRigState：不合法的组合根本写不进去，原因直接显示。
 */

const RIG_FIELDS: { key: 't0' | 't' | 'w'; label: string; hint: string }[] = [
  { key: 't0', label: '无钩调目 t0', hint: '半水不挂钩露出目数' },
  { key: 't', label: '带钩调目 t', hint: '挂双钩后露出目数' },
  { key: 'w', label: '单饵压目 w', hint: '一颗饵压下去几目' },
];

const GEAR_FIELDS: { key: 'rodLength' | 'mainLine' | 'subLine' | 'hookSize' | 'floatSize'; label: string; unit: string }[] = [
  { key: 'rodLength', label: '竿长', unit: 'm' },
  { key: 'mainLine', label: '主线', unit: '号' },
  { key: 'subLine', label: '子线', unit: '号' },
  { key: 'hookSize', label: '钩', unit: '号' },
  { key: 'floatSize', label: '浮漂', unit: 'g' },
];

const CHECK_ICON: Readonly<Record<string, string>> = { ok: '✅', warn: '⚠️', error: '⛔' };
const problems = (loadout: Loadout) => loadoutChecks(loadout).filter((check) => check.level !== 'ok');
const fmt = (value: number): string => String(Math.round(value * 100) / 100);

export default function RigInspector(props: { session: StudioSession; tick: number }) {
  const [issue, setIssue] = createSignal<string>();

  const rig = () => {
    props.tick;
    return readRig(props.session);
  };

  const step = (key: 't0' | 't' | 'w' | 'd', delta: number): void => {
    setIssue(stepRigParam(props.session, key, delta));
  };

  const setGear = (patch: Partial<Loadout>): void => {
    // 上一次调目被拒的原因针对的是旧参数，换装备后不再成立。
    setIssue(undefined);
    writeRig(props.session, patch as Record<string, number | string>);
  };

  return (
    <section aria-label="钓组">
      <h2>🎣 钓组</h2>
      <Show when={rig()} fallback={<p class="plugin-note">当前场景没有钓组实体（rig-01）。</p>}>
        {(current) => (
          <>
            <FishingSandbox session={props.session} tick={props.tick} />

            <Show when={current().error}>{(message) => <p class="plugin-errors">{message()}</p>}</Show>

            <Show when={current().wizardDone && current().state}>
              {(state) => (
                <label class="rig-depth">
                  <span>钓目 <b>{fmt(state().rig.d)}</b> · 往左灵，往右钝</span>
                  <input
                    type="range"
                    min="0"
                    max={String(Math.ceil(Math.max(state().rig.t0, state().rig.d) * 2) / 2)}
                    step="0.5"
                    value={String(state().rig.d)}
                    aria-label="钓目（往左灵，往右钝）"
                    disabled={!current().ready}
                    onInput={(event) => step('d', Number(event.currentTarget.value) - state().rig.d)}
                  />
                </label>
              )}
            </Show>
            <Show when={issue()}>{(message) => <p class="plugin-errors">{message()}</p>}</Show>
            <h3>目标鱼与装备</h3>
            <div class="rig-gear">
              <label>
                <span>目标鱼</span>
                <select
                  value={current().loadout.targetFish}
                  onChange={(event) => setGear({ targetFish: event.currentTarget.value as Loadout['targetFish'] })}
                >
                  <For each={TARGET_FISH}>{(fish) => <option value={fish.id}>{fish.label}</option>}</For>
                </select>
              </label>
              <For each={GEAR_FIELDS}>
                {(field) => (
                  <label>
                    <span>{field.label}</span>
                    <select
                      value={String(current().loadout[field.key])}
                      onChange={(event) => setGear({ [field.key]: Number(event.currentTarget.value) })}
                    >
                      <For each={GEAR_OPTIONS[field.key] as readonly number[]}>
                        {(option) => (
                          <option value={String(option)}>
                            {option}
                            {field.unit}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                )}
              </For>
              <label>
                <span>饵</span>
                <select value={current().loadout.bait} disabled={current().inWater || current().pendingBite} title="收竿后可换饵" onChange={(event) => setGear({ bait: event.currentTarget.value as Loadout['bait'] })}>
                  <For each={BAITS}>{(bait) => <option value={bait.id}>{bait.label}</option>}</For>
                </select>
              </label>
            </div>
            <ul class="gear-checks">
              {/* 老手页只列需要处理的问题；全部合格时一行带过，不把 ✅ 刷满一屏。 */}
              <Show when={problems(current().loadout).length === 0}>
                <li class="gear-check gear-check-ok">
                  <span aria-hidden="true">✅</span> 配伍合理
                </li>
              </Show>
              <For each={problems(current().loadout)}>
                {(check) => (
                  <li class={'gear-check gear-check-' + check.level}>
                    <span aria-hidden="true">{CHECK_ICON[check.level]}</span> {check.message}
                  </li>
                )}
              </For>
            </ul>

            {/* 调目是开钓前测一次的量，平时很少动：默认收起，把位置让给常用的装备调整。 */}
            <details class="rig-more">
              <summary>调目（测量值）</summary>
            <div class="rig-fields">
              <For each={RIG_FIELDS}>
                {(field) => (
                  <div class="rig-field" title={field.hint}>
                    <span>{field.label}</span>
                    <button type="button" aria-label={field.label + ' 减半目'} onClick={() => step(field.key, -0.5)}>
                      −
                    </button>
                    <b>{fmt(current().state?.rig[field.key] ?? 0)}</b>
                    <button type="button" aria-label={field.label + ' 加半目'} onClick={() => step(field.key, 0.5)}>
                      +
                    </button>
                  </div>
                )}
              </For>
            </div>
            </details>

            {/* 判断者的执行与 👍👎 在钓鱼助手里；这里只留跨会话的记录与校准，默认收起。 */}
            <details class="rig-more">
              <summary>判断者记录与校准</summary>
              <DecisionPanel session={props.session} />
            </details>
          </>
        )}
      </Show>
    </section>
  );
}
