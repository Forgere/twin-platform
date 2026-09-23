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

export const DEFAULT_JEV_BASE_URL = 'https://thejevai.com';
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';

export interface JevEnvConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  /** 提问措辞语言。本项目 prompt 是中文，所以缺省 zh-CN。 */
  readonly language: 'en-US' | 'zh-CN';
}

/** 从环境变量读配置。缺 key 是"还没配置"，返回 undefined，不抛错。 */
export function jevConfigFromEnv(env: Readonly<Record<string, string | undefined>>): JevEnvConfig | undefined {
  const apiKey = env['JEV_API_KEY'];
  if (typeof apiKey !== 'string' || apiKey === '') return undefined;
  return {
    apiKey,
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

interface WireEnvelope {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly data?: { readonly result?: { readonly answers?: Record<string, WireAnswer> } };
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

      if (!response.ok) throw new JevError('Jev 返回 HTTP ' + response.status, response.status);
      const payload = (await response.json()) as WireEnvelope;
      if (payload.code !== 0) throw new JevError('Jev 业务错误：' + String(payload.message ?? payload.code));
      const answers = payload.data?.result?.answers;
      if (!answers) throw new JevError('Jev 响应缺少 data.result.answers。');
      return decodeJevAnswers(answers);
    },
  };
}
