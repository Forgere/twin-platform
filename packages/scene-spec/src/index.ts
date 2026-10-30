/**
 * 可验证场景的公共数据契约。
 *
 * 本包不依赖 world-kernel、插件或任何行业代码。trace 既可以是参考内核的
 * 输出，也可以由外部 runtime adapter 生成；runner、audit 与 CI 只认这里
 * 的 JSON 形状。
 */

export * from './canonical';

export const SCENE_TRACE_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ScenePluginLock {
  readonly id: string;
  readonly version: string;
  readonly configHash?: string;
}

/** 一次外部输入。atStep=n 表示在第 n 个固定步之前应用，允许 atStep=steps。 */
export interface SceneActionRecord {
  readonly atStep: number;
  readonly id: string;
  readonly params?: JsonObject;
}

export interface SceneTraceEvent {
  readonly sequence: number;
  readonly occurredAt: number;
  readonly type: string;
  readonly entityId?: string;
  readonly detail?: string;
  readonly payload?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * 一次运行的完整、规范证据。finalState 由 runtime 决定形状，但必须能转成
 * JSON；参考 runtime 使用 WorldSnapshot。哈希是 FNV-1a，用于回归比较而非防伪。
 */
export interface SceneTrace {
  readonly formatVersion: typeof SCENE_TRACE_VERSION;
  readonly sceneId: string;
  readonly sceneHash: string;
  readonly seed: number;
  readonly step: number;
  readonly steps: number;
  readonly plugins: readonly ScenePluginLock[];
  readonly actions: readonly SceneActionRecord[];
  readonly events: readonly SceneTraceEvent[];
  readonly finalState: JsonValue;
  readonly eventHash: string;
  readonly stateHash: string;
}

export type AuditStatus = 'pass' | 'fail' | 'error';

export interface AuditViolation {
  readonly message: string;
  /** 可选定位：实体 id、参数组合、事件 sequence 等。 */
  readonly where?: string;
}

export interface AuditCheckResult {
  readonly id: string;
  readonly description: string;
  readonly status: AuditStatus;
  readonly violations: readonly AuditViolation[];
  readonly notes: readonly string[];
}

export interface AuditReport {
  readonly formatVersion: 1;
  readonly sceneId: string;
  readonly passed: boolean;
  readonly checks: readonly AuditCheckResult[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}

export interface EvalCase<Id extends string | number = string | number> {
  readonly id: Id;
  readonly prompt: string;
  readonly expectedOutput?: string;
}

export interface EvalResult<Id extends string | number = string | number> {
  readonly id: Id;
  readonly pass: boolean;
  readonly detail: string;
}

export interface EvalRun<Id extends string | number = string | number> {
  readonly results: readonly EvalResult<Id>[];
  readonly passed: number;
  readonly total: number;
  readonly ok: boolean;
}

export interface TraceDivergence {
  readonly pointer: string;
  readonly reason: 'missing' | 'type' | 'value' | 'length';
  readonly baseline?: JsonValue;
  readonly current?: JsonValue;
}

export interface TraceDiff {
  readonly identical: boolean;
  readonly baselineHash: string;
  readonly currentHash: string;
  readonly firstDivergence?: TraceDivergence;
}
