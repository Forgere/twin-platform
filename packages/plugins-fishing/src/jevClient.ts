import type { JevQuestion, JevRequest } from './jevQuestions';

/**
 * Jev 的 REST 客户端。
 *
 * 契约（来自 jev-agent 技能文档）：
 *   POST {baseUrl}/v1/systemone
 *   Authorization: Bearer $JEV_API_KEY
 *   { model, state, questions: { <id>: { type, instructions, criteria? } } }
 *   响应信封：{ code, message, data: { result: { answers: { <id>: ... } } } }
 *
 * 两条纪律：
 * - **密钥只在这里出现，且由调用方从服务端环境注入**：库里不读 process.env、
 *   不进前端 bundle、不写日志；
 * - `fetch` 可注入，所以请求形状能在单测里断言，不需要真的联网、不需要 key。
 */

export interface JevDecision {
  readonly action?: string;
  readonly actionConfidence: number;
  readonly floatDirection?: string;
  readonly baitTarget?: string;
  readonly observeProbability: number;
  readonly urgency?: number;
}

export interface JevClient {
  readonly id: string;
  decide(request: JevRequest): Promise<JevDecision>;
}

export class JevError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

/** 只依赖用到的三个成员，避免把 packages 绑到 DOM lib 上。 */
export interface JevFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type JevFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body: string },
) => Promise<JevFetchResponse>;

export interface JevHttpOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: JevFetch;
}

export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai';
export const DEFAULT_JEV_MODEL = 'jev-latest';

export interface JevEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  /** 提问措辞语言。本项目 prompt 是中文，所以缺省 zh-CN。 */
  readonly language: 'en-US' | 'zh-CN';
}

/** 从环境变量读配置。缺 key 是"还没配置"，返回 undefined，不抛错。 */
export function jevConfigFromEnv(env: Readonly<Record<string, string | undefined>>): JevEnvConfig | undefined {
  const raw = env['JEV_API_KEY'];
  // 与 auth.ts 一致：纯空白算未配置；有值时去掉首尾空白。
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return {
    apiKey: raw.trim(),
    baseUrl: env['JEV_API_BASE_URL'] ?? DEFAULT_JEV_BASE_URL,
    model: env['JEV_MODEL'] ?? DEFAULT_JEV_MODEL,
    language: env['JEV_LANGUAGE'] === 'en-US' ? 'en-US' : 'zh-CN',
  };
}

/** 把域内问题翻译成 Jev 的线上格式。 */
export function questionsToWire(questions: readonly JevQuestion[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const question of questions) {
    if (question.kind === 'choice') {
      out[question.id] = {
        type: 'choice',
        instructions: question.prompt,
        criteria: Object.fromEntries(question.options.map((option) => [option, option])),
      };
    } else if (question.kind === 'score') {
      out[question.id] = { type: 'score', instructions: question.prompt, criteria: question.levels };
    } else {
      out[question.id] = { type: 'noul', instructions: question.prompt };
    }
  }
  return out;
}

interface WireAnswer {
  readonly choice?: unknown;
  readonly score?: unknown;
  readonly noul?: unknown;
  readonly confidence?: unknown;
}

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 从响应里取出 answers，兼容两种形状：
 * - TypeSafe 官方直连：`{ model, answers, usage }`
 * - 技能文档里的托管信封：`{ code, message, data: { result: { answers } } }`
 */
export function extractAnswers(payload: unknown): Record<string, WireAnswer> | undefined {
  if (!isRecordLike(payload)) return undefined;
  if (typeof payload['code'] === 'number' && payload['code'] !== 0) {
    const message = typeof payload['message'] === 'string' ? payload['message'] : String(payload['code']);
    throw new JevError('Jev 业务错误：' + message);
  }
  const direct = payload['answers'];
  if (isRecordLike(direct)) return direct as Record<string, WireAnswer>;
  const data = payload['data'];
  const result = isRecordLike(data) ? data['result'] : undefined;
  const nested = isRecordLike(result) ? result['answers'] : undefined;
  return isRecordLike(nested) ? (nested as Record<string, WireAnswer>) : undefined;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** 把线上 answers 收敛成域内决策；缺失字段用保守缺省，不猜测。 */
export function decodeJevAnswers(answers: Record<string, WireAnswer>): JevDecision {
  const next = answers['next_action'];
  const float = answers['float_direction'];
  const bait = answers['bait_target'];
  const observe = answers['needs_observe'];
  const urgency = answers['urgency'];
  return {
    action: asString(next?.choice),
    actionConfidence: asNumber(next?.confidence) ?? 0.5,
    floatDirection: asString(float?.choice),
    baitTarget: asString(bait?.choice),
    observeProbability: asNumber(observe?.noul) ?? 0,
    urgency: asNumber(urgency?.score),
  };
}

/** 从非 2xx 响应里取一段可安全展示的错误说明（不含请求凭据）。 */
async function readErrorDetail(response: JevFetchResponse): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown; message?: unknown; detail?: unknown };
    const candidate = payload.error ?? payload.message ?? payload.detail;
    if (typeof candidate === 'string') return candidate.slice(0, 300);
    return JSON.stringify(payload).slice(0, 300);
  } catch {
    return '';
  }
}

export function createHttpJevClient(options: JevHttpOptions): JevClient {
  const base = (options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, '');
  const model = options.model ?? DEFAULT_JEV_MODEL;

  return {
    id: 'jev-http',
    async decide(request: JevRequest): Promise<JevDecision> {
      const doFetch = options.fetchImpl ?? (globalThis as unknown as { fetch?: JevFetch }).fetch;
      if (!doFetch) throw new JevError('当前环境没有 fetch，请注入 fetchImpl。');

      const body = JSON.stringify({ model, state: request.state, questions: questionsToWire(request.questions) });
      let response: JevFetchResponse;
      try {
        response = await doFetch(base + '/v1/systemone', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + options.apiKey },
          body,
        });
      } catch (error) {
        throw new JevError('Jev 请求失败：' + (error instanceof Error ? error.message : String(error)));
      }

      if (!response.ok) {
        const detail = await readErrorDetail(response);
        throw new JevError('Jev 返回 HTTP ' + response.status + (detail === '' ? '' : '：' + detail), response.status);
      }
      const answers = extractAnswers(await response.json());
      if (!answers) throw new JevError('Jev 响应缺少 answers。');
      return decodeJevAnswers(answers);
    },
  };
}

export interface JevProxyOptions {
  /** 同源代理路径，默认 `/api/jev/decide`。 */
  readonly basePath?: string;
  readonly fetchImpl?: JevFetch;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * 浏览器侧客户端：只打同源代理，**key 留在服务端**。
 *
 * 与 `createHttpJevClient` 的区别只有一个：一个拿 key 直连 Jev（服务端用），
 * 一个经过 `/api/jev/decide`（前端用）。两者都是 `JevClient`，判断层无感。
 */
export function createProxyJevClient(options: JevProxyOptions = {}): JevClient {
  const basePath = options.basePath ?? '/api/jev/decide';
  return {
    id: 'jev-proxy',
    async decide(request: JevRequest): Promise<JevDecision> {
      const doFetch = options.fetchImpl ?? (globalThis as unknown as { fetch?: JevFetch }).fetch;
      if (!doFetch) throw new JevError('当前环境没有 fetch，请注入 fetchImpl。');

      let response: JevFetchResponse;
      try {
        response = await doFetch(basePath, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
          body: JSON.stringify(request),
        });
      } catch (error) {
        throw new JevError('Jev 代理请求失败：' + (error instanceof Error ? error.message : String(error)));
      }

      if (!response.ok) throw new JevError('Jev 代理返回 HTTP ' + response.status, response.status);
      const payload = (await response.json()) as Partial<JevDecision> & { error?: unknown };
      if (typeof payload.error === 'string') throw new JevError('Jev 代理错误：' + payload.error);
      return {
        action: typeof payload.action === 'string' ? payload.action : undefined,
        actionConfidence: typeof payload.actionConfidence === 'number' ? payload.actionConfidence : 0.5,
        floatDirection: typeof payload.floatDirection === 'string' ? payload.floatDirection : undefined,
        baitTarget: typeof payload.baitTarget === 'string' ? payload.baitTarget : undefined,
        observeProbability: typeof payload.observeProbability === 'number' ? payload.observeProbability : 0,
        urgency: typeof payload.urgency === 'number' ? payload.urgency : undefined,
      };
    },
  };
}
