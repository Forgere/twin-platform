import { describe, expect, test } from 'bun:test';
import type { JevFetch, JevRequest } from '@twin-platform/plugins-fishing';
import { handleJevDecide, jevStatus } from './jev';

const ENV_WITH_KEY = { JEV_API_KEY: 'sk_test_key' } as const;

const validRequest: JevRequest = {
  state: { zone: 'sensitive', intent: 'bite_no_catch' },
  questions: [{ kind: 'choice', id: 'next_action', prompt: '下一步？', options: ['ADJUST_FLOAT', 'OBSERVE'] }],
};

const answer = (answers: Record<string, unknown>): JevFetch => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 0, message: 'ok', data: { result: { answers } } }),
});

describe('jevStatus', () => {
  test('未配置只回 configured:false，不泄漏任何字段', () => {
    expect(jevStatus({ env: {} })).toEqual({ status: 200, body: { configured: false } });
    expect(jevStatus({ env: { JEV_API_KEY: '   ' } })).toEqual({ status: 200, body: { configured: false } });
  });

  test('已配置回模型与 baseUrl，但绝不回 key', () => {
    const result = jevStatus({ env: ENV_WITH_KEY });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body['configured']).toBe(true);
    expect(body['model']).toBe('jev-latest');
    expect(JSON.stringify(body)).not.toContain('sk_test_key');
  });
});

describe('handleJevDecide', () => {
  test('未配置 key 明确回 501，而不是静默降级', async () => {
    const result = await handleJevDecide(validRequest, { env: {} });
    expect(result.status).toBe(501);
    expect(String((result.body as { error: string }).error)).toContain('JEV_API_KEY');
  });

  test('结构不合法回 400', async () => {
    const bad = await handleJevDecide({ state: { zone: 1 }, questions: [] }, { env: ENV_WITH_KEY });
    expect(bad.status).toBe(400);
    const alsoBad = await handleJevDecide({ questions: 'nope' }, { env: ENV_WITH_KEY });
    expect(alsoBad.status).toBe(400);
  });

  test('正常调用回 200 与解码后的决策', async () => {
    const result = await handleJevDecide(validRequest, {
      env: ENV_WITH_KEY,
      fetchImpl: answer({ next_action: { type: 'choice', choice: 'ADJUST_FLOAT', confidence: 0.77 } }),
    });
    expect(result.status).toBe(200);
    expect((result.body as { action: string }).action).toBe('ADJUST_FLOAT');
    expect((result.body as { actionConfidence: number }).actionConfidence).toBe(0.77);
  });

  test('上游 401 / 网络异常分别映射成 401 与 502', async () => {
    const unauthorized: JevFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
    const first = await handleJevDecide(validRequest, { env: ENV_WITH_KEY, fetchImpl: unauthorized });
    expect(first.status).toBe(401);

    const broken: JevFetch = async () => {
      throw new Error('socket closed');
    };
    const second = await handleJevDecide(validRequest, { env: ENV_WITH_KEY, fetchImpl: broken });
    expect(second.status).toBe(502);
  });
});
