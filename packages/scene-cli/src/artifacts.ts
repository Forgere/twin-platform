import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalize, type JsonValue, type SceneTrace } from '@twin-platform/scene-spec';

export const TRACE_FILE = 'trace.json';
export const REPORT_FILE = 'report.json';
export const HTML_FILE = 'report.html';
export const JUNIT_FILE = 'junit.xml';
export const BASELINE_DIR = 'expected';

/** 产物一律走 canonical JSON：键顺序固定，diff 与哈希才稳定。 */
export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(canonicalize(value), null, 2)}\n`, 'utf-8');
}

export function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

export function readTraceFile(path: string): SceneTrace {
  const raw = readJsonFile(path) as { formatVersion?: unknown };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} 不是 trace 对象。`);
  if ((raw as { formatVersion?: unknown }).formatVersion !== 1) {
    throw new Error(`${path} 的 formatVersion 不是 1；请用当前版本重新生成基线。`);
  }
  return raw as unknown as SceneTrace;
}

export const stableJson = (value: unknown): JsonValue => canonicalize(value);
