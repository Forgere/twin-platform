import { describe, expect, test } from 'bun:test';
import { calculateRigState } from './fishingCore';
import {
  DEFAULT_JEV_MODEL,
  JevError,
  createHttpJevClient,
  decodeJevAnswers,
  jevConfigFromEnv,
  questionsToWire,
  type JevFetch,
  type JevFetchResponse,
} from './jevClient';
import { toJevRequest } from './jevQuestions';
import { toFishingState } from './state';

const reply = (payload: unknown, status = 200): JevFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const envelope = (answers: Record<string, unknown>) => ({
  code: 0,
  message: 'ok',
  data: { result: { answers }, usage: { input_tokens: 42, output_tokens: 0 }, elapsedMs: 180 },
});

const request = () => {
  const rig = calculateRigState({ t0: 4, t: 2, w: 1, d: 1 });
  if (!rig.ok) throw new Error('测试钓组不合法');
  return toJevRequest(toFishingState(rig.state, {}));
};

describe('questionsToWire', () => {
  test('choice 用 criteria 对象，score 用 criteria 数组，noul 只带 instructions', () => {
    const wire = questionsToWire([
      { kind: 'choice', id: 'pick', prompt: '选一个', options: ['a', 'b'] },
      { kind: 'score', id: 'rate', prompt: '打分', levels: ['low', 'high'] },
      { kind: 'noul', id: 'gate', prompt: '要不要复核？' },
    ]);
    expect(wire['pick']).toEqual({ type: 'choice', instructions: '选一个', criteria: { a: 'a', b: 'b' } });
    expect(wire['rate']).toEqual({ type: 'score', instructions: '打分', criteria: ['low', 'high'] });
    expect(wire['gate']).toEqual({ type: 'noul', instructions: '要不要复核？' });
  });
});

describe('decodeJevAnswers', () => {
  test('读 choice / noul / score，缺失字段用保守缺省', () => {
    const decision = decodeJevAnswers({
      next_action: { type: 'choice', choice: 'ADJUST_FLOAT', confidence: 0.82 },
      float_direction: { type: 'choice', choice: 'blunt' },
      needs_observe: { type: 'noul', noul: 0.1 },
      urgency: { type: 'score', score: 2 },
    });
    expect(decision.action).toBe('ADJUST_FLOAT');
    expect(decision.actionConfidence).toBe(0.82);
    expect(decision.floatDirection).toBe('blunt');
    expect(decision.observeProbability).toBe(0.1);
    expect(decision.urgency).toBe(2);

    const empty = decodeJevAnswers({});
    expect(empty.action).toBeUndefined();
    expect(empty.actionConfidence).toBe(0.5);
    expect(empty.observeProbability).toBe(0);
  });
});

describe('createHttpJevClient', () => {
  test('请求形状正确：POST /v1/systemone + Bearer + model + 线上问题格式', async () => {
    let seen: { url: string; init: { method: string; headers: Record<string, string>; body: string } } | undefined;
    const fetchImpl: JevFetch = async (url, init) => {
      seen = { url, init };
      return reply(envelope({ next_action: { type: 'choice', choice: 'ADJUST_FLOAT', confidence: 0.8 } }));
    };
    const client = createHttpJevClient({ apiKey: 'sk_test_key', fetchImpl });
    const decision = await client.decide(request());

    expect(seen?.url).toBe('https://thejevai.com/v1/systemone');
    expect(seen?.init.method).toBe('POST');
    expect(seen?.init.headers['authorization']).toBe('Bearer sk_test_key');
    const body = JSON.parse(seen!.init.body) as { model: string; state: Record<string, string>; questions: Record<string, { type: string }> };
    expect(body.model).toBe(DEFAULT_JEV_MODEL);
    expect(body.state['zone']).toBe('sensitive');
    expect(body.questions['next_action']?.type).toBe('choice');
    expect(body.questions['needs_observe']?.type).toBe('noul');
    expect(body.questions['urgency']?.type).toBe('score');
    expect(decision.action).toBe('ADJUST_FLOAT');
    expect(decision.actionConfidence).toBe(0.8);
  });

  test('baseUrl 覆盖与结尾斜杠都被处理', async () => {
    let url = '';
    const fetchImpl: JevFetch = async (target) => {
      url = target;
      return reply(envelope({}));
    };
    await createHttpJevClient({ apiKey: 'k', baseUrl: 'https://example.test/', fetchImpl }).decide(request());
    expect(url).toBe('https://example.test/v1/systemone');
  });

  test('code 非 0、缺 answers、非 2xx 都抛 JevError', async () => {
    const fail = (payload: unknown, status = 200): JevFetch => async () => reply(payload, status);
    await expect(createHttpJevClient({ apiKey: 'k', fetchImpl: fail({ code: 1, message: 'bad' }) }).decide(request())).rejects.toBeInstanceOf(JevError);
    await expect(createHttpJevClient({ apiKey: 'k', fetchImpl: fail({ code: 0, data: {} }) }).decide(request())).rejects.toBeInstanceOf(JevError);
    await expect(createHttpJevClient({ apiKey: 'k', fetchImpl: fail({}, 401) }).decide(request())).rejects.toThrow(/401/);
  });

  test('网络异常被包成 JevError，不泄漏原始堆栈以外的信息', async () => {
    const fetchImpl: JevFetch = async () => {
      throw new Error('socket closed');
    };
    await expect(createHttpJevClient({ apiKey: 'k', fetchImpl }).decide(request())).rejects.toThrow(/socket closed/);
  });
});

describe('jevConfigFromEnv', () => {
  test('缺 key 返回 undefined，有 key 时读覆盖项并默认中文', () => {
    expect(jevConfigFromEnv({})).toBeUndefined();
    expect(jevConfigFromEnv({ JEV_API_KEY: '' })).toBeUndefined();
    const config = jevConfigFromEnv({ JEV_API_KEY: 'sk_x', JEV_MODEL: 'typesafe/jev-1.13' });
    expect(config?.apiKey).toBe('sk_x');
    expect(config?.baseUrl).toBe('https://thejevai.com');
    expect(config?.language).toBe('zh-CN');
    expect(jevConfigFromEnv({ JEV_API_KEY: 'k', JEV_LANGUAGE: 'en-US' })?.language).toBe('en-US');
  });
});
