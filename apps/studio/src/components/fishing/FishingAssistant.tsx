import { createSignal, For, onSettled, Show } from 'solid-js';
import { DecisionEngine, applyFeedback, type DecisionLog, type DecisionRecord } from '@twin-platform/decision-core';
import {
  FISHING_ACTIONS,
  SITUATIONS,
  adviseSituation,
  applyFishingDecision,
  matchSituation,
  situationById,
  stateForSituation,
  type Advice,
  type FishingActionId,
  type SituationId,
  type SituationMatch,
} from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../../scene/studioSession';
import { readRig, refreshWhilePaused } from './fishingWorld';
import { fetchJevStatus, judgeDomain, loadDecisionLog, saveDecisionLog, type JevStatus, type JudgeMode } from './judging';
import { createSpeech } from './speech';

/**
 * 钓鱼助手 —— 垂钓过程中随时可问（向导不是一次性的）。
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

export default function FishingAssistant(props: { session: StudioSession; tick: number; connect?: (api: FishingAssistantApi) => void }) {
  const [open, setOpen] = createSignal(false);
  const [situation, setSituation] = createSignal<SituationId>();
  const [advice, setAdvice] = createSignal<Advice>();
  const [heard, setHeard] = createSignal<{ text: string; match: SituationMatch }>();
  const [typed, setTyped] = createSignal('');
  const [mode, setMode] = createSignal<JudgeMode>('rule');
  const [jev, setJev] = createSignal<JevStatus>();
  const [record, setRecord] = createSignal<DecisionRecord>();
  const [judging, setJudging] = createSignal(false);
  const [done, setDone] = createSignal<string>();
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

  const runJudge = async (id: SituationId): Promise<void> => {
    const rig = readRig(props.session);
    const domain = judgeDomain(props.session, mode());
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

  const execute = (action: string, params: Readonly<Record<string, number | string>>): void => {
    const note = applyFishingDecision(
      props.session.world,
      { action: action as FishingActionId, params },
      props.session.world.time,
    );
    setBaseline(readRig(props.session)?.counts);
    refreshWhilePaused(props.session);
    props.session.controller.play();
    setDone(note);
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
    if (rig.conditions.drift && !rig.conditions.antiDrift) out.add('drift');
    if (rig.conditions.smallFish) out.add('small_fish');
    if (rig.conditions.waterTemperature < 12) out.add('cold');
    if (rig.counts.breaks > 0) out.add('line_break');
    if (rig.counts.casts >= 8 && rig.counts.bites === 0) out.add('no_bite');
    if (rig.counts.bites >= 4 && rig.counts.catches * 3 < rig.counts.bites) out.add('bite_no_catch');
    return out;
  };

  const problems = SITUATIONS.filter((item) => item.kind === 'problem');
  const howtos = SITUATIONS.filter((item) => item.kind === 'howto');

  return (
    <>
      <Show when={!open()}>
        <button type="button" class="assist-fab" onClick={() => setOpen(true)} title="遇到情况随时问：点选或直接说">
          🎣 助手
        </button>
      </Show>

      <Show when={open()}>
        <section class="assist" aria-label="钓鱼助手">
          <header class="assist-head">
            <strong>🎣 钓鱼助手</strong>
            <span class="assist-sub">遇到什么情况？</span>
            <button type="button" class="onboard-close" aria-label="收起助手" onClick={() => setOpen(false)}>
              ▾
            </button>
          </header>

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
            <p class="assist-note assist-bad">钓组参数还不完整，先走一遍开钓向导（HUD 上的 ⚙）。</p>
          </Show>

          <Show when={advice()}>
            {(current) => (
              <article class="assist-card">
                <h4>📘 {current().title}</h4>
                <ul>
                  <For each={current().diagnosis}>{(line) => <li>{line}</li>}</For>
                </ul>
                <p class="assist-rule">{current().rule}</p>
                <Show when={current().action}>
                  {(action) => (
                    <button type="button" class="onboard-next" onClick={() => execute(action().action, action().params)}>
                      照做：{action().label}
                    </button>
                  )}
                </Show>
              </article>
            )}
          </Show>

          <Show when={advice()?.action}>
            <details class="assist-card assist-judge">
              <summary>🤖 第二意见（判断者）</summary>
              <header>
                <div class="assist-mode" role="group" aria-label="判断者">
                  <button type="button" class={mode() === 'rule' ? 'seg seg-active' : 'seg'} onClick={() => setMode('rule')}>
                    规则
                  </button>
                  <button
                    type="button"
                    class={mode() === 'jev' ? 'seg seg-active' : 'seg'}
                    disabled={jev()?.configured !== true}
                    title={jev()?.configured === true ? 'Jev（' + String(jev()?.model) + '）' : 'Jev 未配置'}
                    onClick={() => setMode('jev')}
                  >
                    Jev
                  </button>
                  <button type="button" class="seg" disabled={judging()} onClick={() => situation() && void runJudge(situation()!)}>
                    {judging() ? '…' : '再问'}
                  </button>
                </div>
              </header>
              <Show when={record()} fallback={<p class="assist-note">{judging() ? '判断中…' : '选好判断者后点「再问」。'}</p>}>
                {(item) => (
                  <>
                    <p class="assist-verdict">
                      {describeDecision(item().decision.action, item().decision.params)}
                      <span class="assist-conf"> 置信度 {(item().decision.confidence * 100).toFixed(0)}%</span>
                    </p>
                    <Show when={!item().accepted}>
                      <p class="assist-note assist-bad">已降级：{item().degradeReason}</p>
                    </Show>
                    <div class="onboard-row">
                      <button type="button" class="seg" onClick={() => execute(item().decision.action, item().decision.params)}>
                        改照它做
                      </button>
                      <button type="button" disabled={feedbackGiven() !== undefined} onClick={() => feedback(true)}>
                        👍
                      </button>
                      <button type="button" disabled={feedbackGiven() !== undefined} onClick={() => feedback(false)}>
                        👎
                      </button>
                    </div>
                  </>
                )}
              </Show>
            </details>
          </Show>

          <Show when={done()}>
            {(message) => (
              <div class="assist-done">
                <p>✅ {message()}</p>
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
              </div>
            )}
          </Show>
        </section>
      </Show>
    </>
  );
}
