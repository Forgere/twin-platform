import { createSignal, For, onSettled, Show } from 'solid-js';
import { DecisionLog, calibrationReport } from '@twin-platform/decision-core';
import { fishingSuccess } from '@twin-platform/plugins-fishing';
import type { StudioSession } from '../scene/studioSession';
import { fetchJevStatus, loadDecisionLog, saveDecisionLog, type JevStatus, type JudgeMode } from './fishing/judging';

/**
 * 判断者记录与校准（嵌在「钓组」页的收起区里）。
 *
 * 问判断者、照它做、打 👍👎 都在钓鱼助手里完成——那里才有"当前遇到的情况"。
 * 这里只看攒下来的记录：按判断者（规则 / Jev）出校准表，以及清空记录。
 *
 * 决策日志落 localStorage：刷新不丢，校准表才可能攒够样本。真正跨设备/跨用户的
 * 持久化要等服务端决策仓储（见开发计划 Phase 6b）。
 */

export default function DecisionPanel(props: { session: StudioSession }) {
  const [mode, setMode] = createSignal<JudgeMode>('rule');
  const [jev, setJev] = createSignal<JevStatus>();
  const [log, setLog] = createSignal<DecisionLog>();
  const [version, setVersion] = createSignal(0);

  onSettled(() => {
    setLog(loadDecisionLog());
    void fetchJevStatus().then(setJev);
  });

  const records = () => {
    version();
    return log()?.all() ?? [];
  };

  const report = () => calibrationReport(records(), { methodId: mode(), success: fishingSuccess, buckets: 5, minSamples: 3 });

  const clear = (): void => {
    const fresh = new DecisionLog('ui');
    setLog(fresh);
    saveDecisionLog(fresh);
    setVersion((value) => value + 1);
  };

  return (
    <section aria-label="判断者记录与校准">
      <Show when={props.session.host.decisions.length > 0} fallback={<p class="plugin-note">当前插件没有决策域。</p>}>
        <div class="segmented" role="group" aria-label="看哪个判断者">
          <button type="button" class={mode() === 'rule' ? 'seg seg-active' : 'seg'} onClick={() => setMode('rule')}>
            规则
          </button>
          <button
            type="button"
            class={mode() === 'jev' ? 'seg seg-active' : 'seg'}
            title={jev()?.configured === true ? 'Jev（' + String(jev()?.model) + '）' : 'Jev 未配置：在 apps/server/.env 设 JEV_API_KEY'}
            onClick={() => setMode('jev')}
          >
            Jev
          </button>
        </div>

        <Show when={report().decided === 0}>
          <p class="plugin-note">还没有记录。在钓鱼助手里问一次判断者、打个 👍👎，这里就开始攒样本。</p>
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
