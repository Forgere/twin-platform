import {
  JevError,
  createHttpJevClient,
  jevConfigFromEnv,
  type JevFetch,
  type JevQuestion,
  type JevRequest,
} from '@twin-platform/plugins-fishing';

/**
 * Jev 判断的服务端路由。
 *
 * 存在的理由只有一个：**密钥不能进浏览器**。前端只打同源 `/api/jev/*`，
 * 由本进程带着 `JEV_API_KEY` 去调 Jev —— 和 `TWIN_API_TOKEN` 由 Worker 注入同一思路。
 *
 * 这里刻意保持"薄"：不做台钓语义，只负责环境配置、结构校验、错误映射与转发。
 * 判断装配（choice -> action -> params）仍在共享包的 `createJevJudge` 里。
 */

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
}

export interface JevRouteDeps {
  /** 环境变量。测试注入，生产传 `process.env`。 */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** 单测注入假的 fetch；生产不传，走全局 fetch。 */
  readonly fetchImpl?: JevFetch;
}

/** GET /api/jev/status：只回"配没配"和模型名，绝不回 key。 */
export function jevStatus(deps: JevRouteDeps): RouteResult {
  const config = jevConfigFromEnv(deps.env);
  return config
    ? { status: 200, body: { configured: true, model: config.model, baseUrl: config.baseUrl, language: config.language } }
    : { status: 200, body: { configured: false } };
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string');

function isQuestion(value: unknown): value is JevQuestion {
  if (typeof value !== 'object' || value === null) return false;
  const question = value as { kind?: unknown; id?: unknown; prompt?: unknown; options?: unknown; levels?: unknown };
  if (typeof question.id !== 'string' || typeof question.prompt !== 'string') return false;
  if (question.kind === 'choice') return Array.isArray(question.options) && question.options.every((item) => typeof item === 'string');
  if (question.kind === 'score') return Array.isArray(question.levels) && question.levels.every((item) => typeof item === 'string');
  return question.kind === 'noul';
}

function isJevRequest(value: unknown): value is JevRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { state?: unknown; questions?: unknown };
  if (!isStringRecord(candidate.state)) return false;
  if (!Array.isArray(candidate.questions) || candidate.questions.length === 0) return false;
  return candidate.questions.every(isQuestion);
}

/** POST /api/jev/decide：把 Jev 调用收在服务端。 */
export async function handleJevDecide(payload: unknown, deps: JevRouteDeps): Promise<RouteResult> {
  const config = jevConfigFromEnv(deps.env);
  if (!config) return { status: 501, body: { error: 'JEV_API_KEY 未配置，Jev 判断不可用。' } };
  if (!isJevRequest(payload)) {
    return { status: 400, body: { error: '请求体必须是 { state: 字符串值对象, questions: 非空数组 }。' } };
  }

  const client = createHttpJevClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  try {
    return { status: 200, body: await client.decide(payload) };
  } catch (error) {
    // JevError 自带上游状态码（401/402…）；未知异常一律 502，不回内部堆栈。
    if (error instanceof JevError) return { status: error.status ?? 502, body: { error: error.message } };
    return { status: 502, body: { error: 'Jev 调用失败。' } };
  }
}
