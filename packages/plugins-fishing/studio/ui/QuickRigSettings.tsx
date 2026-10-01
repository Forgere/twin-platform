import { createSignal, For, Show } from 'solid-js';
import { BAITS, GEAR_OPTIONS, TARGET_FISH, type Loadout } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { rigEditIssue, stepRigParam, switchGear, type RigSnapshot } from './fishingWorld';
import { GEAR_FIELDS } from './RigSettings';

type GearKey = (typeof GEAR_FIELDS)[number]['key'] | 'targetFish' | 'bait';
type Panel = GearKey | 'd' | 'more';
const LABELS = { bait: '换饵', d: '调钓目', more: '更多调整', targetFish: '目标鱼', rodLength: '竿长', mainLine: '主线', subLine: '子线', hookSize: '钩', floatSize: '浮漂' } as const;

/** 中间只处理当前这一项；低频装备先选项目，再选值。 */
export default function QuickRigSettings(props: { session: StudioSessionPort; rig: RigSnapshot }) {
  const [panel, setPanel] = createSignal<Panel | undefined>(undefined, { name: 'fishing.quick.panel' });
  const [issue, setIssue] = createSignal<string | undefined>(undefined, { name: 'fishing.quick.issue' });
  let trigger: HTMLButtonElement | undefined;
  const blocked = () => rigEditIssue(props.rig);
  const open = (value: Panel, button: HTMLButtonElement): void => {
    trigger = button;
    setIssue(undefined);
    setPanel(panel() === value ? undefined : value);
  };
  const close = (): void => {
    setPanel(undefined);
    setIssue(undefined);
    trigger?.focus();
  };
  const options = () => {
    const key = panel();
    if (key === 'bait') return BAITS.map((bait) => ({ value: bait.id, label: bait.label }));
    if (key === 'targetFish') return TARGET_FISH.map((fish) => ({ value: fish.id, label: fish.label }));
    const field = GEAR_FIELDS.find((field) => field.key === key);
    return field ? GEAR_OPTIONS[field.key].map((value) => ({ value: String(value), label: `${value}${field.unit}` })) : [];
  };
  const selected = (value: string): boolean => {
    const key = panel();
    return key !== undefined && key !== 'more' && key !== 'd' && String(props.rig.loadout[key]) === value;
  };
  const choose = (value: string): void => {
    const key = panel();
    if (!key || key === 'more' || key === 'd') return;
    const result = switchGear(props.session, { [key]: key === 'bait' || key === 'targetFish' ? value : Number(value) } as Partial<Loadout>);
    if (result) setIssue(result);
    else close();
  };
  const step = (delta: number): void => { setIssue(stepRigParam(props.session, 'd', delta)); };

  return (
    <div class="fish-quick" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div class="fish-quick-triggers" role="group" aria-label="快捷调整">
        <button type="button" disabled={!!blocked()} title={blocked()} aria-expanded={panel() === 'bait' ? 'true' : 'false'} onClick={(event) => open('bait', event.currentTarget)}>换饵</button>
        <button type="button" disabled={!!blocked()} title={blocked()} aria-expanded={panel() === 'd' ? 'true' : 'false'} onClick={(event) => open('d', event.currentTarget)}>钓 {props.rig.state?.rig.d ?? '—'} 目</button>
        <button type="button" disabled={!!blocked()} title={blocked()} aria-expanded={panel() !== undefined && panel() !== 'bait' && panel() !== 'd' ? 'true' : 'false'} onClick={(event) => open('more', event.currentTarget)}>更多</button>
      </div>
      <Show when={panel()}>{(active) => (
        <section class="fish-quick-panel" aria-label={LABELS[active()]}>
          <header><strong>{LABELS[active()]}</strong><button type="button" aria-label="关闭调整" onClick={close}>✕</button></header>
          <Show when={blocked()}>{(message) => <p class="plugin-note">{message()}</p>}</Show>
          <Show when={issue()}>{(message) => <p class="plugin-errors" role="alert">{message()}</p>}</Show>
          <Show when={active() === 'more'}>
            <div class="fish-quick-options">
              <button type="button" onClick={() => setPanel('targetFish')}>目标鱼</button>
              <For each={GEAR_FIELDS}>{(field) => <button type="button" onClick={() => setPanel(field.key)}>{field.label} · {props.rig.loadout[field.key]}{field.unit}</button>}</For>
            </div>
          </Show>
          <Show when={active() === 'd'}>
            <div class="fish-quick-depth">
              <button type="button" disabled={!!blocked()} aria-label="钓目减半目" onClick={() => step(-0.5)}>−½</button>
              <b>{props.rig.state?.rig.d} 目</b>
              <button type="button" disabled={!!blocked()} aria-label="钓目加半目" onClick={() => step(0.5)}>+½</button>
              <button type="button" onClick={close}>完成</button>
            </div>
            <p class="plugin-note">减目偏灵，加目偏钝。</p>
          </Show>
          <Show when={active() !== 'more' && active() !== 'd'}>
            <div class="fish-quick-options">
              <For each={options()}>{(option) => <button type="button" disabled={!!blocked()} aria-pressed={selected(option.value) ? 'true' : 'false'} onClick={() => choose(option.value)}>{option.label}</button>}</For>
            </div>
            <Show when={active() === 'bait' || active() === 'hookSize' || active() === 'floatSize'}>
              <p class="plugin-note">更换后请核对调目；测量值在右侧钓组中调整。</p>
            </Show>
          </Show>
        </section>
      )}</Show>
    </div>
  );
}
