import { createSignal, For, Show } from 'solid-js';
import type { AuditStatus } from '@twin-platform/scene-spec';
import Icon from './Icon';
import type { AuditTarget, SceneAuditView } from '../scene/sceneAudit';

/**
 * 审计面板：把"场景到底符不符合契约"摆成看得懂的账。
 *
 * 只做呈现与定位，不做判定——判定在 `scene-audit`，取数在 `scene/sceneAudit.ts`。
 * 三条硬规矩：
 * 1. **不藏证据**：通过的检查也把账（notes）列出来，不折叠；
 * 2. **不编位置**：违例定位不出来就明说"无可定位证据"，按钮不给；
 * 3. **说清窗口**：结论只覆盖 t=from..to 这一段，写在面板顶上，不写在脚注里。
 */

const STATUS_TEXT: Readonly<Record<AuditStatus, string>> = { pass: '通过', fail: '失败', error: '执行出错' };

export interface AuditPanelProps {
  readonly audit: SceneAuditView;
  /** 定位造成的时间线分叉/回溯提示；空表示无异常。 */
  readonly notice?: string;
  readonly onCloseNotice?: () => void;
  /** 点违例上的定位：宿主负责 seek 到那一刻、把相机飞到那个实体。 */
  readonly onLocate: (target: AuditTarget) => void;
}

export default function AuditPanel(props: AuditPanelProps) {
  const [copyNote, setCopyNote] = createSignal<string>();
  const [showRaw, setShowRaw] = createSignal(false);

  const failing = () => props.audit.counts.fail + props.audit.counts.error;
  const verdict = (): string => {
    if (props.audit.checks.length === 0) return '未登记不变量';
    if (props.audit.passed) return '通过';
    // 窗口不全的时候不能只摸两个数字：那不是结论，是待查。
    return props.audit.windowComplete ? `${failing()} 项不符` : `${failing()} 项不符（窗口不足）`;
  };
  const window_ = () => {
    const { from, to, events } = props.audit.evidence;
    return `t=${from.toFixed(2)}–${to.toFixed(2)}s · ${events} 条事件 · ${props.audit.sceneId}`;
  };

  const copyReport = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(props.audit.report, null, 2));
      setCopyNote('已复制 AuditReport JSON，可直接喂给 bun run scene report。');
    } catch {
      setCopyNote('这个上下文不让写剪贴板；展开下面「原始 JSON」手动复制。');
    }
  };

  return (
    <section class="audit-panel" aria-label="场景审计">
      <h2>审计</h2>

      <div class={props.audit.passed ? 'audit-verdict audit-ok' : 'audit-verdict audit-bad'}>
        <span class="audit-verdict-word">{verdict()}</span>
        <span class="audit-verdict-counts">
          {props.audit.counts.pass} 通过 · {props.audit.counts.fail} 失败 · {props.audit.counts.error} 出错
        </span>
      </div>
      <p class="audit-window">{window_()}</p>

      <Show when={props.notice}>
        {(note) => (
          <div class="audit-fork" role="status">
            <span class="audit-fork-text">{note()}</span>
            <Show when={props.onCloseNotice}>
              <button
                type="button"
                class="audit-fork-close"
                aria-label="关闭回溯提示"
                title="关闭提示"
                onClick={props.onCloseNotice}
              >
                <Icon name="close" size={11} />
              </button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.audit.warnings.length > 0}>
        <ul class="audit-warnings">
          <For each={props.audit.warnings}>{(warning) => <li>{warning}</li>}</For>
        </ul>
      </Show>

      {/* 全绿的时候也不能是一个死面板：给一条“去看现场”，把最后一条事件放回画面上。 */}
      <Show when={props.audit.latest}>{(latest) => (
        <button type="button" class="audit-latest" title={latest().evidence} onClick={() => props.onLocate(latest())}>
          <Icon name="locate" size={12} /> 去看最后一条事件{latest().at === undefined ? '' : ` · t=${(latest().at ?? 0).toFixed(2)}s`}
        </button>
      )}</Show>

      <Show
        when={props.audit.checks.length > 0}
        fallback={
          <p class="muted">
            这个场景没有登记不变量。闭环不变量只对含「发生器 / 打包站 / 立库 / 卡车」的场景生效，
            别的布局不硬套——把它报成违例是假红灯。
          </p>
        }
      >
        <ul class="audit-checks">
          <For each={props.audit.checks}>
            {(check) => (
              <li class={`audit-check audit-${check.status}`}>
                <div class="audit-check-head">
                  <span class="audit-mark" aria-hidden="true">
                    <Icon name={check.status === 'pass' ? 'check' : 'alert'} size={12} />
                  </span>
                  <span class="audit-title">{check.description}</span>
                  <span class="audit-status">{STATUS_TEXT[check.status]}</span>
                </div>

                <For each={check.notes}>{(note) => <code class="audit-note">{note}</code>}</For>

                <For each={check.findings}>
                  {(finding) => (
                    <div class="audit-finding">
                      <p class="audit-message">
                        <Show when={finding.where}>{(where) => <code class="audit-where">{where()}</code>}</Show>
                        {finding.message}
                      </p>
                      <Show when={finding.target}>
                        {(target) => (
                          <button
                            type="button"
                            class="audit-locate"
                            title={target().evidence}
                            onClick={() => props.onLocate(target())}
                          >
                            <Icon name="locate" size={12} />
                            {target().at === undefined ? '选中实体' : `回到 t=${(target().at ?? 0).toFixed(2)}s`}
                          </button>
                        )}
                      </Show>
                    </div>
                  )}
                </For>

                <p class="audit-check-id">{check.id}</p>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <h3>审计口径</h3>
      <p class="audit-doctrine">
        与 <code>bun run scene audit</code> 同一个执行器、同一组不变量：纯只读检查，不改世界、不读挂钟。
        结论只覆盖上面的证据窗口，窗口外的历史不参与判定。
      </p>
      <div class="audit-actions">
        <button type="button" onClick={() => void copyReport()}>
          <Icon name="copy" size={12} /> 复制 AuditReport
        </button>
        <button type="button" onClick={() => setShowRaw((open) => !open)} aria-expanded={showRaw() ? 'true' : 'false'}>
          {showRaw() ? '收起原始 JSON' : '原始 JSON'}
        </button>
      </div>
      <Show when={copyNote()}>{(note) => <p class="audit-copied">{note()}</p>}</Show>
      <Show when={showRaw()}>
        <pre class="audit-raw">{JSON.stringify(props.audit.report, null, 2)}</pre>
      </Show>
    </section>
  );
}
