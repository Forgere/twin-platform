import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { BAITS, GEAR_OPTIONS, TARGET_FISH, type Loadout } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { readRig, rigEditIssue, stepRigParam, switchGear, type RigSnapshot } from './fishingWorld';
import { GEAR_FIELDS } from './RigSettings';

type GearKey = (typeof GEAR_FIELDS)[number]['key'] | 'targetFish' | 'bait';
type Panel = GearKey | 'd' | 'more';
const LABELS = { bait: '换饵', d: '调钓目', more: '更多调整', targetFish: '目标鱼', rodLength: '竿长', mainLine: '主线', subLine: '子线', hookSize: '钩', floatSize: '浮漂' } as const;

/** 播放器式控制条：离散项目竖向快选，数值竖向拖动，一次只展开一项。 */
export default function QuickRigSettings(props: { session: StudioSessionPort; rig: RigSnapshot }) {
  const [panel, setPanel] = createSignal<Panel | undefined>(undefined, { name: 'fishing.quick.panel' });
  const [issue, setIssue] = createSignal<string | undefined>(undefined, { name: 'fishing.quick.issue' });
  const [anchor, setAnchor] = createSignal(0, { name: 'fishing.quick.anchor' });
  const [depthMax, setDepthMax] = createSignal(13, { name: 'fishing.quick.depthMax' });
  let trigger: HTMLButtonElement | undefined;
  let root!: HTMLDivElement;
  const blocked = () => rigEditIssue(props.rig);
  const close = (restoreFocus = true): void => {
    setPanel(undefined);
    setIssue(undefined);
    if (restoreFocus) trigger?.focus();
  };
  const open = (value: Panel, button: HTMLButtonElement): void => {
    if (trigger === button && panel() !== undefined) { close(); return; }
    trigger = button;
    setAnchor(button.offsetLeft + button.offsetWidth / 2);
    setIssue(undefined);
    if (value === 'd') {
      const rig = props.rig.state?.rig;
      setDepthMax(Math.ceil(Math.max(rig?.t0 ?? 0, rig?.d ?? 0, 0.5) * 2) / 2);
    }
    setPanel(value);
  };
  const outside = (event: PointerEvent): void => {
    if (panel() !== undefined && !root.contains(event.target as Node)) close(false);
  };
  document.addEventListener('pointerdown', outside);
  onCleanup(() => document.removeEventListener('pointerdown', outside));

  const choices = () => panel() === 'bait'
    ? BAITS.map((bait) => ({ value: bait.id, label: bait.label }))
    : TARGET_FISH.map((fish) => ({ value: fish.id, label: fish.label }));
  const selected = (value: string): boolean => {
    const key = panel();
    return (key === 'bait' || key === 'targetFish') && props.rig.loadout[key] === value;
  };
  const choose = (value: string): void => {
    const key = panel();
    if (key !== 'bait' && key !== 'targetFish') return;
    const result = switchGear(props.session, { [key]: value } as Partial<Loadout>);
    if (result) setIssue(result);
    else close();
  };
  const numeric = createMemo(() => {
    const key = panel();
    if (key === 'd') return { key, value: props.rig.state?.rig.d ?? 0, min: 0, max: depthMax(), step: 0.5, text: `${props.rig.state?.rig.d ?? 0} 目`, low: '调灵', high: '调钝' };
    const field = GEAR_FIELDS.find((field) => field.key === key);
    if (!field) return undefined;
    const values = GEAR_OPTIONS[field.key] as readonly number[];
    const value = props.rig.loadout[field.key];
    const index = values.reduce((nearest, item, i) => Math.abs(item - value) < Math.abs(values[nearest]! - value) ? i : nearest, 0);
    return { key: field.key, value: index, min: 0, max: values.length - 1, step: 1, text: `${value}${field.unit}`, low: `${values[0]}${field.unit}`, high: `${values.at(-1)}${field.unit}` };
  }, { name: 'fishing.quick.numeric' });
  const drag = (input: HTMLInputElement): void => {
    const spec = numeric();
    const current = readRig(props.session);
    if (!spec || !current) return;
    const value = Number(input.value);
    let result: string | undefined;
    if (spec.key === 'd') {
      // 拖动连续事件可能先于下一个UI tick；必须对最新世界值求差，不能累加旧快照。
      const previous = current.state?.rig.d;
      if (previous === undefined || previous === value) return;
      result = stepRigParam(props.session, 'd', value - previous);
    } else {
      const values = GEAR_OPTIONS[spec.key] as readonly number[];
      const target = values[value];
      if (target === undefined || target === current.loadout[spec.key]) return;
      result = switchGear(props.session, { [spec.key]: target });
    }
    setIssue(result);
    if (result) input.value = String(spec.value);
  };

  return (
    <div ref={root} class="fish-quick" style={{ '--quick-anchor': `${anchor()}px` }}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div class="fish-quick-triggers" role="group" aria-label="快捷调整">
        <button type="button" disabled={!!blocked()} title={blocked()} aria-expanded={panel() === 'bait' ? 'true' : 'false'} onClick={(event) => open('bait', event.currentTarget)}>换饵</button>
        <button type="button" disabled={!!blocked()} title={blocked()} aria-expanded={panel() === 'd' ? 'true' : 'false'} onClick={(event) => open('d', event.currentTarget)}>钓 {props.rig.state?.rig.d ?? '—'} 目</button>
        <button type="button" disabled={!!blocked()} title={blocked()} aria-expanded={panel() !== undefined && panel() !== 'bait' && panel() !== 'd' ? 'true' : 'false'} onClick={(event) => open('more', event.currentTarget)}>更多</button>
      </div>
      <Show when={panel()}>{(active) => (
        <section class={'fish-quick-panel' + (numeric() ? ' fish-quick-panel-numeric' : '')} aria-label={LABELS[active()]}
          onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
          <header><strong>{LABELS[active()]}</strong><button type="button" aria-label="关闭调整" onClick={() => close()}>✕</button></header>
          <Show when={blocked()}>{(message) => <p class="plugin-note">{message()}</p>}</Show>
          <Show when={issue()}>{(message) => <p class="plugin-errors" role="alert">{message()}</p>}</Show>
          <Show when={active() === 'more'}>
            <div class="fish-quick-options">
              <button type="button" onClick={() => setPanel('targetFish')}>目标鱼</button>
              <For each={GEAR_FIELDS}>{(field) => <button type="button" onClick={() => setPanel(field.key)}>{field.label} · {props.rig.loadout[field.key]}{field.unit}</button>}</For>
            </div>
          </Show>
          <Show when={numeric()}>{(spec) => (
            <div class="fish-quick-number">
              <output>{spec().text}</output>
              <span>{spec().high}</span>
              <input type="range" aria-label={LABELS[spec().key]} aria-orientation="vertical" min={spec().min} max={spec().max} step={spec().step}
                value={String(spec().value)} disabled={!!blocked()} onInput={(event) => drag(event.currentTarget)} />
              <span>{spec().low}</span>
            </div>
          )}</Show>
          <Show when={active() === 'bait' || active() === 'targetFish'}>
            <div class="fish-quick-options">
              <For each={choices()}>{(option) => <button type="button" disabled={!!blocked()} aria-pressed={selected(option.value) ? 'true' : 'false'} onClick={() => choose(option.value)}>{option.label}</button>}</For>
            </div>
          </Show>
          <Show when={active() === 'bait' || active() === 'hookSize' || active() === 'floatSize'}>
            <p class="plugin-note">更换后请在右侧核对测量值。</p>
          </Show>
        </section>
      )}</Show>
    </div>
  );
}
