import { canonicalize, stableHash, type SceneTrace } from '@twin-platform/scene-spec';

export interface TraceVerificationCheck {
  readonly id: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface TraceVerification {
  readonly ok: boolean;
  readonly checks: readonly TraceVerificationCheck[];
}

/** 外部 runtime 的契约验收：结构可读、事件有序、哈希由本端重算而非信对端自报。 */
export function verifySceneTrace(trace: SceneTrace): TraceVerification {
  const checks: TraceVerificationCheck[] = [];
  const check = (id: string, pass: boolean, detail: string): void => {
    checks.push({ id, pass, detail });
  };
  try {
    canonicalize(trace);
    check('structure', true, 'trace 可以规范化为 JSON');
  } catch (error) {
    check('structure', false, error instanceof Error ? error.message : String(error));
  }
  const ordered = trace.events.every((event, index) =>
    event.sequence === index + 1 && (index === 0 || event.occurredAt >= trace.events[index - 1]!.occurredAt),
  );
  check('event-order', ordered, ordered ? `${trace.events.length} 条事件序号连续、时间单调` : '事件序号不连续或 occurredAt 倒退');
  const eventHash = stableHash(trace.events);
  check('event-hash', trace.eventHash === eventHash, `声明 ${trace.eventHash} / 本端重算 ${eventHash}`);
  const stateHash = stableHash(trace.finalState);
  check('state-hash', trace.stateHash === stateHash, `声明 ${trace.stateHash} / 本端重算 ${stateHash}`);
  return { ok: checks.every((item) => item.pass), checks };
}
