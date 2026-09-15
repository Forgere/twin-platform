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
}

function harness(respond: (url: string) => unknown = () => ({}), options: { batchSize?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const body = respond(url);
    return new Response(JSON.stringify(body ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
    storage: createHttpStorage({ baseUrl: 'http://srv', fetchImpl, batchSize: options.batchSize ?? 64 }),
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

  test('404 的读取返回 null 而不是抛错', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    const storage = createHttpStorage({ baseUrl: 'http://srv', fetchImpl });
    expect(await storage.scenes.getScene('missing')).toBeNull();
  });
});

describe('pingServer', () => {
  test('服务端在时返回健康信息', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, backend: 'file', dataPath: '/x', scenes: 3 }))) as typeof fetch;
    try {
      expect(await pingServer('http://srv')).toEqual({ ok: true, backend: 'file', dataPath: '/x', scenes: 3 });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('服务端不在时返回 null，不抛异常（没起服务是正常状态）', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    try {
      expect(await pingServer('http://srv')).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('defaultServerUrl', () => {
  test('没有 location 时回落到 8787', () => {
    expect(defaultServerUrl()).toBe('http://localhost:8787');
  });
});
