import { createSignal, For, onSettled, Show } from 'solid-js';
import { DecisionEngine, DecisionLog, summarizeDecisions, type DecisionRecord } from '@twin-platform/decision-core';
import { createJevJudge, createProxyJevClient, observeFishingWorld, type FishingState } from '@twin-platform/plugins-fishing';
import { defaultServerUrl } from '@twin-platform/storage-http';
import type { StudioSession } from '../scene/studioSession';

/**
 * 决策面板：把"当前钓场状态 -> 判断 -> 建议动作"搬进 Studio。
 *
 * 判断者可切换：
 * - 规则：插件自带的 ruleJudge（离线、确定性基线）；
 * - Jev：同一端口，经同源 /api/jev/decide 调 TypeSafe（密钥在服务端）。
 *
 * 面板不自己判定合法性：越界由 Policy 拒绝并降级，结果照原样展示
 * （accepted=false 也展示，否则"降级"会被藏起来）。
 */

type JudgeMode = 'rule' | 'jev';

interface JevStatus {
  readonly configured: boolean;
  readonly model?: string;
}

export default function DecisionPanel(props: { session: StudioSession }) {
  // 与 TwinViewport 同一套服务端解析：dev 时 vite:3000 跨源打 8787；
  // 生产同源时就是 origin，token 由 Worker 注入，前端不需要。
  const apiUrl = import.meta.env.VITE_TWIN_SERVER || defaultServerUrl();
  const apiToken = import.meta.env.VITE_TWIN_API_TOKEN || undefined;
  const authHeaders = (): Record<string, string> => (apiToken ? { authorization: 'Bearer ' + apiToken } : {});

  const [mode, setMode] = createSignal<JudgeMode>('rule');
  const [jev, setJev] = createSignal<JevStatus>();
  const [record, setRecord] = createSignal<DecisionRecord>();
  const [count, setCount] = createSignal(0);
  const [running, setRunning] = createSignal(false);
  const [note, setNote] = createSignal<string>();
  const log = new DecisionLog();

  // Solid 2 RC 的 onSettled 取代了 onMount；回调返回清理函数或 undefined。
  onSettled(() => {
    void (async () => {
      try {
        const response = await fetch(apiUrl + '/api/jev/status', { headers: authHeaders() });
        setJev((await response.json()) as JevStatus);
      } catch {
        setJev({ configured: false });
      }
    })();
  });

  const state = (): FishingState | undefined => observeFishingWorld(props.session.world);

  const stateText = (): string => {
    const current = state();
    if (!current) return '当前场景不是钓场（缺少 rig 实体）。';
    const observation = current.observation;
    return [
      '灵钝 ' + current.rig.zone,
      '底承重 ' + current.rig.bottomLoad.toFixed(2),
      '意图 ' + current.intent,
      '有口 ' + observation.bites + ' / 中鱼 ' + observation.catches + ' / 空竿 ' + observation.emptyHooks,
    ].join(' · ');
  };

  const domain = () => {
    const base = props.session.host.decisions[0];
    if (!base) return undefined;
    if (mode() === 'rule') return base;
    return { ...base, judge: createJevJudge(createProxyJevClient({ basePath: apiUrl + '/api/jev/decide', headers: authHeaders() })) };
  };

  const run = async (): Promise<void> => {
    const current = state();
    const target = domain();
    if (!current || !target) return;
    setRunning(true);
    setNote(undefined);
    try {
      const engine = new DecisionEngine(target, log);
      setRecord(await engine.decide(current, { at: props.session.world.time }));
      setCount(summarizeDecisions(log.all()).total);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
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
          <button type="button" class="seg" disabled={running() || !state() || !domain()} onClick={() => void run()}>
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
            </article>
          )}
        </Show>

        <p class="plugin-contrib">本面板已记录 {count()} 次判断</p>
      </Show>
    </section>
  );
}
