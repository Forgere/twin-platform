import { createSignal, For, onSettled, Show } from 'solid-js';
import {
  DecisionEngine,
  DecisionLog,
  applyFeedback,
  calibrationReport,
  type DecisionRecord,
  type SerializedDecisionLog,
} from '@twin-platform/decision-core';
import {
  createJevJudge,
  createProxyJevClient,
  fishingSuccess,
  observeFishingWorld,
  type FishingState,
} from '@twin-platform/plugins-fishing';
import { resolveServerUrl } from '../scene/serverUrl';
import type { StudioSession } from '../scene/studioSession';

/**
 * 决策面板：把"当前钓场状态 -> 判断 -> 建议动作 -> 结果反馈"搬进 Studio。
 *
 * 判断者可切换：规则（离线基线） / Jev（同端口，经同源 /api/jev/decide 调 TypeSafe）。
 * 面板只读世界并调 decision-core，不自己判定合法性：越界由 Policy 拒绝并降级，
 * 结果照原样展示（accepted=false 也显示，否则"降级"会被藏起来）。
 *
 * 决策日志落 localStorage：刷新不丢，校准表才可能攒够样本。真正跨设备/跨用户的
 * 持久化要等服务端决策仓储（见开发计划 Phase 6b）。
 */

type JudgeMode = 'rule' | 'jev';

interface JevStatus {
  readonly configured: boolean;
  readonly model?: string;
}

const STORAGE_KEY = 'twin.decision-log.v1';

function loadLog(): DecisionLog {
  if (typeof localStorage === 'undefined') return new DecisionLog('ui');
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new DecisionLog('ui');
    return DecisionLog.fromJSON(JSON.parse(raw) as SerializedDecisionLog);
  } catch {
    return new DecisionLog('ui');
  }
}

function saveLog(log: DecisionLog): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log.toJSON()));
  } catch {
    // 配额满或隐私模式：存不下就只留内存，不影响判断。
  }
}

export default function DecisionPanel(props: { session: StudioSession }) {
  // 与 TwinViewport 同一套服务端解析：dev 时 vite:3000 跨源打 8787；
  // 生产同源时就是 origin，token 由 Worker 注入，前端不需要。
  const apiUrl = resolveServerUrl();
  const apiToken = import.meta.env.VITE_TWIN_API_TOKEN || undefined;
  const authHeaders = (): Record<string, string> => (apiToken ? { authorization: 'Bearer ' + apiToken } : {});

  const [mode, setMode] = createSignal<JudgeMode>('rule');
  const [jev, setJev] = createSignal<JevStatus>();
  const [record, setRecord] = createSignal<DecisionRecord>();
  const [log, setLog] = createSignal<DecisionLog>();
  const [version, setVersion] = createSignal(0);
  const [running, setRunning] = createSignal(false);
  const [note, setNote] = createSignal<string>();

  onSettled(() => {
    setLog(loadLog());
    void (async () => {
      try {
        const response = await fetch(apiUrl + '/api/jev/status', { headers: authHeaders() });
        setJev((await response.json()) as JevStatus);
      } catch {
        setJev({ configured: false });
      }
    })();
  });

  /** 读当前钓场状态；非钓场或参数不合法时给出可读的原因，而不是抛到渲染里。 */
  const observed = (): { state?: FishingState; error?: string } => {
    try {
      const state = observeFishingWorld(props.session.world);
      return state ? { state } : { error: '当前场景不是钓场（缺少 rig 实体）。' };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };

  const stateText = (): string => {
    const result = observed();
    if (result.error || !result.state) return result.error ?? '无法读取钓场状态。';
    const state = result.state;
    const observation = state.observation;
    return [
      '灵钝 ' + state.rig.zone,
      '底承重 ' + state.rig.bottomLoad.toFixed(2),
      '意图 ' + state.intent,
      '有口 ' + observation.bites + ' / 中鱼 ' + observation.catches + ' / 空竿 ' + observation.emptyHooks,
    ].join(' · ');
  };

  const domain = () => {
    const base = props.session.host.decisions[0];
    if (!base) return undefined;
    if (mode() === 'rule') return base;
    return { ...base, judge: createJevJudge(createProxyJevClient({ basePath: apiUrl + '/api/jev/decide', headers: authHeaders() })) };
  };

  const records = () => {
    version();
    return log()?.all() ?? [];
  };

  const report = () => calibrationReport(records(), { methodId: mode(), success: fishingSuccess, buckets: 5, minSamples: 3 });

  const run = async (): Promise<void> => {
    const current = observed().state;
    const target = domain();
    const currentLog = log();
    if (!current || !target || !currentLog) return;
    setRunning(true);
    setNote(undefined);
    try {
      const engine = new DecisionEngine(target, currentLog);
      setRecord(await engine.decide(current, { at: props.session.world.time }));
      saveLog(currentLog);
      setVersion((value) => value + 1);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  const feedback = (useful: boolean): void => {
    const currentLog = log();
    const item = record();
    if (!currentLog || !item) return;
    applyFeedback(currentLog, { decisionId: item.id, useful, at: props.session.world.time });
    saveLog(currentLog);
    setVersion((value) => value + 1);
  };

  const clear = (): void => {
    const fresh = new DecisionLog('ui');
    setLog(fresh);
    setRecord(undefined);
    saveLog(fresh);
    setVersion((value) => value + 1);
  };

  return (
    <section aria-label="决策">
      <h2>决策</h2>
      <Show when={props.session.host.decisions.length > 0} fallback={<p class="plugin-note">当前插件没有决策域。</p>}>
        <div class="segmented" role="group" aria-label="判断者">
          <button type="button" class={mode() === 'rule' ? 'seg seg-active' : 'seg'} onClick={() => setMode('rule')}>
            规则
          </button>
          <button
            type="button"
            class={mode() === 'jev' ? 'seg seg-active' : 'seg'}
            disabled={jev()?.configured !== true}
            onClick={() => setMode('jev')}
          >
            Jev
          </button>
        </div>

        <p class="plugin-note">
          {jev() === undefined
            ? '正在检查 Jev…'
            : jev()?.configured === true
              ? 'Jev 可用（' + String(jev()?.model) + '）'
              : 'Jev 未配置：在 apps/server/.env 设 JEV_API_KEY'}
        </p>

        <p class="decision-state">{stateText()}</p>

        <div class="decision-actions">
          <button type="button" class="seg" disabled={running() || !observed().state || !domain()} onClick={() => void run()}>
            {running() ? '判断中…' : '判断下一步'}
          </button>
        </div>

        <Show when={note()}>{(message) => <p class="plugin-errors">{message()}</p>}</Show>

        <Show when={record()}>
          {(item) => (
            <article class={item().accepted ? 'plugin-card ok' : 'plugin-card bad'}>
              <header>
                <strong>{item().decision.action}</strong>
                <span class="plugin-version">{item().accepted ? '已接受' : '已降级'}</span>
              </header>
              <ul class="capability-tags">
                <For each={Object.entries(item().decision.params)}>
                  {([key, value]) => (
                    <li>
                      {key}={String(value)}
                    </li>
                  )}
                </For>
              </ul>
              <p class="plugin-contrib">
                置信度 {item().decision.confidence.toFixed(2)} · 原因 {item().decision.reasonCode} · 指纹 {item().stateHash}
              </p>
              <Show when={item().degradeReason}>{(reason) => <p class="plugin-state">降级原因：{reason()}</p>}</Show>
              <div class="decision-actions">
                <button type="button" class="seg" disabled={item().feedback !== undefined} onClick={() => feedback(true)}>
                  👍 管用
                </button>
                <button type="button" class="seg" disabled={item().feedback !== undefined} onClick={() => feedback(false)}>
                  👎 不管用
                </button>
              </div>
              <Show when={item().feedback}>
                {(feedback) => <p class="plugin-state">已记：{feedback().useful ? '管用' : '不管用'}</p>}
              </Show>
            </article>
          )}
        </Show>

        <Show when={report().decided > 0}>
          <div class="decision-report">
            <p class="plugin-contrib">
              Brier {report().brier.toFixed(3)} · 成功率 {report().successRate.toFixed(2)} · 平均置信度 {report().meanConfidence.toFixed(2)} · 样本 {report().decided}
            </p>
            <Show when={!report().trustworthy}>
              <p class="plugin-note">样本不足（{report().decided} 条），以下比率仅供参考。</p>
            </Show>
            <table class="decision-calibration">
              <thead>
                <tr>
                  <th>置信度</th>
                  <th>次数</th>
                  <th>命中率</th>
                </tr>
              </thead>
              <tbody>
                <For each={report().buckets}>
                  {(bucket) => (
                    <tr>
                      <td>
                        {(bucket.lo * 100).toFixed(0)}–{(bucket.hi * 100).toFixed(0)}%
                      </td>
                      <td>{bucket.decisions}</td>
                      <td>{bucket.decisions === 0 ? '—' : (bucket.rate * 100).toFixed(0) + '%'}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>

        <div class="decision-actions">
          <button type="button" class="seg" disabled={records().length === 0} onClick={clear}>
            清空记录
          </button>
        </div>
      </Show>
    </section>
  );
}
