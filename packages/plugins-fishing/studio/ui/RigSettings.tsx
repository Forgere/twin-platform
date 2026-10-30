import { createSignal, For, Show } from 'solid-js';
import { BAITS, GEAR_OPTIONS, TARGET_FISH, loadoutChecks, type Loadout } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { rigEditIssue, stepRigParam, switchGear, type RigSnapshot } from './fishingWorld';

export const GEAR_FIELDS = [
  { key: 'rodLength', label: '竿长', unit: 'm' },
  { key: 'mainLine', label: '主线', unit: '号' },
  { key: 'subLine', label: '子线', unit: '号' },
  { key: 'hookSize', label: '钩', unit: '号' },
  { key: 'floatSize', label: '浮漂', unit: 'g' },
] as const;
const RIG_FIELDS = [
  { key: 't0', label: '无钩调目' },
  { key: 't', label: '带钩调目' },
  { key: 'w', label: '单饵压目' },
] as const;
const fmt = (value: number): string => String(Math.round(value * 100) / 100);

/** 右侧完整钓组编辑；中间快捷栏复用装备选项与写入口，不展开整张表单。 */
export default function RigSettings(props: { session: StudioSessionPort; rig: RigSnapshot }) {
  const [issue, setIssue] = createSignal<string | undefined>(undefined, { name: 'fishing.settings.issue' });
  const blocked = () => rigEditIssue(props.rig);
  const checks = () => loadoutChecks(props.rig.loadout).filter((check) => check.level !== 'ok');
  const setGear = (patch: Partial<Loadout>): void => { setIssue(switchGear(props.session, patch)); };
  const step = (key: 't0' | 't' | 'w' | 'd', delta: number): void => { setIssue(stepRigParam(props.session, key, delta)); };

  return (
    <div class="rig-settings">
      <Show when={blocked()}>{(message) => <p class="plugin-note">{message()}</p>}</Show>
      <Show when={issue()}>{(message) => <p class="plugin-errors" role="alert">{message()}</p>}</Show>
      <fieldset disabled={!!blocked()}>
        <legend>目标鱼与装备</legend>
        <div class="rig-gear">
          <label><span>目标鱼</span>
            <select value={props.rig.loadout.targetFish} onChange={(event) => setGear({ targetFish: event.currentTarget.value as Loadout['targetFish'] })}>
              <For each={TARGET_FISH}>{(fish) => <option value={fish.id}>{fish.label}</option>}</For>
            </select>
          </label>
          <For each={GEAR_FIELDS}>{(field) => (
            <label><span>{field.label}</span>
              <select value={String(props.rig.loadout[field.key])} onChange={(event) => setGear({ [field.key]: Number(event.currentTarget.value) })}>
                <For each={GEAR_OPTIONS[field.key]}>{(option) => <option value={String(option)}>{option}{field.unit}</option>}</For>
              </select>
            </label>
          )}</For>
          <label><span>饵</span>
            <select value={props.rig.loadout.bait} onChange={(event) => setGear({ bait: event.currentTarget.value as Loadout['bait'] })}>
              <For each={BAITS}>{(bait) => <option value={bait.id}>{bait.label}</option>}</For>
            </select>
          </label>
        </div>
        <ul class="gear-checks">
          <Show when={checks().length === 0}><li class="gear-check gear-check-ok">配伍合理</li></Show>
          <For each={checks()}>{(check) => <li class={'gear-check gear-check-' + check.level}>{check.message}</li>}</For>
        </ul>
        <Show when={props.rig.state}>{(state) => (
          <label class="rig-depth">
            <span>钓目 <b>{fmt(state().rig.d)}</b> · 往左灵，往右钝</span>
            <input type="range" min="0" max={String(Math.ceil(Math.max(state().rig.t0, state().rig.d) * 2) / 2)} step="0.5"
              value={String(state().rig.d)} aria-label="钓目（往左灵，往右钝）"
              onInput={(event) => step('d', Number(event.currentTarget.value) - state().rig.d)} />
          </label>
        )}</Show>
        <p class="plugin-note">换钩、换饵或换漂后，请在下方核对测量值；不会自动覆盖实测调目。</p>
        <details class="rig-more">
          <summary>调目（测量值）</summary>
          <div class="rig-fields">
            <For each={RIG_FIELDS}>{(field) => (
              <div class="rig-field">
                <span>{field.label}</span>
                <button type="button" aria-label={field.label + ' 减半目'} onClick={() => step(field.key, -0.5)}>−</button>
                <b>{fmt(props.rig.state?.rig[field.key] ?? 0)}</b>
                <button type="button" aria-label={field.label + ' 加半目'} onClick={() => step(field.key, 0.5)}>+</button>
              </div>
            )}</For>
          </div>
        </details>
      </fieldset>
    </div>
  );
}
