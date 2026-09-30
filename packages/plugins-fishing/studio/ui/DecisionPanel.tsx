import { createSignal, For, onSettled, Show } from 'solid-js';
import { DecisionLog, calibrationReport } from '@twin-platform/decision-core';
import { fishingSuccess } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { fetchJevStatus, loadDecisionLog, saveDecisionLog, type JevStatus, type JudgeMode } from './judging';

/**
 * 判断者记录与校准（嵌在「钓组」页的收起区里）。
 *
 * 问判断者、照它做、打 👍👎 都在钓鱼助手里完成——那里才有"当前遇到的情况"。
 * 这里只看攒下来的记录：按判断者（规则 / Jev）出校准表，以及清空记录。
 *
 * 决策日志落 localStorage：刷新不丢，校准表才可能攒够样本。真正跨设备/跨用户的
 * 持久化要等服务端决策仓储（见开发计划 Phase 6b）。
 */

export default function DecisionPanel(props: { session: StudioSessionPort }) {
  const [jev, setJev] = createSignal<JevStatus>();
  const [log, setLog] = createSignal<DecisionLog>();
  const [version, setVersion] = createSignal(0);

  onSettled(() => {
    setLog(loadDecisionLog());
    void fetchJevStatus(props.session).then(setJev);
  });

  const records = () => {
    version();
    return log()?.all() ?? [];
  };

  const JUDGES: { id: JudgeMode; label: string }[] = [
    { id: 'rule', label: '规则' },
    { id: 'jev', label: 'Jev' },
  ];

  const reportOf = (judge: JudgeMode) => calibrationReport(records(), { methodId: judge, success: fishingSuccess, buckets: 5, minSamples: 3 });

  /**
   * 一句话结论：回答"这个判断者靠不靠谱"。平均置信度比实际管用率高出 10 个点以上 = 偏自信，
   * 低 10 个点以上 = 偏保守，其余 = 说到做到。样本不够就只说还差几条。
   */
  const verdict = (judge: JudgeMode): { text: string; tone: 'ok' | 'warn' | 'idle' } => {
    const report = reportOf(judge);
    if (judge === 'jev' && jev()?.configured !== true && report.decided === 0) return { text: '未配置', tone: 'idle' };
    if (report.decided === 0) return { text: '还没有记录', tone: 'idle' };
    if (!report.trustworthy) return { text: '样本不足，再攒几条', tone: 'idle' };
    const gap = report.meanConfidence - report.successRate;
    if (gap > 0.1) return { text: '偏自信：说得比做得好', tone: 'warn' };
    if (gap < -0.1) return { text: '偏保守：其实比它说的准', tone: 'ok' };
    return { text: '说到做到', tone: 'ok' };
  };

  const pct = (value: number): string => (value * 100).toFixed(0) + '%';

  const clear = (): void => {
    const fresh = new DecisionLog('ui');
    setLog(fresh);
    saveDecisionLog(fresh);
    setVersion((value) => value + 1);
  };

  return (
    <section aria-label="判断者记录与校准" class="calib">
      <Show when={props.session.host.decisions.length > 0} fallback={<p class="plugin-note">当前插件没有决策域。</p>}>
        <Show
          when={records().length > 0}
          fallback={<p class="plugin-note">还没有记录。在钓鱼助手里采用一次判断者的建议并打 👍👎，这里就开始攒样本。</p>}
        >
          {/* 一行一个判断者：先给结论，数字作为依据跟在后面。 */}
          <table class="calib-table">
            <thead>
              <tr>
                <th>判断者</th>
                <th>记录</th>
                <th>管用率</th>
                <th>自报置信</th>
              </tr>
            </thead>
            <tbody>
              <For each={JUDGES}>
                {(judge) => (
                  <>
                    <tr>
                      <th scope="row">{judge.label}</th>
                      <td>{reportOf(judge.id).decided}</td>
                      <td>{reportOf(judge.id).decided > 0 ? pct(reportOf(judge.id).successRate) : '—'}</td>
                      <td>{reportOf(judge.id).decided > 0 ? pct(reportOf(judge.id).meanConfidence) : '—'}</td>
                    </tr>
                    <tr class="calib-verdict-row">
                      <td colspan={4}>
                        <span class={'calib-verdict calib-' + verdict(judge.id).tone}>{verdict(judge.id).text}</span>
                      </td>
                    </tr>
                  </>
                )}
              </For>
            </tbody>
          </table>

          <details class="calib-more">
            <summary>分桶明细（Brier）</summary>
            <For each={JUDGES.filter((judge) => reportOf(judge.id).decided > 0)}>
              {(judge) => (
                <div class="calib-buckets">
                  <p>
                    {judge.label} · Brier {reportOf(judge.id).brier.toFixed(3)}（越小越好）
                  </p>
                  <table class="decision-calibration">
                    <thead>
                      <tr>
                        <th>置信度</th>
                        <th>次数</th>
                        <th>命中率</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={reportOf(judge.id).buckets.filter((bucket) => bucket.decisions > 0)}>
                        {(bucket) => (
                          <tr>
                            <td>
                              {(bucket.lo * 100).toFixed(0)}–{(bucket.hi * 100).toFixed(0)}%
                            </td>
                            <td>{bucket.decisions}</td>
                            <td>{pct(bucket.rate)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              )}
            </For>
          </details>

          <button type="button" class="calib-clear" onClick={clear}>
            清空 {records().length} 条记录
          </button>
        </Show>
      </Show>
    </section>
  );
}
