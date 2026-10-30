import { canonicalJson, type AuditReport, type SceneTrace, type TraceDiff } from '@twin-platform/scene-spec';

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

/**
 * 自包含 HTML 证据报告。故意不写生成时间：同一份报告输入必须逐字节一致。
 * trace/diff 以 JSON 嵌入，报告既可读，也可保存后继续机器复查。
 */
export function renderAuditHtml(report: AuditReport, trace?: SceneTrace, diff?: TraceDiff): string {
  const checkRows = report.checks.map((check) => {
    const violations = check.violations.length === 0
      ? '—'
      : `<ul>${check.violations.map((item) => `<li>${item.where ? `<code>${escapeHtml(item.where)}</code>：` : ''}${escapeHtml(item.message)}</li>`).join('')}</ul>`;
    const notes = check.notes.length === 0 ? '' : `<div class="notes">${check.notes.map(escapeHtml).join('<br>')}</div>`;
    return `<tr><td><code>${escapeHtml(check.id)}</code><br>${escapeHtml(check.description)}${notes}</td><td class="${check.status}">${check.status.toUpperCase()}</td><td>${violations}</td></tr>`;
  }).join('\n');
  const metricRows = Object.entries(report.metrics).map(([id, value]) =>
    `<tr><td><code>${escapeHtml(id)}</code></td><td>${escapeHtml(value)}</td></tr>`,
  ).join('\n');
  const warnings = report.warnings.length === 0 ? '' : `<section><h2>观察窗与警告</h2><ul>${report.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
  const divergence = diff?.firstDivergence
    ? `<section><h2>首个分歧</h2><p><code>${escapeHtml(diff.firstDivergence.pointer)}</code> · ${escapeHtml(diff.firstDivergence.reason)}</p><pre>${escapeHtml(canonicalJson({ baseline: diff.firstDivergence.baseline ?? null, current: diff.firstDivergence.current ?? null }))}</pre></section>`
    : '';
  const evidence = trace
    ? `<section><h2>Trace 证据</h2><dl><dt>Scene hash</dt><dd><code>${trace.sceneHash}</code></dd><dt>Event hash</dt><dd><code>${trace.eventHash}</code></dd><dt>State hash</dt><dd><code>${trace.stateHash}</code></dd><dt>Seed / step / steps</dt><dd>${trace.seed} / ${trace.step} / ${trace.steps}</dd></dl><details><summary>完整 trace JSON</summary><pre>${escapeHtml(canonicalJson(trace))}</pre></details></section>`
    : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scene Audit · ${escapeHtml(report.sceneId)}</title>
<style>body{font:14px/1.55 system-ui,sans-serif;max-width:1100px;margin:32px auto;padding:0 20px;color:#17202a}h1,h2{line-height:1.25}.badge{font-weight:700}.pass{color:#08783e}.fail,.error{color:#b42318}table{width:100%;border-collapse:collapse;margin:12px 0 28px}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d8dee6;padding:10px}code,pre{font-family:ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f6f8;padding:14px}dt{font-weight:700}dd{margin-bottom:8px}.notes{opacity:.72;margin-top:5px}</style></head>
<body><h1>场景审计报告</h1><p><strong>${escapeHtml(report.sceneId)}</strong> · <span class="badge ${report.passed ? 'pass' : 'fail'}">${report.passed ? 'PASS' : 'FAIL'}</span></p>
${warnings}${divergence}
<section><h2>不变量</h2><table><thead><tr><th>检查</th><th>结果</th><th>违例</th></tr></thead><tbody>${checkRows || '<tr><td colspan="3">未登记检查</td></tr>'}</tbody></table></section>
${metricRows ? `<section><h2>指标</h2><table><thead><tr><th>指标</th><th>值</th></tr></thead><tbody>${metricRows}</tbody></table></section>` : ''}
${evidence}</body></html>`;
}
