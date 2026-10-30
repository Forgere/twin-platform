import type { AuditCheckResult, AuditReport, AuditViolation } from '@twin-platform/scene-spec';

export interface AuditCheckOutcome {
  readonly violations?: readonly AuditViolation[];
  readonly notes?: readonly string[];
}

export interface SceneAuditCheck<Subject> {
  readonly id: string;
  readonly description: string;
  check(subject: Subject): AuditCheckOutcome | readonly AuditViolation[];
}

export interface RunAuditInput<Subject> {
  readonly sceneId: string;
  readonly subject: Subject;
  readonly checks: readonly SceneAuditCheck<Subject>[];
  readonly metrics?: Readonly<Record<string, number>>;
  readonly warnings?: readonly string[];
}

/** 同步、确定性地执行检查；单条检查抛错会变成 error，不会掩盖其他检查结果。 */
export function runAudit<Subject>(input: RunAuditInput<Subject>): AuditReport {
  const checks: AuditCheckResult[] = input.checks.map((check) => {
    try {
      const raw = check.check(input.subject);
      const outcome = (Array.isArray(raw) ? { violations: raw } : raw) as AuditCheckOutcome;
      const violations = [...(outcome.violations ?? [])];
      return {
        id: check.id,
        description: check.description,
        status: violations.length === 0 ? 'pass' : 'fail',
        violations,
        notes: [...(outcome.notes ?? [])],
      };
    } catch (error) {
      return {
        id: check.id,
        description: check.description,
        status: 'error',
        violations: [{ message: error instanceof Error ? error.message : String(error) }],
        notes: [],
      };
    }
  });
  const metrics = { ...(input.metrics ?? {}) };
  for (const [id, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value)) throw new Error(`指标 ${id} 不是有限数字。`);
  }
  return {
    formatVersion: 1,
    sceneId: input.sceneId,
    passed: checks.every((check) => check.status === 'pass'),
    checks,
    metrics,
    warnings: [...(input.warnings ?? [])],
  };
}
