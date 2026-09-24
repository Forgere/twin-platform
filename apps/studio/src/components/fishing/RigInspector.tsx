import { createSignal, For, Show } from 'solid-js';
import {
  BAITS,
  GEAR_OPTIONS,
  TARGET_FISH,
  calculateRigState,
  loadoutChecks,
  rigPosture,
  type Loadout,
} from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';
import { readRig, writeRig } from './fishingWorld';

/**
 * 钓组检视页（右侧编辑器 · 钓场专属）。
 *
 * 和浮层向导的区别：向导是"带你从 0 走到开钓"，这里是"老手直接改参数"——
 * 调目 / 钓目用步进、装备用下拉，改了立刻写进世界（可回放），画面和鱼口马上变。
 * 每次改动都先过 calculateRigState：不合法的组合根本写不进去，原因直接显示。
 */

const RIG_FIELDS: { key: 't0' | 't' | 'w' | 'd'; label: string; hint: string }[] = [
  { key: 't0', label: '无钩调目 t0', hint: '半水不挂钩露出目数' },
  { key: 't', label: '带钩调目 t', hint: '挂双钩后露出目数' },
  { key: 'w', label: '单饵压目 w', hint: '一颗饵压下去几目' },
  { key: 'd', label: '钓目 d', hint: '实钓露出目数（上推 = 钝）' },
];

const GEAR_FIELDS: { key: 'rodLength' | 'mainLine' | 'subLine' | 'hookSize' | 'floatSize'; label: string; unit: string }[] = [
  { key: 'rodLength', label: '竿长', unit: 'm' },
  { key: 'mainLine', label: '主线', unit: '号' },
  { key: 'subLine', label: '子线', unit: '号' },
  { key: 'hookSize', label: '钩', unit: '号' },
  { key: 'floatSize', label: '浮漂', unit: 'g' },
];

const ZONE_TEXT: Readonly<Record<string, [string, string]>> = {
  off_bottom: ['未到底', 'zone-chip-off'],
  sensitive: ['偏灵', 'zone-chip-sens'],
  neutral: ['不灵不钝', 'zone-chip-neutral'],
  blunt: ['偏钝', 'zone-chip-blunt'],
  sinker_on_bottom: ['铅坠触底', 'zone-chip-lead'],
};

const CHECK_ICON: Readonly<Record<string, string>> = { ok: '✅', warn: '⚠️', error: '⛔' };
const problems = (loadout: Loadout) => loadoutChecks(loadout).filter((check) => check.level !== 'ok');
const fmt = (value: number): string => String(Math.round(value * 100) / 100);

export default function RigInspector(props: { session: StudioSession; tick: number; onReconfigure: () => void }) {
  const [issue, setIssue] = createSignal<string>();

  const rig = () => {
    props.tick;
    return readRig(props.session);
  };

  const step = (key: 't0' | 't' | 'w' | 'd', delta: number): void => {
    const current = rig()?.state?.rig;
    if (!current) return;
    const input = { t0: current.t0, t: current.t, w: current.w, d: current.d };
    const next = { ...input, [key]: Math.round((input[key] + delta) * 2) / 2 };
    const result = calculateRigState(next);
    if (!result.ok) {
      setIssue(result.issues.map((item) => item.message).join(' '));
      return;
    }
    setIssue(undefined);
    writeRig(props.session, { [key]: next[key] });
  };

  const setGear = (patch: Partial<Loadout>): void => {
    writeRig(props.session, patch as Record<string, number | string>);
  };

  return (
    <section aria-label="钓组">
      <Show when={rig()} fallback={<p class="plugin-note">当前场景没有钓组实体（rig-01）。</p>}>
        {(current) => (
          <>
            <div class="rig-head">
              <h2>🎣 钓组</h2>
              <button type="button" class="seg" onClick={props.onReconfigure}>
                🧭 开钓向导
              </button>
            </div>

            <Show when={current().state}>
              {(state) => <p class="rig-summary">{rigPosture(state().rig, { drift: state().drift }).summary}（逐部件状态见「剖面」页）</p>}
            </Show>
            <Show when={current().error}>{(message) => <p class="plugin-errors">{message()}</p>}</Show>

            <h3>调钓参数</h3>
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
                    {/* 钓目的后果就在旁边：改 d 立刻看到落到哪个灵钝区，不用去读上面的总结句。 */}
                    <Show when={field.key === 'd' && current().state}>
                      {(state) => (
                        <span class={'zone-chip ' + (ZONE_TEXT[state().rig.zone]?.[1] ?? '')}>{ZONE_TEXT[state().rig.zone]?.[0] ?? state().rig.zone}</span>
                      )}
                    </Show>
                  </div>
                )}
              </For>
            </div>
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
                <select value={current().loadout.bait} onChange={(event) => setGear({ bait: event.currentTarget.value as Loadout['bait'] })}>
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

          </>
        )}
      </Show>
    </section>
  );
}
