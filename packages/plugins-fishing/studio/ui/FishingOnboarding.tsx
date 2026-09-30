import { createSignal, For, onSettled, Show } from 'solid-js';
import {
  BAITS,
  GEAR_OPTIONS,
  TAIDIAO_PRESETS,
  TARGET_FISH,
  WIZARD_STEPS,
  estimateMarks,
  fishById,
  loadoutChecks,
  loadoutToAttrs,
  presetById,
  rigPosture,
  wizardAdvance,
  wizardRigState,
  wizardStart,
  wizardSuggestPreset,
  type FishingMode,
  type Loadout,
  type RigPhase,
  type WizardInput,
  type WizardState,
  type WizardStep,
} from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { readRig, RIG_ID, setFishingMode, writeRig } from './fishingWorld';

/**
 * 开钓向导 —— 应用的起点，住在钓鱼助手里（助手先带你配钓组，再陪你钓），不占右侧编辑器。
 *
 * 收集信息**全部用选择**：鱼是卡片、装备是分段按钮、调目是"点漂尾露出的那一目"、
 * 调法是卡片、找底是上推 / 下推。没有一个必须手打的输入框。
 *
 * 每一步的合法性都问 plugins-fishing 的 `wizardAdvance()`（与引擎共用校验）。
 * 找底这一步把钓目**实时写进世界**并推一帧：3D 里的漂、铅、钩跟着动，
 * 用户看到的就是自己这个决定的后果。用户点 ✕ 半途关闭会把钓组还原成打开前的样子。
 * 最后一步二选一：模拟开钓（数字钓场出鱼口、自己提杆）或实际做钓（真实钓点，助手陪着做决策）。
 *
 * 一个实例只服务一个会话（父组件用 keyed Show 按会话重建），所以会话在创建时取一次；
 * 还原 / 恢复播放只在用户明确关闭时做，不放进 onCleanup——换会话时旧世界已被丢弃，
 * 再往里写（还会推帧、录事件）只会制造噪音。
 */

const STEP_LABEL: Readonly<Record<WizardStep, string>> = {
  choose_fish: '选鱼',
  choose_gear: '装备',
  measure_t0: '调目',
  measure_t: '钩重',
  measure_w: '饵重',
  choose_preset: '调法',
  find_bottom: '找底',
  done: '开钓',
};

const ZONE_LABEL: Readonly<Record<string, string>> = {
  off_bottom: '未到底',
  sensitive: '偏灵',
  neutral: '不灵不钝',
  blunt: '偏钝',
  sinker_on_bottom: '铅坠触底',
};

const GEAR_ROWS: { key: 'rodLength' | 'mainLine' | 'subLine' | 'hookSize' | 'floatSize'; label: string; unit: string }[] = [
  { key: 'rodLength', label: '竿长', unit: 'm' },
  { key: 'mainLine', label: '主线', unit: '号' },
  { key: 'subLine', label: '子线', unit: '号' },
  { key: 'hookSize', label: '钩', unit: '号' },
  { key: 'floatSize', label: '浮漂', unit: 'g' },
];

const CHECK_ICON: Readonly<Record<string, string>> = { ok: '✅', warn: '⚠️', error: '⛔' };

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

/** 打开向导前的钓组参数：中途关闭时原样写回。 */
const SNAPSHOT_KEYS = ['t0', 't', 'w', 'd'] as const;

/** 向导步骤 → 线组此刻实际挂成的样子（见 plugins-fishing 的 RigPhase）。 */
const STEP_PHASE: Readonly<Record<WizardStep, RigPhase>> = {
  choose_fish: 'setup',
  choose_gear: 'setup',
  measure_t0: 'measure_t0',
  measure_t: 'measure_t',
  measure_w: 'measure_w',
  choose_preset: 'setup',
  find_bottom: 'find_bottom',
  done: 'find_bottom',
};

export default function FishingOnboarding(props: { session: StudioSessionPort; onClose: () => void }) {
  // 会话在创建时取一次：父组件按会话 keyed 重建本组件，这里不会被偷换。
  const session = props.session;
  const [state, setState] = createSignal<WizardState>(wizardStart());
  const [issue, setIssue] = createSignal<string>();
  /** 配伍 error 被拦过一次：再点就是"坚持使用"。 */
  const [insist, setInsist] = createSignal(false);
  /** 测量步当前选中的目数（点漂尾 / ±半目）。 */
  const [marks, setMarks] = createSignal<number>();

  const before: Record<string, unknown> = {};
  const wasPlaying = session.controller.playing;
  let finished = false;

  onSettled(() => {
    const attrs = session.world.getEntity(RIG_ID)?.attrs ?? {};
    for (const key of SNAPSHOT_KEYS) before[key] = attrs[key];
    before.rigPhase = attrs.rigPhase;
    syncRig(state(), undefined);
    // 调漂时鱼不该在咬钩：暂停仿真，找底预览靠手动推帧刷新。
    session.controller.pause();
  });

  /** 用户点 ✕：没走完就把钓组还原，仿真恢复打开前的播放状态。 */
  const dismiss = (): void => {
    if (!finished) {
      const restore: Record<string, number | string> = {};
      for (const key of SNAPSHOT_KEYS) if (typeof before[key] === 'number') restore[key] = before[key] as number;
      // 向导从没走完过 → 回到 setup（不抛竿）；重新配置被放弃 → 恢复原来的阶段。
      restore.rigPhase = readRig(session)?.wizardDone ? (typeof before.rigPhase === 'string' ? before.rigPhase : 'fishing') : 'setup';
      writeRig(session, restore);
    }
    if (wasPlaying || finished) session.controller.play();
    props.onClose();
  };

  const loadout = (): Loadout | undefined => state().loadout;

  /**
   * 推进一步或几步。Solid 2 的信号写入是延迟生效的——写完立刻读 `state()` 还是旧值，
   * 所以多步连推（模拟测量）必须在本地把状态串起来，最后只写一次信号。
   */
  const advance = (...inputs: WizardInput[]): WizardState | undefined => {
    let current = state();
    for (const input of inputs) {
      const result = wizardAdvance(current, input);
      current = result.state;
      if (!result.ok) {
        setState(current);
        setIssue(result.issue);
        return undefined;
      }
    }
    setState(current);
    setIssue(undefined);
    setInsist(false);
    setMarks(undefined);
    if (current.step === 'find_bottom') previewInWorld(current);
    syncRig(current, undefined);
    return current;
  };

  /** 找底预览：把当前钓目写进世界并推一帧，3D 里的钓组立刻按新钓目摆好。 */
  const previewInWorld = (current: WizardState): void => {
    const rig = wizardRigState(current);
    if (!rig) return;
    writeRig(session, { t0: rig.t0, t: rig.t, w: rig.w, d: rig.d });
  };

  /**
   * 让世界里的线组跟着向导走：写阶段（半水不挂钩 / 挂钩 / 挂饵 / 找底）与
   * 漂尾露出目数（用户正在点选的那一目）。测量阶段 FishSim 不抛竿，只按这些摆线组。
   */
  const syncRig = (current: WizardState, picked: number | undefined): void => {
    const phase = STEP_PHASE[current.step];
    const attrs = session.world.getEntity(RIG_ID)?.attrs ?? {};
    const known = (key: 't0' | 't' | 'w'): number => current[key] ?? (typeof attrs[key] === 'number' ? (attrs[key] as number) : 0);
    const values: Record<string, number | string> = { rigPhase: phase };
    if (phase === 'measure_t0') values.setupMarks = picked ?? known('t0');
    if (phase === 'measure_t') values.setupMarks = picked ?? known('t');
    // 这一步点的是"被压下去几目"，漂尾实际露出的是 t − w。
    if (phase === 'measure_w') values.setupMarks = known('t') - (picked ?? known('w'));
    writeRig(session, values);
  };

  const pickMarks = (value: number): void => {
    setMarks(value);
    syncRig(state(), value);
  };

  const adjust = (delta: number): void => {
    advance({ kind: 'adjust', delta });
  };

  const setGear = (patch: Partial<Loadout>): void => {
    const current = loadout();
    if (!current) return;
    setState({ ...state(), loadout: { ...current, ...patch } });
    setInsist(false);
    setIssue(undefined);
  };

  const confirmGear = (): void => {
    const current = loadout();
    if (!current) return;
    if (!advance({ kind: 'gear', loadout: current, force: insist() })) setInsist(true);
  };

  /** 没有真漂的人：按装备在数字钓场里"模拟"一组调目，一次走完三步测量。 */
  const simulateMeasure = (): void => {
    const current = loadout();
    if (!current) return;
    const estimate = estimateMarks(current);
    advance({ kind: 't0', value: estimate.t0 }, { kind: 't', value: estimate.t }, { kind: 'w', value: estimate.w });
  };

  const commitMarks = (kind: 't0' | 't' | 'w'): void => {
    const value = marks();
    if (value === undefined) {
      setIssue('先在漂上点一下露出的位置。');
      return;
    }
    advance({ kind, value });
  };

  const finish = (): void => {
    const result = wizardAdvance(state(), { kind: 'confirm' });
    setState(result.state);
    setIssue(result.ok ? undefined : result.issue);
    if (!result.ok) return;
    const rig = wizardRigState(result.state);
    const current = result.state.loadout;
    if (!rig || !current) return;
    finished = true;
    writeRig(session, {
      ...loadoutToAttrs(current),
      t0: rig.t0,
      t: rig.t,
      w: rig.w,
      d: rig.d,
      wizardDone: true,
      rigPhase: 'fishing',
    });
  };

  const startFishing = (mode: FishingMode): void => {
    setFishingMode(session, mode);
    session.controller.play();
    props.onClose();
  };

  const stepIndex = (): number => WIZARD_STEPS.indexOf(state().step);
  const preview = () => wizardRigState(state());
  const preset = () => presetById(state().presetId ?? '');
  const checks = () => {
    const current = loadout();
    return current ? loadoutChecks(current) : [];
  };
  const fishName = (): string => fishById(loadout()?.targetFish ?? '')?.label ?? '';

  return (
    <div class="onboard" role="dialog" aria-label="开钓向导">
      <header class="onboard-head">
        <strong>🧭 开钓向导</strong>
        <Show when={readRig(session)?.wizardDone}>
          <span class="onboard-sub">已有钓组，重新配置</span>
        </Show>
        <button type="button" class="onboard-close" aria-label="关闭向导" title="关闭（未完成的改动会还原）" onClick={dismiss}>
          ✕
        </button>
      </header>

      <ol class="onboard-steps" aria-label="进度">
        <For each={WIZARD_STEPS}>
          {(step, index) => (
            <li class={index() < stepIndex() ? 'done' : index() === stepIndex() ? 'current' : undefined}>{STEP_LABEL[step]}</li>
          )}
        </For>
      </ol>

      <div class="onboard-body">
        <Show when={state().step === 'choose_fish'}>
          <p class="onboard-q">今天想钓什么鱼？</p>
          <p class="onboard-hint">目标鱼决定钩多大、线多粗、用什么饵、调多灵——后面每一步的推荐都跟着它走。</p>
          <div class="onboard-cards">
            <For each={TARGET_FISH}>
              {(fish) => (
                <button type="button" class="onboard-card" onClick={() => advance({ kind: 'fish', fishId: fish.id })}>
                  <span class="onboard-emoji" aria-hidden="true">
                    {fish.emoji}
                  </span>
                  <strong>{fish.label}</strong>
                  <em>
                    {fish.weightKg[0]}–{fish.weightKg[1]} kg
                  </em>
                  <span>{fish.note}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={state().step === 'choose_gear' && loadout()}>
          {(current) => (
            <>
              <p class="onboard-q">钓{fishName()}的装备（已按推荐选好，可改）</p>
              <For each={GEAR_ROWS}>
                {(row) => (
                  <div class="gear-row">
                    <span class="gear-label">{row.label}</span>
                    <div class="gear-options">
                      <For each={GEAR_OPTIONS[row.key] as readonly number[]}>
                        {(option) => (
                          <button
                            type="button"
                            class={current()[row.key] === option ? 'gear-opt gear-opt-on' : 'gear-opt'}
                            aria-pressed={current()[row.key] === option ? 'true' : 'false'}
                            onClick={() => setGear({ [row.key]: option })}
                          >
                            {option}
                            {row.unit}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
              <div class="gear-row">
                <span class="gear-label">饵</span>
                <div class="gear-options">
                  <For each={BAITS}>
                    {(bait) => (
                      <button
                        type="button"
                        class={current().bait === bait.id ? 'gear-opt gear-opt-on' : 'gear-opt'}
                        aria-pressed={current().bait === bait.id ? 'true' : 'false'}
                        title={bait.note}
                        onClick={() => setGear({ bait: bait.id })}
                      >
                        {bait.label}
                      </button>
                    )}
                  </For>
                </div>
              </div>
              <ul class="gear-checks">
                <For each={checks()}>
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

        <Show when={state().step === 'measure_t0'}>
          <p class="onboard-q">半水、不挂钩，漂尾露出几目？</p>
          <p class="onboard-hint">铅坠找底后把漂推到半水，剪到你想要的目数。点漂尾上水面所在的那一目。</p>
          <FloatRuler value={marks()} onChange={pickMarks} />
          <button type="button" class="onboard-alt" onClick={simulateMeasure}>
            🎲 我手上没有漂——按装备模拟一组调目
          </button>
        </Show>

        <Show when={state().step === 'measure_t'}>
          <p class="onboard-q">挂上双钩，漂尾露出几目？</p>
          <p class="onboard-hint">钩有重量，会比刚才的 {fmt(state().t0 ?? 0)} 目少。</p>
          <FloatRuler value={marks()} max={state().t0} onChange={pickMarks} />
        </Show>

        <Show when={state().step === 'measure_w'}>
          <p class="onboard-q">单钩挂一颗饵，漂尾被压下去几目？</p>
          <p class="onboard-hint">这就是"单饵压目"——点被压下去的目数。</p>
          <FloatRuler value={marks()} max={4} onChange={pickMarks} />
        </Show>

        <Show when={state().step === 'choose_preset'}>
          <p class="onboard-q">用哪种调法？</p>
          <p class="onboard-hint">调法决定目标钓目；你实测的调目和饵重照用。</p>
          <div class="onboard-cards onboard-cards-2">
            <For each={TAIDIAO_PRESETS}>
              {(preset) => (
                <button
                  type="button"
                  class={wizardSuggestPreset(state()).id === preset.id ? 'onboard-card onboard-card-rec' : 'onboard-card'}
                  onClick={() => advance({ kind: 'preset', presetId: preset.id })}
                >
                  <strong>
                    {preset.label}
                    {wizardSuggestPreset(state()).id === preset.id ? ' · 推荐' : ''}
                  </strong>
                  <em>适合 {preset.targetFish}</em>
                  <span>{preset.note}</span>
                </button>
              )}
            </For>
          </div>
        </Show>

        <Show when={state().step === 'find_bottom'}>
          <Show when={preview()} fallback={<p class="onboard-issue">参数组合算不出钓组状态，请回上一步检查。</p>}>
            {(rig) => (
              <>
                <p class="onboard-q">找底：推漂，看画面里的钩饵落在哪</p>
                <ZoneMeter d={rig().d} d1={rig().criticalMarks.d1} d2={rig().criticalMarks.d2} d3={rig().criticalMarks.d3} />
                <p class="onboard-zone">
                  钓 {fmt(rig().d)} 目 · <b>{ZONE_LABEL[rig().zone] ?? rig().zone}</b>
                </p>
                <p class="onboard-hint">{rigPosture(rig()).summary}</p>
                <Show when={preset()}>
                  {(chosen) => (
                    <p class="onboard-hint">
                      {chosen().label}的目标是钓 {fmt(chosen().d)} 目
                      {Math.abs(rig().d - chosen().d) < 1e-9 ? ' ✓ 已在目标上' : '，你现在' + (rig().d > chosen().d ? '偏钝' : '偏灵') + ' ' + fmt(Math.abs(rig().d - chosen().d)) + ' 目'}
                      <Show when={Math.abs(rig().d - chosen().d) >= 1e-9}>
                        {' '}
                        <button type="button" class="onboard-link" onClick={() => adjust(chosen().d - rig().d)}>
                          回到 {fmt(chosen().d)} 目
                        </button>
                      </Show>
                    </p>
                  )}
                </Show>
                <div class="onboard-row">
                  <button type="button" onClick={() => adjust(-0.5)}>
                    ⬇ 下推半目（灵）
                  </button>
                  <button type="button" onClick={() => adjust(0.5)}>
                    ⬆ 上推半目（钝）
                  </button>
                </div>
              </>
            )}
          </Show>
        </Show>

        <Show when={state().step === 'done' && loadout()}>
          {(current) => (
            <>
              <p class="onboard-q">准备好了！</p>
              <ul class="onboard-summary">
                <li>
                  目标 <b>{fishName()}</b> · 饵 {BAITS.find((bait) => bait.id === current().bait)?.label}
                </li>
                <li>
                  竿 {current().rodLength}m · 主线 {current().mainLine} / 子线 {current().subLine} 号 · {current().hookSize} 号钩 ·{' '}
                  {current().floatSize}g 漂
                </li>
                <li>
                  调 {fmt(state().t ?? 0)} 钓 {fmt(state().d ?? 0)}（无钩 {fmt(state().t0 ?? 0)} · 单饵压 {fmt(state().w ?? 0)}）
                </li>
              </ul>
              <p class="onboard-q">怎么钓？</p>
              <div class="onboard-cards onboard-cards-2">
                <button type="button" class="onboard-card" onClick={() => startFishing('sim')}>
                  <span class="onboard-emoji" aria-hidden="true">
                    🎲
                  </span>
                  <strong>模拟开钓</strong>
                  <span>在数字钓场里抛竿出鱼口：看漂动了自己点「提杆」。可以随时制造走水、闹窝、降温，练应对。</span>
                </button>
                <button type="button" class="onboard-card" onClick={() => startFishing('real')}>
                  <span class="onboard-emoji" aria-hidden="true">
                    🎣
                  </span>
                  <strong>实际做钓</strong>
                  <span>你在真实钓点：这里不模拟鱼口。遇到情况问助手要对策；想统计就在 HUD 上逐竿记一笔（可选）。</span>
                </button>
              </div>
            </>
          )}
        </Show>

        <Show when={issue()}>{(message) => <p class="onboard-issue">{message()}</p>}</Show>
      </div>

      <footer class="onboard-foot">
        <button
          type="button"
          class="onboard-back"
          disabled={stepIndex() === 0 || state().step === 'done'}
          onClick={() => advance({ kind: 'back' })}
        >
          ← 上一步
        </button>
        <Show when={state().step === 'choose_gear'}>
          <button type="button" class={insist() ? 'onboard-next onboard-next-warn' : 'onboard-next'} onClick={confirmGear}>
            {insist() ? '⚠ 忽略 ' + checks().filter((check) => check.level === 'error').length + ' 个问题，仍然使用 →' : '装备就这样 →'}
          </button>
        </Show>
        <Show when={state().step === 'measure_t0'}>
          <button type="button" class="onboard-next" disabled={marks() === undefined} title={marks() === undefined ? '先在漂上点一下露出的位置' : undefined} onClick={() => commitMarks('t0')}>
            下一步 →
          </button>
        </Show>
        <Show when={state().step === 'measure_t'}>
          <button type="button" class="onboard-next" disabled={marks() === undefined} title={marks() === undefined ? '先在漂上点一下露出的位置' : undefined} onClick={() => commitMarks('t')}>
            下一步 →
          </button>
        </Show>
        <Show when={state().step === 'measure_w'}>
          <button type="button" class="onboard-next" disabled={marks() === undefined} title={marks() === undefined ? '先在漂上点一下露出的位置' : undefined} onClick={() => commitMarks('w')}>
            下一步 →
          </button>
        </Show>
        <Show when={state().step === 'find_bottom'}>
          <button type="button" class="onboard-next" onClick={finish}>
            就钓这里 →
          </button>
        </Show>
      </footer>
    </div>
  );
}

const RULER_MARKS = 13;

/**
 * 漂尾刻度：自下而上 13 目，红黑相间。点哪一目就是"水面在这里、露出这么多目"，
 * 旁边 ± 半目微调。——把"读漂"这件事做成一次点选。
 */
function FloatRuler(props: { value?: number; max?: number; onChange: (value: number) => void }) {
  const limit = (): number => Math.min(RULER_MARKS, props.max ?? RULER_MARKS);
  const segment = 16;
  const height = RULER_MARKS * segment + 16;
  const waterY = (): number => 8 + (RULER_MARKS - (props.value ?? 0)) * segment;
  const nudge = (delta: number): void => {
    const next = Math.round(((props.value ?? 0) + delta) * 2) / 2;
    props.onChange(Math.max(0.5, Math.min(limit(), next)));
  };
  return (
    <div class="ruler">
      <svg viewBox={'0 0 90 ' + height} width="90" height={height} role="img" aria-label="漂尾刻度，点击选择露出目数">
        <For each={Array.from({ length: RULER_MARKS }, (_, index) => RULER_MARKS - index)}>
          {(mark) => (
            <g class={mark <= limit() ? 'ruler-seg' : 'ruler-seg ruler-seg-off'} onClick={() => mark <= limit() && props.onChange(mark)}>
              <rect x={36} y={8 + (RULER_MARKS - mark) * segment} width={14} height={segment} fill={mark % 2 === 0 ? '#1f2a30' : '#e8452c'} />
              <text x={58} y={8 + (RULER_MARKS - mark) * segment + 12} font-size="10" fill="#6b7a7f">
                {mark}
              </text>
            </g>
          )}
        </For>
        <Show when={props.value !== undefined}>
          <rect x={0} y={waterY()} width={90} height={height - waterY()} fill="rgba(46, 134, 171, 0.28)" pointer-events="none" />
          <line x1={0} y1={waterY()} x2={90} y2={waterY()} stroke="#2E86AB" stroke-width={1.5} pointer-events="none" />
        </Show>
      </svg>
      <div class="ruler-side">
        <span class="ruler-value">{props.value === undefined ? '点漂尾' : fmt(props.value) + ' 目'}</span>
        <button type="button" onClick={() => nudge(0.5)}>
          +½
        </button>
        <button type="button" onClick={() => nudge(-0.5)}>
          −½
        </button>
      </div>
    </div>
  );
}

/** 灵钝刻度条：d1（离底临界）/ d2（不灵不钝）/ d3（铅坠触底），当前钓目一根指针。 */
function ZoneMeter(props: { d: number; d1: number; d2: number; d3: number }) {
  const lo = (): number => Math.min(props.d1, props.d) - 1;
  const hi = (): number => Math.max(props.d3, props.d) + 1;
  const pct = (value: number): string => ((100 * (value - lo())) / (hi() - lo())).toFixed(1) + '%';
  return (
    <div class="zone-meter" aria-label="灵钝刻度">
      <div class="zone-band zone-off" style={{ left: '0%', width: pct(props.d1) }} />
      <div class="zone-band zone-sens" style={{ left: pct(props.d1), width: 'calc(' + pct(props.d2) + ' - ' + pct(props.d1) + ')' }} />
      <div class="zone-band zone-blunt" style={{ left: pct(props.d2), width: 'calc(' + pct(props.d3) + ' - ' + pct(props.d2) + ')' }} />
      <div class="zone-band zone-lead" style={{ left: pct(props.d3), right: '0%' }} />
      <div class="zone-pin" style={{ left: pct(props.d) }} />
      <div class="zone-legend">
        <span>离底</span>
        <span>灵</span>
        <span>钝</span>
        <span>到铅</span>
      </div>
    </div>
  );
}
