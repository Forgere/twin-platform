import type { AuditReport, TraceDiff } from '@twin-platform/scene-spec';

export interface JUnitCase {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'error';
  readonly message?: string;
  readonly systemOut?: string;
}

export interface JUnitSuiteInput {
  readonly name: string;
  readonly cases: readonly JUnitCase[];
  readonly properties?: Readonly<Record<string, string | number>>;
}

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

/**
 * JUnit XML（CI 能直接读的最小形状）。
 *
 * 故意**不写 timestamp / time**：证据报告的价值在于同输入逐字节一致，
 * 挂钟时间会让每一份产物都不同，diff 与哈希就失去意义。
 */
export function toJUnitXml(input: JUnitSuiteInput): string {
  const failures = input.cases.filter((item) => item.status === 'fail').length;
  const errors = input.cases.filter((item) => item.status === 'error').length;
  const properties = Object.entries(input.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const propertyLines = properties.length === 0
    ? ''
    : `\n    <properties>${properties
        .map(([name, value]) => `\n      <property name="${escapeXml(name)}" value="${escapeXml(String(value))}"/>`)
        .join('')}\n    </properties>`;
  const cases = input.cases.map((item) => {
    const body: string[] = [];
    if (item.status === 'fail') body.push(`<failure message="${escapeXml(item.message ?? '不变量失败')}"/>`);
    if (item.status === 'error') body.push(`<error message="${escapeXml(item.message ?? '检查抛错')}"/>`);
    if (item.systemOut) body.push(`<system-out>${escapeXml(item.systemOut)}</system-out>`);
    return `\n    <testcase name="${escapeXml(item.name)}" classname="${escapeXml(input.name)}"${
      body.length === 0 ? ' />' : `>${body.join('')}\n    </testcase>`
    }`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${escapeXml(input.name)}" tests="${input.cases.length}" failures="${failures}" errors="${errors}">${propertyLines}${cases}
  </testsuite>
</testsuites>
`;
}

/** 审计报告（+ 可选差分）→ JUnit 用例；一条不变量一个用例，差分单独一个用例。 */
export function junitFromAudit(report: AuditReport, diff?: TraceDiff): string {
  const cases: JUnitCase[] = report.checks.map((check) => ({
    name: `invariant:${check.id}`,
    status: check.status,
    message: check.violations.map((item) => `${item.where ? `${item.where}: ` : ''}${item.message}`).join(' | '),
    systemOut: check.notes.join(' | '),
  }));
  if (diff) {
    cases.push({
      name: 'trace:diff',
      status: diff.identical ? 'pass' : 'fail',
      message: diff.firstDivergence
        ? `首个分歧 ${diff.firstDivergence.pointer}（${diff.firstDivergence.reason}）：baseline=${JSON.stringify(diff.firstDivergence.baseline ?? null)} current=${JSON.stringify(diff.firstDivergence.current ?? null)}`
        : 'trace 不一致',
      systemOut: `baseline=${diff.baselineHash} current=${diff.currentHash}`,
    });
  }
  if (cases.length === 0) {
    cases.push({ name: 'scene:run', status: 'pass', systemOut: '没有登记不变量：本次只产出 trace 证据。' });
  }
  return toJUnitXml({
    name: report.sceneId,
    cases,
    properties: {
      passed: report.passed ? 1 : 0,
      checks: report.checks.length,
      ...(diff ? { diffIdentical: diff.identical ? 1 : 0 } : {}),
      ...(diff?.firstDivergence ? { firstDivergence: diff.firstDivergence.pointer } : {}),
    },
  });
}
