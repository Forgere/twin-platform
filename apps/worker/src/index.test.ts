import { describe, expect, test } from 'bun:test';
import worker, { isApiPath, isStaticOnly, proxyApi, upstreamUrl, type WorkerEnv } from './index';

/** 记录式 fetch：核对"发出去的请求长什么样"，不真的发包。 */
function recorder(respond: () => Response = () => Response.json({ ok: true })) {
  const calls: { url: string; method: string; headers: Headers; body: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // body 是流（透传上游用的就是流），得真读出来才能断言内容。
    const body =
      init?.body === undefined || init?.body === null
        ? null
        : typeof init.body === 'string'
          ? init.body
          : await new Response(init.body as BodyInit).text();
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers, body });
    return respond();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const env = (overrides: Partial<WorkerEnv> = {}): WorkerEnv => ({
  ASSETS: { fetch: async () => new Response('asset') },
  UPSTREAM: 'http://127.0.0.1:8799',
  API_TOKEN: 's3cret',
  ...overrides,
});

describe('isApiPath', () => {
  test('只有 /api 与 /api/... 走反代', () => {
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/api/health')).toBe(true);
    expect(isApiPath('/api/')).toBe(true);
    expect(isApiPath('/apix')).toBe(false);
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/index.html')).toBe(false);
  });
});

describe('upstreamUrl', () => {
  test('上游只认 origin：path 与 query 原样搬过去', () => {
    const request = new Request('http://studio.local/api/events?sceneId=line-a&limit=5');
    expect(upstreamUrl(request, 'http://127.0.0.1:8799')).toBe(
      'http://127.0.0.1:8799/api/events?sceneId=line-a&limit=5',
    );
    // 上游写了路径也不被请求自己的路径污染（base.pathname 被覆盖）。
    expect(upstreamUrl(request, 'http://127.0.0.1:8799/prefix')).toBe(
      'http://127.0.0.1:8799/api/events?sceneId=line-a&limit=5',
    );
  });
});

describe('proxyApi', () => {
  test('注入 Authorization，并且剥掉客户端自带的', async () => {
    const { calls, fetchImpl } = recorder();
    const request = new Request('http://studio.local/api/scenes', {
      headers: { authorization: 'Bearer guess', 'content-type': 'application/json' },
    });
    await proxyApi(request, env(), fetchImpl);

    expect(calls[0]?.headers.get('authorization')).toBe('Bearer s3cret');
    // 其余头必须原样透传（content-type 是 JSON 接口的命门）。
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
  });

  test('没配 API_TOKEN 就不注入，也不留空头', async () => {
    const { calls, fetchImpl } = recorder();
    await proxyApi(new Request('http://studio.local/api/health'), env({ API_TOKEN: undefined }), fetchImpl);
    expect(calls[0]?.headers.get('authorization')).toBeNull();
  });

  test('写方法透传 body 与 method，GET 不带 body', async () => {
    const { calls, fetchImpl } = recorder();

    await proxyApi(
      new Request('http://studio.local/api/events?sceneId=line-a', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '[{"sequence":1}]',
      }),
      env(),
      fetchImpl,
    );
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('[{"sequence":1}]');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8799/api/events?sceneId=line-a');

    await proxyApi(new Request('http://studio.local/api/scenes'), env(), fetchImpl);
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.body).toBeNull();
  });

  test('没配上游 → 502，且不发包', async () => {
    const { calls, fetchImpl } = recorder();
    const response = await proxyApi(new Request('http://studio.local/api/health'), env({ UPSTREAM: undefined }), fetchImpl);
    expect(response.status).toBe(502);
    expect(calls).toHaveLength(0);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('UPSTREAM') });
  });

  test('上游连不上 → 502 而不是把 fetch 的异常抛给访客', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const response = await proxyApi(new Request('http://studio.local/api/health'), env(), failing);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('不可达') });
  });

  test('上游返回什么就透传什么（状态码与 body 不改写）', async () => {
    const { fetchImpl } = recorder(() =>
      Response.json({ error: 'API token 无效。' }, { status: 401 }),
    );
    const response = await proxyApi(new Request('http://studio.local/api/scenes'), env(), fetchImpl);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'API token 无效。' });
  });
});

describe('worker.fetch', () => {
  test('非 API 路径交给静态资产', async () => {
    const response = await worker.fetch(new Request('http://studio.local/'), env());
    expect(await response.text()).toBe('asset');
  });

  test('/api 走反代，不碰资产', async () => {
    const assets: WorkerEnv = {
      ASSETS: { fetch: async () => new Response('asset') },
      UPSTREAM: undefined,
      API_TOKEN: 's3cret',
    };
    const response = await worker.fetch(new Request('http://studio.local/api/health'), assets);
    // 上游没配 → 502（说明走的是反代分支，而不是返回静态资产）。
    expect(response.status).toBe(502);
  });

  test('单场景静态部署：/api 一律 404，不发包、也不回 502 未配置上游', async () => {
    const response = await worker.fetch(new Request('http://scene.local/api/health'), env({ STATIC_ONLY: '1', UPSTREAM: undefined }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('静态') });
  });

  test('单场景静态部署：资产照常发（含 /scene.json）', async () => {
    const response = await worker.fetch(new Request('http://scene.local/scene.json'), env({ STATIC_ONLY: '1' }));
    expect(await response.text()).toBe('asset');
  });
});

describe('isStaticOnly', () => {
  test('只有 1 / true 开静态模式，未配置保持反代语义', () => {
    expect(isStaticOnly({ STATIC_ONLY: '1' })).toBe(true);
    expect(isStaticOnly({ STATIC_ONLY: 'true' })).toBe(true);
    expect(isStaticOnly({ STATIC_ONLY: '0' })).toBe(false);
    expect(isStaticOnly({})).toBe(false);
  });
});
