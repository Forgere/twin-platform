import { createSignal, For, Show } from 'solid-js';
import {
  TAIDIAO_PRESETS,
  wizardAdvance,
  wizardRigState,
  wizardStart,
  wizardSuggestPreset,
  type WizardInput,
  type WizardState,
} from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../scene/studioSession';

/**
 * 调漂向导 —— 从零开始的引导交互。
 *
 * 面板本身不懂调钓：每一步的合法性都问 plugins-fishing 的 `wizardAdvance()`
 * （与引擎共用 calculateRigState 的校验），本地只管输入与展示。
 * 只有最后"完成"才把 t0 / t / w / d 写进 rig 实体 attrs——写入是可回放的
 * 世界变更，中途放弃不留任何痕迹。
 */

const RIG_ID = 'rig-01';

const ZONE_LABEL: Readonly<Record<string, string>> = {
  off_bottom: '未到底',
  sensitive: '灵区',
  neutral: '不灵不钝',
  blunt: '钝区',
  sinker_on_bottom: '铅坠触底',
};

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

export default function FishingSetupWizard(props: { session: StudioSession }) {
  const [state, setState] = createSignal<WizardState>(wizardStart());
  const [issue, setIssue] = createSignal<string>();

  /** 兼容老场景：外部导入的钓场可能没有 rig 实体，向导整体退化为提示。 */
  const hasRig = (): boolean => props.session.world.getEntity(RIG_ID) !== undefined;

  const advance = (input: WizardInput): void => {
    const result = wizardAdvance(state(), input);
    setState(result.state);
    setIssue(result.ok ? undefined : result.issue);
  };

  /** find_bottom 阶段的实时预览：本地状态算，不碰世界。 */
  const preview = (): ReturnType<typeof wizardRigState> => wizardRigState(state());

  /** 完成时一次性写入：t0 / t / w / d + 完成标记（决定下次进入是否再弹向导）。 */
  const applyTo = (finished: WizardState): void => {
    const rig = wizardRigState(finished);
    if (!rig) return;
    const world = props.session.world;
    world.setAttr(RIG_ID, 't0', rig.t0);
    world.setAttr(RIG_ID, 't', rig.t);
    world.setAttr(RIG_ID, 'w', rig.w);
    world.setAttr(RIG_ID, 'd', rig.d);
    world.setAttr(RIG_ID, 'wizardDone', true);
  };

  const confirm = (): void => {
    const result = wizardAdvance(state(), { kind: 'confirm' });
    if (result.ok) applyTo(result.state);
    setState(result.state);
    setIssue(result.ok ? undefined : result.issue);
  };

  const restart = (): void => {
    setState(wizardStart());
    setIssue(undefined);
  };

  const stepTitle = (): string => {
    switch (state().step) {
      case 'measure_t0':
        return '第 1 步 · 测无钩调目 t0';
      case 'measure_t':
        return '第 2 步 · 测带钩调目 t';
      case 'measure_w':
        return '第 3 步 · 测单饵压目 w';
      case 'choose_preset':
        return '第 4 步 · 选调钓预设';
      case 'find_bottom':
        return '第 5 步 · 找底定钓目 d';
      case 'done':
        return '完成 · 钓组已就位';
    }
  };

  const stepHint = (): string => {
    switch (state().step) {
      case 'measure_t0':
        return '半水、不挂钩：重铅找底后把漂往下推，直到漂尾露出你想要的目数。把露出的目数填进来。';
      case 'measure_t':
        return '挂上双钩再看漂尾露几目——钩有重量，目数会比 t0 低。';
      case 'measure_w':
        return '单钩挂一颗饵，看漂尾被压下去几目——这就是"单饵压目"。';
      case 'choose_preset':
        return '预设决定的是目标钓目；调目和饵重用你刚实测的值。不知道选哪个就用推荐的那个。';
      case 'find_bottom':
        return '假设双饵离底，一点点上推浮漂找底：左边的剖面图会实时显示灵钝分区，调到你觉得舒服的位置为止。';
      case 'done':
        return '参数已写入钓组，切到「剖面」页能看到钓组当前的灵钝落点。';
    }
  };

  return (
    <section aria-label="调漂向导">
      <h2>🧭 调漂向导</h2>
      <Show
        when={hasRig()}
        fallback={<p class="plugin-note">当前场景没有钓组实体（rig-01），向导只对钓场模板可用。</p>}
      >
        <p class="plugin-contrib">{stepTitle()}</p>
        <p class="plugin-note">{stepHint()}</p>

        <Show when={state().step === 'measure_t0'}>
          <NumberStep label="无钩调目 t0（目）" placeholder="如 6" onCommit={(value) => advance({ kind: 't0', value })} onInvalid={() => setIssue('请输入一个数字（目数可以是 0.5 这样的半目）。')} />
        </Show>
        <Show when={state().step === 'measure_t'}>
          <NumberStep label="带钩调目 t（目）" placeholder={`小于 t0 ${fmt(state().t0 ?? 0)}`} onCommit={(value) => advance({ kind: 't', value })} onInvalid={() => setIssue('请输入一个数字（目数可以是 0.5 这样的半目）。')} />
        </Show>
        <Show when={state().step === 'measure_w'}>
          <NumberStep label="单饵压目 w（目）" placeholder="如 1" onCommit={(value) => advance({ kind: 'w', value })} onInvalid={() => setIssue('请输入一个数字（目数可以是 0.5 这样的半目）。')} />
        </Show>

        <Show when={state().step === 'choose_preset'}>
          <div class="wizard-presets">
            <For each={TAIDIAO_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class={wizardSuggestPreset(state()).id === preset.id ? 'plugin-card ok wizard-preset' : 'plugin-card wizard-preset'}
                  onClick={() => advance({ kind: 'preset', presetId: preset.id })}
                >
                  <strong>{preset.label}</strong>
                  {wizardSuggestPreset(state()).id === preset.id ? <span class="plugin-version"> 推荐</span> : undefined}
                  <span class="plugin-contrib">调{fmt(preset.t)} 钓{fmt(preset.d)} · 单饵压 {fmt(preset.w)}</span>
                  <span class="plugin-note">{preset.note}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={state().step === 'find_bottom'}>
          <Show when={preview()} fallback={<p class="plugin-errors">参数组合算不出钓组状态，请返回检查。</p>}>
            {(rig) => (
              <>
                <p class="plugin-contrib">
                  钓目 d {fmt(rig().d)} · {ZONE_LABEL[rig().zone] ?? rig().zone} · 底承重 B {fmt(rig().bottomLoad)}
                </p>
                <p class="plugin-note">
                  可调范围 {fmt(rig().adjustableRange.min)}–{fmt(rig().adjustableRange.max)} 目 · d1/d2/d3 = {fmt(rig().criticalMarks.d1)}/{fmt(rig().criticalMarks.d2)}/{fmt(rig().criticalMarks.d3)}
                </p>
                <div class="decision-actions">
                  <button type="button" class="seg" onClick={() => advance({ kind: 'adjust', delta: -0.5 })}>
                    下推 0.5 目（灵）
                  </button>
                  <button type="button" class="seg" onClick={() => advance({ kind: 'adjust', delta: 0.5 })}>
                    上推 0.5 目（钝）
                  </button>
                  <button type="button" class="seg seg-active" onClick={confirm}>
                    就这样，完成
                  </button>
                </div>
              </>
            )}
          </Show>
        </Show>

        <Show when={state().step === 'done'}>
          <p class="plugin-contrib">
            t0 {fmt(state().t0 ?? 0)} · t {fmt(state().t ?? 0)} · w {fmt(state().w ?? 0)} · d {fmt(state().d ?? 0)}
          </p>
          <div class="decision-actions">
            <button type="button" class="seg" onClick={restart}>
              重新测一遍
            </button>
          </div>
        </Show>

        <Show when={issue()}>
          {(message) => <p class="plugin-errors">{message()}</p>}
        </Show>
      </Show>
    </section>
  );
}

/** 测量步的公共输入行：label + 数字框 + 下一步。 */
function NumberStep(props: { label: string; placeholder: string; onCommit: (value: number) => void; onInvalid: () => void }) {
  const [value, setValue] = createSignal('');
  const submit = (): void => {
    const parsed = Number.parseFloat(value());
    if (!Number.isFinite(parsed)) props.onInvalid();
    else props.onCommit(parsed);
  };
  return (
    <div class="decision-actions">
      <label class="plugin-contrib">
        {props.label}
        <input
          type="number"
          step="0.5"
          min="0"
          placeholder={props.placeholder}
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
      </label>
      <button type="button" class="seg seg-active" onClick={submit}>
        下一步
      </button>
    </div>
  );
}
