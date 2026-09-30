import { createSignal, For, onSettled, Show } from 'solid-js';
import { DecisionEngine, applyFeedback, type DecisionLog, type DecisionRecord } from '@twin-platform/decision-core';
import {
  FISHING_ACTIONS,
  SITUATIONS,
  adviseSituation,
  applyFishingDecision,
  BAITS,
  calculateRigState,
  previewFishingDecision,
  type DecisionChange,
  matchSituation,
  situationById,
  stateForSituation,
  type Advice,
  type FishingMode,
  type FishingActionId,
  type SituationId,
  type SituationMatch,
} from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';
import { readRig, refreshWhilePaused, setFishingMode, writeRig } from './fishingWorld';
import FishingOnboarding from './FishingOnboarding';
import { fetchJevStatus, judgeDomain, loadDecisionLog, saveDecisionLog, type JevStatus, type JudgeMode } from './judging';
import { createSpeech } from './speech';

/**
 * 钓鱼助手 —— 从配钓组到钓完都在这里：
 * - 钓组没配好 / 点了 ⚙：助手里就是开钓向导，走完选「模拟开钓」或「实际做钓」；
 * - 模拟：可以制造走水 / 闹窝 / 降温 / 打窝来练应对（提杆在 HUD 上）；
 * - 实际做钓：主要用来点遇到的情况、按建议做决策。
 *
 * 问法：点情况按钮（首选，零负担）；说不清就按 🎤 说一句，或者打字。
 * 答法两路并列：
 * - **规则**：plugins-fishing 的 adviseSituation——结合当前钓组 / 装备 / 情况讲道理，
 *   给一步可执行的动作；
 * - **判断者**（规则 Judge 或 Jev）：走 decision-core，带置信度，记录进决策日志
 *   （和右侧「决策」页同一份，校准表因此能攒样本），可以打 👍👎。
 * 任何一路的动作都能"照做"：经 applyFishingDecision 写进世界，仿真与 3D 立刻跟着变。
 */

const ACTION_LABEL: Readonly<Record<string, string>> = Object.fromEntries(FISHING_ACTIONS.map((item) => [item.id, item.label]));

const PARAM_TEXT: Readonly<Record<string, string>> = {
  sensitive: '往灵',
  blunt: '往钝',
  up: '上移',
  down: '下移',
  light: '少量',
  medium: '适量',
  normal: '适量',
  heavy: '大量',
  flavor: '换味型',
  state: '换状态',
  size: '换大小',
  hook: '钩',
  line: '线',
  float: '漂',
  now: '立即',
  later: '稍后',
};

const ZONE_TEXT: Readonly<Record<string, string>> = {
  off_bottom: '未到底',
  sensitive: '偏灵',
  neutral: '不灵不钝',
  blunt: '偏钝',
  sinker_on_bottom: '铅坠触底',
};

interface OpPreview {
  readonly note: string;
  readonly changes: readonly DecisionChange[];
  readonly zone?: { readonly before: string; readonly after: string };
}

const fmt = (value: number): string => String(Math.round(value * 100) / 100);

/** attrs 值 → 人话（数字去尾零、饵用名字、开关用有 / 无）。 */
function showValue(key: string, value: unknown): string {
  if (key === 'nestUntil') return typeof value === 'number' && value > 0 ? '生效' : '无';
  if (key === 'bait') return BAITS.find((bait) => bait.id === value)?.label ?? String(value ?? '—');
  if (typeof value === 'boolean') return value ? '有' : '无';
  if (typeof value === 'number') return fmt(value);
  return value === undefined ? '—' : String(value);
}

/** 一步操作：按钮写动作，下面一行写后果（钓目 2 → 3 · 偏灵 → 不灵不钝）。 */
function OpButton(props: { label: string; preview: OpPreview; primary?: boolean; onRun: () => void }) {
  const consequence = (): string =>
    [
      ...props.preview.changes.map((change) => change.label + ' ' + showValue(change.key, change.before) + ' → ' + showValue(change.key, change.after)),
      ...(props.preview.zone ? [props.preview.zone.before + ' → ' + props.preview.zone.after] : []),
    ].join(' · ');
  return (
    <div class="op">
      <button type="button" class={props.primary ? 'onboard-next op-btn' : 'op-btn op-btn-alt'} onClick={props.onRun}>
        {props.label}
      </button>
      <span class="op-effect">{consequence() || '不改动钓组，只是观察'}</span>
    </div>
  );
}

function describeDecision(action: string, params: Readonly<Record<string, number | string>>): string {
  const detail = Object.values(params)
    .map((value) => (typeof value === 'string' ? (PARAM_TEXT[value] ?? value) : String(value)))
    .join(' · ');
  return (ACTION_LABEL[action] ?? action) + (detail ? '（' + detail + '）' : '');
}

/** 让外部（HUD 的情况 chip）把助手直接打开到某个情况。 */
export interface FishingAssistantApi {
  askAbout(situation: SituationId): void;
}

type Counts = NonNullable<ReturnType<typeof readRig>>['counts'];

export default function FishingAssistant(props: {
  session: StudioSession;
  tick: number;
  connect?: (api: FishingAssistantApi) => void;
  /** 正在为哪个会话走开钓向导（没有就是平常的助手）。 */
  setup?: StudioSession;
  onSetup: () => void;
  onSetupClose: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [situation, setSituation] = createSignal<SituationId>();
  const [advice, setAdvice] = createSignal<Advice>();
  const [heard, setHeard] = createSignal<{ text: string; match: SituationMatch }>();
  const [typed, setTyped] = createSignal('');
  const [mode, setMode] = createSignal<JudgeMode>('rule');
  const [jev, setJev] = createSignal<JevStatus>();
  const [record, setRecord] = createSignal<DecisionRecord>();
  const [judging, setJudging] = createSignal(false);
  const [done, setDone] = createSignal<OpPreview & { fromJudge: boolean }>();
  const [feedbackGiven, setFeedbackGiven] = createSignal<boolean>();
  /** 照做那一刻的计数：之后与当前计数相减，回答"改了之后有没有用"。 */
  const [baseline, setBaseline] = createSignal<Counts>();

  const since = () => {
    props.tick;
    const base = baseline();
    const now = readRig(props.session)?.counts;
    if (!base || !now) return undefined;
    return {
      casts: now.casts - base.casts,
      bites: now.bites - base.bites,
      catches: now.catches - base.catches,
      emptyHooks: now.emptyHooks - base.emptyHooks,
      breaks: now.breaks - base.breaks,
    };
  };
  let log: DecisionLog | undefined;

  const speech = createSpeech();

  onSettled(() => {
    log = loadDecisionLog();
    void fetchJevStatus().then(setJev);
  });

  /** 问一个情况：规则答案立即出；判断者异步跑。 */
  const ask = (id: SituationId): void => {
    const rig = readRig(props.session);
    setSituation(id);
    setDone(undefined);
    setRecord(undefined);
    setFeedbackGiven(undefined);
    if (!rig?.state) {
      setAdvice(undefined);
      return;
    }
    setAdvice(adviseSituation(id, stateForSituation(rig.state, id), rig.loadout, rig.conditions));
    if (situationById(id)?.kind === 'problem') void runJudge(id);
  };

  // Solid 2 的信号写入延迟生效：切换判断者时把新模式显式传进来，别读刚写的 mode()。
  const runJudge = async (id: SituationId, judge: JudgeMode = mode()): Promise<void> => {
    const rig = readRig(props.session);
    const domain = judgeDomain(props.session, judge);
    if (!rig?.state || !domain || !log) return;
    setJudging(true);
    try {
      const engine = new DecisionEngine(domain, log);
      setRecord(await engine.decide(stateForSituation(rig.state, id), { at: props.session.world.time }));
      saveDecisionLog(log);
    } finally {
      setJudging(false);
    }
  };

  const understand = (text: string): void => {
    const match = matchSituation(text);
    setHeard({ text, match });
    if (match.situation) ask(match.situation.id);
    else {
      setSituation(undefined);
      setAdvice(undefined);
    }
  };

  const execute = (action: string, params: Readonly<Record<string, number | string>>, fromJudge = false): void => {
    const decision = { action: action as FishingActionId, params };
    const preview = previewOf(action, params);
    applyFishingDecision(props.session.world, decision, props.session.world.time);
    setBaseline(readRig(props.session)?.counts);
    refreshWhilePaused(props.session);
    props.session.controller.play();
    setDone({ ...preview, fromJudge });
    // 旧建议是按改动前的钓组算的，照做后已经过时：清掉，让「现状」按改后的数据重新判断。
    // record 留着——👍👎 反馈要挂在它上面。
    setSituation(undefined);
    setAdvice(undefined);
    setHeard(undefined);
  };

  const switchJudge = (judge: JudgeMode): void => {
    setMode(judge);
    const id = situation();
    if (id) void runJudge(id, judge);
  };

  /** 预览一个动作：会改哪几项 + 灵钝区前后（只读，不写世界）。 */
  const previewOf = (action: string, params: Readonly<Record<string, number | string>>): OpPreview => {
    const result = previewFishingDecision(props.session.world, { action: action as FishingActionId, params }, props.session.world.time);
    const rig = readRig(props.session)?.state?.rig;
    let zone: OpPreview['zone'];
    if (rig) {
      const next = { t0: rig.t0, t: rig.t, w: rig.w, d: rig.d };
      for (const change of result.changes) if (change.key in next && typeof change.after === 'number') next[change.key as keyof typeof next] = change.after;
      const after = calculateRigState(next);
      if (after.ok && after.state.zone !== rig.zone) zone = { before: ZONE_TEXT[rig.zone] ?? rig.zone, after: ZONE_TEXT[after.state.zone] ?? after.state.zone };
    }
    return { note: result.note, changes: result.changes, zone };
  };

  /** 判断者给的是否就是规则建议的那一步（同动作同参数）。 */
  const sameAsAdvice = (action: string, params: Readonly<Record<string, number | string>>): boolean => {
    const mine = advice()?.action;
    return !!mine && mine.action === action && JSON.stringify(mine.params) === JSON.stringify(params);
  };

  const feedback = (useful: boolean): void => {
    const item = record();
    if (!item || !log) return;
    applyFeedback(log, { decisionId: item.id, useful, at: props.session.world.time });
    saveDecisionLog(log);
    setFeedbackGiven(useful);
  };

  props.connect?.({
    askAbout: (id) => {
      setHeard(undefined);
      props.onOpen?.();
      setOpen(true);
      ask(id);
    },
  });

  /** 点 chip：换了问题，上一句"我理解为…"就不再对应当前答案，一并清掉。 */
  const pick = (id: SituationId): void => {
    setHeard(undefined);
    ask(id);
  };

  /** 由当前钓况推断"眼下最可能要问的"情况，在 chip 上标出来，先点它。 */
  const likely = (): ReadonlySet<SituationId> => {
    props.tick;
    const rig = readRig(props.session);
    const out = new Set<SituationId>();
    if (!rig) return out;
    // 照做过之后，计数类信号只看改后的数据；否则旧的"空竿多"会一直把同一个建议顶回来。
    const counts = since() ?? rig.counts;
    if (rig.conditions.drift && !rig.conditions.antiDrift) out.add('drift');
    if (rig.conditions.smallFish) out.add('small_fish');
    if (rig.conditions.waterTemperature < 12) out.add('cold');
    if (counts.breaks > 0) out.add('line_break');
    if (counts.casts >= 8 && counts.bites === 0) out.add('no_bite');
    if (counts.bites >= 4 && counts.catches * 3 < counts.bites) out.add('bite_no_catch');
    return out;
  };

  const rigNow = () => {
    props.tick;
    return readRig(props.session);
  };

  /** 换模式会清零计数（模拟的鱼口不能混进实钓记录），改动前的建议与跟踪一并作废。 */
  const switchMode = (next: FishingMode): void => {
    if (rigNow()?.mode === next) return;
    setFishingMode(props.session, next);
    setBaseline(undefined);
    setDone(undefined);
    setSituation(undefined);
    setAdvice(undefined);
    setHeard(undefined);
  };

  /** 按钮定义不随采样重建；只追踪选中态，避免触摸和键盘焦点丢失。 */
  const drills = [
    {
      id: 'drift', label: '🌊 走水', on: () => rigNow()?.conditions.drift ?? false,
      apply: () => writeRig(props.session, { drift: !rigNow()?.conditions.drift, antiDrift: false }),
    },
    {
      id: 'small', label: '🐟 小鱼闹窝', on: () => rigNow()?.conditions.smallFish ?? false,
      apply: () => writeRig(props.session, { smallFish: !rigNow()?.conditions.smallFish }),
    },
    {
      id: 'cold', label: '🥶 降温 8℃', on: () => (rigNow()?.conditions.waterTemperature ?? 20) < 12,
      apply: () => writeRig(props.session, { waterTemperature: (rigNow()?.conditions.waterTemperature ?? 20) < 12 ? 20 : 8 }),
    },
    {
      id: 'nest', label: '🪣 打窝', on: () => props.session.world.time < (rigNow()?.conditions.nestUntil ?? 0),
      apply: () => writeRig(props.session, { nestUntil: props.session.world.time < (rigNow()?.conditions.nestUntil ?? 0) ? 0 : props.session.world.time + 120 }),
    },
    {
      id: 'auto', label: '🤖 自动提杆', on: () => !rigNow()?.manualLift,
      apply: () => writeRig(props.session, { autoLift: rigNow()?.manualLift ?? false }),
    },
  ];

  const problems = SITUATIONS.filter((item) => item.kind === 'problem');
  const howtos = SITUATIONS.filter((item) => item.kind === 'howto');

  return (
    <>
      {/* 开钓向导住在助手里：keyed，每个会话一个向导实例，会话一换旧向导卸掉。 */}
      <Show when={props.setup === props.session ? props.setup : undefined} keyed>
        {(target: StudioSession) => (
          <section class="assist assist-setup" aria-label="钓鱼助手 · 开钓向导">
            <FishingOnboarding session={target} onClose={props.onSetupClose} />
          </section>
        )}
      </Show>

      <Show when={!open() && props.setup !== props.session}>
        <button type="button" class="assist-fab" onClick={() => { props.onOpen?.(); setOpen(true); }} title="遇到情况随时问：点选或直接说">
          🎣 助手
          {/* 收起时也要让人知道"现在有情况值得问"：命中的现状数挂在按钮上。 */}
          <Show when={likely().size > 0}>
            <span class="assist-fab-badge" aria-label={likely().size + ' 个现状情况'}>
              {likely().size}
            </span>
          </Show>
        </button>
      </Show>

      <Show when={open() && props.setup !== props.session}>
        {/* Esc 收起：焦点在助手里任何位置都生效；在听写时先停听写，不直接收起。 */}
        <section
          class="assist"
          aria-label="钓鱼助手"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            if (speech.listening()) speech.stop();
            else setOpen(false);
          }}
        >
          <header class="assist-head">
            <strong>🎣 钓鱼助手</strong>
            <Show when={rigNow()?.wizardDone}>
              <div class="assist-mode" role="group" aria-label="钓场模式">
                <button
                  type="button"
                  class={rigNow()?.mode === 'sim' ? 'seg seg-active' : 'seg'}
                  aria-pressed={rigNow()?.mode === 'sim' ? 'true' : 'false'}
                  title="模拟开钓：数字钓场出鱼口（切换会清零计数）"
                  onClick={() => switchMode('sim')}
                >
                  🎲 模拟
                </button>
                <button
                  type="button"
                  class={rigNow()?.mode === 'real' ? 'seg seg-active' : 'seg'}
                  aria-pressed={rigNow()?.mode === 'real' ? 'true' : 'false'}
                  title="实际做钓：不模拟鱼口，只做决策与记录（切换会清零计数）"
                  onClick={() => switchMode('real')}
                >
                  🎣 实钓
                </button>
              </div>
            </Show>
            <button type="button" class="assist-setup-btn" title="开钓向导：换鱼 / 换装备 / 重新调漂" aria-label="开钓向导" onClick={props.onSetup}>
              ⚙
            </button>
            <button type="button" class="onboard-close" aria-label="收起助手" onClick={() => setOpen(false)}>
              ▾
            </button>
          </header>

          <Show when={rigNow()?.wizardDone === false}>
            <button type="button" class="onboard-next" onClick={props.onSetup}>
              🧭 钓组还没配好，走开钓向导
            </button>
          </Show>

          <Show when={rigNow()?.wizardDone && rigNow()?.mode === 'sim'}>
            <div class="assist-drills">
              <span class="assist-op-kicker">制造情况（练应对）</span>
              <div class="assist-chips" role="group" aria-label="制造情况">
                <For each={drills}>
                  {(item) => (
                    <button type="button" class={item.on() ? 'gear-opt gear-opt-on' : 'gear-opt'} aria-pressed={item.on() ? 'true' : 'false'} onClick={item.apply}>
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <span class="assist-op-kicker">{rigNow()?.mode === 'real' ? '遇到什么情况？点一下拿对策' : '遇到什么情况？'}</span>
          <div class="assist-chips" role="group" aria-label="钓况">
            <For each={problems}>
              {(item) => (
                <button
                  type="button"
                  class={
                    (situation() === item.id ? 'assist-chip assist-chip-on' : 'assist-chip') + (likely().has(item.id) ? ' assist-chip-likely' : '')
                  }
                  aria-pressed={situation() === item.id ? 'true' : 'false'}
                  title={likely().has(item.id) ? '根据当前钓况，你可能正遇到这个' : undefined}
                  onClick={() => pick(item.id)}
                >
                  {item.emoji} {item.label}
                  <Show when={likely().has(item.id)}>
                    <span class="assist-likely"> · 现状</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div class="assist-chips assist-chips-howto" role="group" aria-label="规则问答">
            <For each={howtos}>
              {(item) => (
                <button
                  type="button"
                  class={situation() === item.id ? 'assist-chip assist-chip-on' : 'assist-chip'}
                  aria-pressed={situation() === item.id ? 'true' : 'false'}
                  onClick={() => pick(item.id)}
                >
                  {item.emoji} {item.label}
                </button>
              )}
            </For>
          </div>

          <div class="assist-voice">
            <Show when={speech.supported}>
              <button
                type="button"
                class={speech.listening() ? 'assist-mic assist-mic-on' : 'assist-mic'}
                aria-pressed={speech.listening() ? 'true' : 'false'}
                title="情况复杂？按下直接说"
                onClick={() => (speech.listening() ? speech.stop() : speech.start(understand))}
              >
                {speech.listening() ? '⏹' : '🎤'}
              </button>
            </Show>
            <input
              class="assist-input"
              type="text"
              placeholder={speech.listening() ? '在听…' : speech.supported ? '说不清就按 🎤 说一句，或在这里写' : '说说遇到的情况…'}
              value={speech.listening() ? speech.interim() : typed()}
              onInput={(event) => setTyped(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && typed().trim() !== '') {
                  understand(typed().trim());
                  setTyped('');
                }
              }}
            />
          </div>
          <Show when={speech.error()}>{(message) => <p class="assist-note assist-bad">{message()}</p>}</Show>
          <Show when={heard()}>
            {(item) => (
              <p class="assist-note">
                「{item().text}」→{' '}
                {item().match.situation
                  ? '我理解为：' + item().match.situation!.label + '（听到：' + item().match.hits.join('、') + '）'
                  : '没听懂，点一下上面最接近的情况吧。'}
              </p>
            )}
          </Show>

          <Show when={situation() && !advice()}>
            <p class="assist-note assist-bad">钓组参数还不完整，先走一遍开钓向导（上面的 ⚙）。</p>
          </Show>

          <Show when={advice()}>
            {(current) => (
              <article class="assist-card">
                <h4>📘 {current().title}</h4>
                <ul>
                  <For each={current().diagnosis}>{(line) => <li>{line}</li>}</For>
                </ul>
                <p class="assist-rule">{current().rule}</p>

                {/* 建议 = 一个写明后果的按钮：点之前就看到会改哪几项、灵钝区怎么变。 */}
                <Show when={current().action && !done()}>
                  <div class="assist-op">
                    <span class="assist-op-kicker">建议操作</span>
                    <OpButton primary label={current().action!.label} preview={previewOf(current().action!.action, current().action!.params)} onRun={() => execute(current().action!.action, current().action!.params)} />
                  </div>
                </Show>

                <Show when={current().action && !done()}>
                  <div class="assist-judge">
                    <div class="assist-judge-head">
                      <span>🤖 判断者</span>
                      <div class="assist-mode" role="group" aria-label="判断者">
                        <button type="button" class={mode() === 'rule' ? 'seg seg-active' : 'seg'} onClick={() => switchJudge('rule')}>
                          规则
                        </button>
                        <button
                          type="button"
                          class={mode() === 'jev' ? 'seg seg-active' : 'seg'}
                          disabled={jev()?.configured !== true}
                          title={jev()?.configured === true ? 'Jev（' + String(jev()?.model) + '）' : 'Jev 未配置'}
                          onClick={() => switchJudge('jev')}
                        >
                          Jev
                        </button>
                      </div>
                    </div>
                    <Show when={record()} fallback={<p class="assist-note">{judging() ? '判断中…' : '—'}</p>}>
                      {(item) => (
                        <Show
                          when={!sameAsAdvice(item().decision.action, item().decision.params)}
                          fallback={
                            <p class="assist-note assist-agree">
                              ✓ 判断者也建议这么做（置信度 {(item().decision.confidence * 100).toFixed(0)}%）
                            </p>
                          }
                        >
                          <p class="assist-note">
                            判断者有不同看法（置信度 {(item().decision.confidence * 100).toFixed(0)}%
                            {item().accepted ? '' : '，已降级：' + String(item().degradeReason)}）：
                          </p>
                          <OpButton
                            label={describeDecision(item().decision.action, item().decision.params)}
                            preview={previewOf(item().decision.action, item().decision.params)}
                            onRun={() => execute(item().decision.action, item().decision.params, true)}
                          />
                        </Show>
                      )}
                    </Show>
                  </div>
                </Show>
              </article>
            )}
          </Show>

          {/* 做完就明确告诉用户"世界里真的改了什么"，再跟踪改后的鱼口。 */}
          <Show when={done()}>
            {(result) => (
              <div class="assist-done">
                <p class="assist-done-title">✅ 已调整：{result().note}</p>
                <Show when={result().changes.length > 0}>
                  <ul class="assist-changes">
                    <For each={result().changes}>
                      {(change) => (
                        <li>
                          <span>{change.label}</span>
                          <s>{showValue(change.key, change.before)}</s>
                          <b>{showValue(change.key, change.after)}</b>
                        </li>
                      )}
                    </For>
                    <Show when={result().zone}>
                      {(zone) => (
                        <li>
                          <span>灵钝</span>
                          <s>{zone().before}</s>
                          <b>{zone().after}</b>
                        </li>
                      )}
                    </Show>
                  </ul>
                </Show>
                <Show when={since()}>
                  {(delta) => (
                    <p class="assist-since">
                      {delta().casts === 0
                        ? '观察中，等下一竿…'
                        : '改后 ' + delta().casts + ' 竿：口 ' + delta().bites + ' · 中 ' + delta().catches + ' · 空 ' + delta().emptyHooks}
                      <Show when={delta().casts >= 5}>
                        {' — '}
                        {delta().catches > 0 ? '见效了，保持。' : delta().bites > 0 ? '有口没中，点「有口打不中」再调。' : '还没口，可以再问一次。'}
                      </Show>
                    </p>
                  )}
                </Show>
                <Show when={result().fromJudge && record()}>
                  <div class="assist-feedback">
                    <span>判断者这次管用吗？</span>
                    <button type="button" class="seg" disabled={feedbackGiven() !== undefined} onClick={() => feedback(true)}>
                      👍
                    </button>
                    <button type="button" class="seg" disabled={feedbackGiven() !== undefined} onClick={() => feedback(false)}>
                      👎
                    </button>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </section>
      </Show>
    </>
  );
}
