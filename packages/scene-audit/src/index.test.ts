import { describe, expect, test } from 'bun:test';
import type { SceneTrace } from '@twin-platform/scene-spec';
import { runAudit, runEvalCases, assessObservationWindow, inspectSilentChange, renderAuditHtml, type SceneAuditCheck } from './index';

const trace: SceneTrace = {
  formatVersion: 1, sceneId: 'demo', sceneHash: 'a', seed: 1, step: 1, steps: 1,
  plugins: [], actions: [], events: [], finalState: { ok: true }, eventHash: 'b', stateHash: 'c',
};

describe('scene-audit', () => {
  test('检查失败与抛错都保留在报告里，后续检查仍执行', () => {
    const checks: SceneAuditCheck<number>[] = [
      { id: 'truth', description: '必须为正', check: (value) => value > 0 ? [] : [{ where: 'value', message: '不是正数' }] },
      { id: 'boom', description: '异常隔离', check: () => { throw new Error('broken <rule>'); } },
      { id: 'later', description: '继续执行', check: () => ({ notes: ['ran'] }) },
    ];
    const report = runAudit({ sceneId: 'demo', subject: 0, checks, metrics: { answer: 42 } });
    expect(report.passed).toBe(false);
    expect(report.checks.map((check) => check.status)).toEqual(['fail', 'error', 'pass']);
    expect(report.checks[2]?.notes).toEqual(['ran']);
    const html = renderAuditHtml(report, trace);
    expect(html).toContain('broken &lt;rule&gt;');
    expect(html).toContain('Trace 证据');
    expect(html).not.toMatch(/生成时间|Date\.now/);
  });

  test('eval 缺函数与异常均不中断，id 以清单为准', () => {
    const result = runEvalCases(
      [{ id: 1, prompt: 'a' }, { id: 2, prompt: 'b' }, { id: 3, prompt: 'c' }],
      { 1: () => ({ id: 99, pass: true, detail: 'ok' }), 2: () => { throw new Error('no'); }, 3: () => ({ id: 3, pass: true, detail: 'ok' }) },
    );
    expect(result.ok).toBe(false);
    expect(result.results[0]).toEqual({ id: 1, pass: true, detail: 'ok' });
    expect(result.results[1]?.detail).toContain('检查抛错');
    expect(result.passed).toBe(2);
  });

  test('观察窗与沉默旋钮明确区分未知和合法 no-op', () => {
    expect(assessObservationWindow({ observedSeconds: 30, requiredSeconds: 60 }).sufficient).toBe(false);
    expect(assessObservationWindow({ observedSeconds: 60, requiredSeconds: 60, samples: 2, minimumSamples: 2 }).sufficient).toBe(true);
    expect(inspectSilentChange('speed', 1, 1).suspicious).toBe(true);
    expect(inspectSilentChange('OBSERVE', 1, 1, true).suspicious).toBe(false);
    expect(inspectSilentChange('speed', 1, 2).suspicious).toBe(false);
  });
});
