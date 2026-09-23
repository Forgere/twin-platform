import { describe, expect, test } from 'bun:test';
import { contractScene } from '@twin-platform/storage-testkit';
import type { WorldEvent, WorldSnapshot } from '@twin-platform/world-kernel';
import { createHttpStorage, defaultServerUrl, pingServer } from './index';

/**
 * HTTP 仓储的测试重点是**请求形状**：URL、方法、查询参数、请求体对不对。
 *
 * 契约语义（排序、单调性、副本）由服务端那边的 `storage-file` 保证，
 * 客户端的职责是"发出正确的请求、把响应正确解析回来"——所以这里用记录式
 * fetch 逐个核对，而不是再跑一遍完整的仓储契约。
 */

interface Call {
  url: string;
  method: string;
  body?: unknown;
  headers: Headers;
  authorization: string | null;
  contentType: string | null;
}

function harness(
  respond: (url: string) => unknown = () => ({}),
  options: { batchSize?: number; token?: string } = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers,
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
    });
    const body = respond(url);
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    storage: createHttpStorage({
      baseUrl: 'http://srv',
      fetchImpl,
      batchSize: options.batchSize ?? 64,
      token: options.token,
    }),
  };
}

const event = (sequence: number): WorldEvent => ({
  sequence,
  occurredAt: sequence * 0.5,
  type: 'contract:tick',
  entityId: 'belt-01',
});

const snapshot = (sequence: number): WorldSnapshot => ({
  sceneId: 'line-a',
  sequence,
  time: sequence * 0.1,
  step: 1 / 60,
  seed: 1,
  rngState: 1,
  mode: 'sim',
  entities: [],
});

describe('createHttpStorage / 请求形状', () => {
  test('场景：列表 / 读取 / 保存 / 删除', async () => {
    const { calls, storage } = harness(() => []);
    await storage.scenes.listScenes();
    await storage.scenes.getScene('line-a');
    await storage.scenes.putScene(contractScene);
    await (storage.scenes as unknown as { remove(id: string): Promise<boolean> }).remove('line-a');

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'GET http://srv/api/scenes',
      'GET http://srv/api/scenes/line-a',
      'POST http://srv/api/scenes',
      'DELETE http://srv/api/scenes/line-a',
    ]);
    // 保存时整个场景进请求体，服务端那边会再校验一次。
    expect(calls[2]?.body).toMatchObject({ id: 'contract-scene' });
  });

  test('id 需要转义，中文/空格不能把 URL 打断', async () => {
    const { calls, storage } = harness();
    await storage.scenes.getScene('车间 A');
    expect(calls[0]?.url).toBe('http://srv/api/scenes/' + encodeURIComponent('车间 A'));
  });

  test('事件：查询参数按契约名映射到短名', async () => {
    const { calls, storage } = harness(() => []);
    await storage.events.query('line-a', {
      sinceSequence: 5,
      untilSequence: 9,
      entityId: 'belt-01',
      type: 'goods:produced',
      limit: 20,
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/events');
    expect(url.searchParams.get('sceneId')).toBe('line-a');
    expect(url.searchParams.get('since')).toBe('5');
    expect(url.searchParams.get('until')).toBe('9');
    expect(url.searchParams.get('entityId')).toBe('belt-01');
    expect(url.searchParams.get('type')).toBe('goods:produced');
    expect(url.searchParams.get('limit')).toBe('20');
  });

  test('事件：追加与截断（截断前会先把攒下的事件冲掉）', async () => {
    const { calls, storage } = harness(() => ({ written: 2, removed: 3 }));
    expect(await storage.events.append('line-a', [event(1), event(2)])).toBe(2);
    // 攒批：还没到 batchSize，此时不该发请求。
    expect(calls).toHaveLength(0);

    expect(await storage.events.truncateAfter('line-a', 7)).toBe(3);
    expect(calls[0]?.method).toBe('POST');
    expect(new URL(calls[0]!.url).searchParams.get('sceneId')).toBe('line-a');
    expect(calls[0]?.body).toHaveLength(2);
    expect(new URL(calls[1]!.url).searchParams.get('sequence')).toBe('7');
  });

  test('攒够 batchSize 立即发送，不用等定时器', async () => {
    const { calls, storage } = harness(() => ({ written: 3 }), { batchSize: 3 });
    await storage.events.append('line-a', [event(1), event(2), event(3)]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toHaveLength(3);
  });

  test('flush 把攒下的全部发出去', async () => {
    const { calls, storage } = harness(() => ({ written: 2 }));
    await storage.events.append('line-a', [event(1)]);
    await storage.events.append('line-b', [event(2)]);
    expect(calls).toHaveLength(0);
    await storage.flush();
    // 两个场景各发一次，不能混在一个请求里（sceneId 是查询参数）。
    expect(calls).toHaveLength(2);
  });

  test('发送失败时事件退回缓冲区，下次重试（不能凭空消失）', async () => {
    let attempt = 0;
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/events') && init?.method === 'POST') {
        attempt += 1;
        calls.push({ url, method: 'POST', body: JSON.parse(String(init.body)) });
        if (attempt === 1) return new Response('boom', { status: 500 });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl, batchSize: 8 });

    await storage.events.append('line-a', [event(1)]);
    await expect(storage.flush()).rejects.toThrow(/HTTP 500/);

    // 重试：事件还在，没丢。
    await storage.flush();
    expect(attempt).toBe(2);
    expect(calls[1]?.body).toHaveLength(1);
  });

  test('空数组不发包（省一次往返）', async () => {
    const { calls, storage } = harness();
    expect(await storage.events.append('line-a', [])).toBe(0);
    expect(await storage.state.upsert('line-a', [])).toBe(0);
    expect(await storage.metrics.put([])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('快照：四种取法走同一个 query 接口，用参数区分', async () => {
    const { calls, storage } = harness(() => null);
    await storage.snapshots.latest('line-a');
    await storage.snapshots.atOrBefore('line-a', 12);
    await storage.snapshots.atOrBeforeTime('line-a', 3.5);
    await storage.snapshots.put('line-a', snapshot(1));

    expect(calls.slice(0, 3).map((call) => new URL(call.url).search)).toEqual([
      '?sceneId=line-a',
      '?sceneId=line-a&sequence=12',
      '?sceneId=line-a&time=3.5',
    ]);
    expect(calls[3]?.method).toBe('POST');
  });

  test('会话：保存 / 读取 / 列表 / 结束', async () => {
    const { calls, storage } = harness(() => ({}));
    const session = {
      id: 's1',
      sceneId: 'line-a',
      sceneVersion: 1,
      seed: 7,
      step: 1 / 60,
      mode: 'sim' as const,
      createdAt: 'now',
    };
    await storage.sessions.put(session);
    await storage.sessions.get('s1');
    await storage.sessions.list('line-a');
    await storage.sessions.finish('s1', 42);

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/sessions',
      'GET /api/sessions/s1',
      'GET /api/sessions',
      'POST /api/sessions/s1/finish',
    ]);
    expect(calls[3]?.body).toEqual({ duration: 42 });
  });

  test('状态与指标', async () => {
    const { calls, storage } = harness(() => ({ written: 1 }));
    await storage.state.upsert('line-a', [
      { entityId: 'belt-01', kind: 'transport', attrs: {}, transform: { position: [0, 0, 0] }, dataSource: 'sim', updatedSequence: 1, updatedAt: 0 },
    ]);
    await storage.metrics.put([{ sceneId: 'line-a', metric: 'tick', bucketStart: 0, bucketSize: 1, value: 1, count: 1 }]);
    await storage.metrics.query('line-a', { metric: 'tick', fromBucket: 0, toBucket: 10 });

    expect(calls[0]?.url).toContain('/api/state?sceneId=line-a');
    expect(calls[1]?.url).toBe('http://srv/api/metrics');
    expect(new URL(calls[2]!.url).searchParams.get('metric')).toBe('tick');
  });
});

describe('鉴权头', () => {
  test('配了 token：GET、POST、DELETE 每个请求都带 Authorization；content-type 只在有 body 时带', async () => {
    const { calls, storage } = harness(() => [], { token: 's3cret' });
    await storage.scenes.listScenes();
    await storage.scenes.putScene(contractScene);
    await (storage.scenes as unknown as { remove(id: string): Promise<boolean> }).remove('line-a');

    expect(calls.map((call) => `${call.method} ${call.authorization}`)).toEqual([
      'GET Bearer s3cret',
      'POST Bearer s3cret',
      'DELETE Bearer s3cret',
    ]);
    // GET 不带 content-type：它没有入参，带了只会白白触发一次 preflight。
    expect(calls[0]?.contentType).toBeNull();
    expect(calls[1]?.contentType).toBe('application/json');
    expect(calls[2]?.contentType).toBeNull();
  });

  test('没配 token：一个 authorization 头都不许出现', async () => {
    const { calls, storage } = harness(() => []);
    await storage.scenes.listScenes();
    await storage.scenes.putScene(contractScene);
    expect(calls.map((call) => call.authorization)).toEqual([null, null]);
  });
});

describe('错误摊平', () => {
  test('服务端返回 4xx 时把 error 和 issues 拼成一句话', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ error: '场景校验失败。', issues: [{ path: '$.id', message: '必须是非空字符串。' }] }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });
    await expect(storage.scenes.putScene(contractScene)).rejects.toThrow(/场景校验失败/);
    await expect(storage.scenes.putScene(contractScene)).rejects.toThrow(/\$\.id 必须是非空字符串/);
  });

  test('sequence 不单调（409）直接抛，避免拼出假历史', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: '事件 sequence 必须严格单调：1 <= 1。' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });
    // 攒批后错误发生在 flush 那一刻，而不是 append 时。
    await storage.events.append('line-a', [event(1)]);
    await expect(storage.flush()).rejects.toThrow(/严格单调/);
  });

  /**
   * 409 是**服务端拒收**：这批事件的 sequence 已经被判死，塞回队列重试只会
   * 每 120ms（面板采样间隔）原样再撞一次——控制台就是这样被刷满的。
   */
  test('409 之后写入熔断：同一批事件不会再发第二遍，也不再抛', async () => {
    let posts = 0;
    const conflict = () =>
      new Response(JSON.stringify({ error: '事件 sequence 必须严格单调：1 <= 1。' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    const ok = () => new Response(JSON.stringify({ sequence: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts += 1;
        return conflict();
      }
      return ok();
    }) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });

    await storage.events.append('pond', [event(1)]);
    await expect(storage.flush()).rejects.toThrow(/严格单调/);
    // 接下来发生的才是重点：被拒收后，面板的每一拍都不该再带来一条报错。
    await storage.events.append('pond', [event(2)]);
    await expect(storage.flush()).resolves.toBeUndefined();
    expect(posts).toBe(1);
    // 但也不能装作什么都没发生：原因要能被 UI 摆出来。
    expect(storage.writeErrors().get('pond')).toMatch(/严格单调/);
    expect(storage.dropped).toBe(2);
  });

  test('5xx 是抖动：事件塞回队首，下一次 flush 重试', async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts += 1;
      if (attempts === 1) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ written: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });

    await storage.events.append('pond', [event(1)]);
    await expect(storage.flush()).rejects.toThrow(/500/);
    await expect(storage.flush()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(storage.writeErrors().size).toBe(0);
  });

  test('clearConflict 之后恢复写入（排队解除原因才好用）', async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ error: '事件 sequence 必须严格单调：1 <= 1。' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ sequence: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });

    await storage.events.append('pond', [event(1)]);
    await storage.flush().catch(() => undefined);
    expect(await storage.events.append('pond', [event(2)])).toBe(0); // 熔断中：写不进去

    storage.clearConflict('pond');
    expect(await storage.events.append('pond', [event(2)])).toBe(1); // 恢复：重新入队
    expect(storage.writeErrors().size).toBe(0);
  });

  test('404 的读取返回 null 而不是抛错', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });
    expect(await storage.scenes.getScene('missing')).toBeNull();
  });
});

describe('pingServer', () => {
  test('服务端在且 token 正确 → ok，并带回健康信息', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // token 必须真的发出去，否则线上经 Worker 探活会一直 401。
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer s3cret');
      expect(String(input)).toBe('http://srv/api/health');
      return new Response(JSON.stringify({ ok: true, backend: 'postgres' }));
    }) as typeof fetch;
    try {
      expect(await pingServer('http://srv', { token: 's3cret' })).toEqual({
        status: 'ok',
        health: { ok: true, backend: 'postgres' },
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('服务端在但 token 被拒 → unauthorized（不能当成"服务端不在"）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'API token 无效。' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      expect(await pingServer('http://srv')).toEqual({ status: 'unauthorized', message: 'API token 无效。' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('服务端不在时返回 offline，不抛异常（没起服务是正常状态）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    try {
      expect(await pingServer('http://srv')).toEqual({ status: 'offline' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('没配 token 时请求不带 authorization 头', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      return new Response(JSON.stringify({ ok: true, backend: 'file' }));
    }) as typeof fetch;
    try {
      expect(await pingServer('http://srv')).toEqual({ status: 'ok', health: { ok: true, backend: 'file' } });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('defaultServerUrl', () => {
  const withLocation = (value: Partial<Location> | undefined, run: () => void): void => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, 'location');
    } else {
      Object.defineProperty(globalThis, 'location', { value, configurable: true, writable: true });
    }
    try {
      run();
    } finally {
      if (original) Object.defineProperty(globalThis, 'location', original);
      else Reflect.deleteProperty(globalThis, 'location');
    }
  };

  test('没有 location 时回落到 8787', () => {
    withLocation(undefined, () => expect(defaultServerUrl()).toBe('http://localhost:8787'));
  });

  test('域名走 443（port 为空串）→ 同源 origin，不许拼 :8787', () => {
    withLocation({ port: '', protocol: 'https:', hostname: 'twin.example.com', origin: 'https://twin.example.com' }, () => {
      expect(defaultServerUrl()).toBe('https://twin.example.com');
    });
  });

  test('本地 wrangler dev 跑在 8787 → 同源 origin', () => {
    withLocation({ port: '8787', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:8787' }, () => {
      expect(defaultServerUrl()).toBe('http://localhost:8787');
    });
  });

  test('vite 的 3000 → 跨源回落到同主机的 8787', () => {
    withLocation({ port: '3000', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:3000' }, () => {
      expect(defaultServerUrl()).toBe('http://localhost:8787');
    });
  });
});
