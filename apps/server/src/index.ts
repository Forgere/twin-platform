import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSceneDocument, type TwinScene } from '@twin-platform/scene-schema';
import { authorizeApi, readApiToken } from './auth';
import { createServerStorage, removeScene, type ServerStorage } from './storage';
import { handleJevDecide, jevStatus } from './jev';

/**
 * Twin Platform 服务端。
 *
 * **为什么必须有它**：Studio 目前是纯静态站，`storage-postgres` 和任何长连接协议
 * 在浏览器里都无从落地；场景导入靠 File API，刷新即丢。有了服务端，场景才真的
 * 有"存下来"这回事，接 MQTT / OPC-UA 也才有个能常驻的进程。
 *
 * 默认零外部依赖：数据落在单个 JSON 文件（`storage-file`），不装数据库就能跑。
 * 设置 `TWIN_STORAGE=postgres`（或 `DATABASE_URL`）即切换到 PostgreSQL——
 * 服务端只通过 `createServerStorage` 这一个工厂选后端，路由代码完全无感，
 * 连接、迁移、驱动选择都收在 `storage-postgres` 里。
 *
 * 路由一律 `/api/*`，与前端同源部署时由本进程一并托管 `apps/studio/dist`。
 */

const PORT = Number(process.env.PORT ?? 8787);
const DATA_PATH = resolve(process.env.TWIN_DATA ?? 'data/twin.json');
const STUDIO_DIST = resolve(process.env.TWIN_STUDIO_DIST ?? 'apps/studio/dist');
// 空 = 不启用鉴权（本地零配置照常跑）；有值 = /api/* 一条都不放行。
// 语义与不变量见 ./auth.ts。生产由 apps/worker 的 secret 注入，不进前端。
const API_TOKEN = readApiToken(process.env);

const serverStorage = await createServerStorage({ dataPath: DATA_PATH });
const storage = serverStorage.storage;

const CORS_HEADERS: Record<string, string> = {
  // 开发时 Studio 跑在 vite 的另一个端口上，必须放行。
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  // 不写 authorization，跨源带 token 的请求会被浏览器 preflight 挡死。
  'access-control-allow-headers': 'content-type,authorization',
};

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status, headers: CORS_HEADERS });

const fail = (message: string, status = 400): Response => json({ error: message }, status);

const num = (value: string | null): number | undefined => {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const requireSceneId = (url: URL): string | undefined => url.searchParams.get('sceneId') ?? undefined;

/** `/api` 与 `/api/...` 都算接口；与 apps/worker 的 isApiPath 保持同一套判断。 */
function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

async function readJson<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 预检必须先于鉴权：OPTIONS 不带 Authorization 是浏览器的既定行为。
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    // -------------------------------------------------------------------------
    // 鉴权：/api/* 全部（含 health）在路由之前过这一道。
    // token 是共享的 → 经 Worker 注入后"每个访客都已鉴权"，所以不留任何免检面。
    // -------------------------------------------------------------------------
    if (isApiPath(path)) {
      const decision = authorizeApi(request.headers.get('authorization'), API_TOKEN);
      if (!decision.ok) return json({ error: decision.message }, decision.status ?? 401);
    }

    // -------------------------------------------------------------------------
    // 健康检查：前端靠它判断"服务端在不在 + 认不认这个 token"，决定要不要启用
    // 服务端存储。字段只回 ok/backend——dataPath、连接串、场景数都是访客不该看见的。
    // -------------------------------------------------------------------------
    if (path === '/api/health') {
      return json({ ok: true, backend: serverStorage.backend });
    }

    // -------------------------------------------------------------------------
    // 场景
    // -------------------------------------------------------------------------
    if (path === '/api/scenes' && request.method === 'GET') {
      return json(await storage.scenes.listScenes());
    }

    if (path === '/api/scenes' && request.method === 'POST') {
      const scene = (await readJson<TwinScene>(request)) ?? undefined;
      if (!scene) return fail('请求体必须是场景 JSON。');
      // 服务端是外部数据的入口，这里**必须**重新校验：
      // 前端已经校验过不代表别人也会，脏场景进库会污染后续所有回放。
      const parsed = parseSceneDocument(JSON.stringify(scene));
      if (!parsed.ok || !parsed.scene) {
        return json({ error: '场景校验失败。', issues: parsed.issues }, 422);
      }
      return json(await storage.scenes.putScene(parsed.scene));
    }

    const sceneMatch = path.match(/^\/api\/scenes\/([\w.-]+)$/);
    if (sceneMatch) {
      const id = decodeURIComponent(sceneMatch[1]!);
      if (request.method === 'GET') {
        const scene = await storage.scenes.getScene(id);
        return scene ? json(scene) : fail('场景不存在。', 404);
      }
      if (request.method === 'DELETE') {
        const removed = await removeScene(serverStorage.storage, id);
        return removed ? json({ removed: true }) : fail('场景不存在。', 404);
      }
    }

    // -------------------------------------------------------------------------
    // 事件
    // -------------------------------------------------------------------------
    if (path === '/api/events' && request.method === 'GET') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      const events = await storage.events.query(sceneId, {
        sinceSequence: num(url.searchParams.get('since')),
        untilSequence: num(url.searchParams.get('until')),
        entityId: url.searchParams.get('entityId') ?? undefined,
        type: url.searchParams.get('type') ?? undefined,
        limit: num(url.searchParams.get('limit')),
      });
      return json(events);
    }

    if (path === '/api/events' && request.method === 'POST') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      const events = (await readJson<Parameters<typeof storage.events.append>[1]>(request)) ?? undefined;
      if (!Array.isArray(events)) return fail('请求体必须是事件数组。');
      try {
        return json({ written: await storage.events.append(sceneId, events) });
      } catch (error) {
        // sequence 不单调是调用方重复回放的信号，必须 409 让它停下来，
        // 而不是静默吞掉造成"回放出来的历史是两条时间线拼接的假历史"。
        return fail(error instanceof Error ? error.message : String(error), 409);
      }
    }

    if (path === '/api/events/latest' && request.method === 'GET') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      return json({ sequence: await storage.events.latestSequence(sceneId) });
    }

    if (path === '/api/events/truncate' && request.method === 'POST') {
      const sceneId = requireSceneId(url);
      const sequence = num(url.searchParams.get('sequence'));
      if (!sceneId || sequence === undefined) return fail('缺少 sceneId 或 sequence。');
      return json({ removed: await storage.events.truncateAfter(sceneId, sequence) });
    }

    // -------------------------------------------------------------------------
    // 快照
    // -------------------------------------------------------------------------
    if (path === '/api/snapshots' && request.method === 'POST') {
      const sceneId = requireSceneId(url);
      const snapshot = (await readJson<Parameters<typeof storage.snapshots.put>[1]>(request)) ?? undefined;
      if (!sceneId || !snapshot) return fail('缺少 sceneId 或快照。');
      await storage.snapshots.put(sceneId, snapshot);
      return json({ ok: true });
    }

    if (path === '/api/snapshots/query' && request.method === 'GET') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      const sequence = num(url.searchParams.get('sequence'));
      const time = num(url.searchParams.get('time'));
      const snapshot =
        sequence !== undefined
          ? await storage.snapshots.atOrBefore(sceneId, sequence)
          : time !== undefined
            ? await storage.snapshots.atOrBeforeTime(sceneId, time)
            : await storage.snapshots.latest(sceneId);
      return json(snapshot);
    }

    // -------------------------------------------------------------------------
    // 回放会话
    // -------------------------------------------------------------------------
    if (path === '/api/sessions' && request.method === 'POST') {
      const session = (await readJson<Parameters<typeof storage.sessions.put>[0]>(request)) ?? undefined;
      if (!session?.id) return fail('会话缺少 id。');
      await storage.sessions.put(session);
      return json({ ok: true });
    }

    if (path === '/api/sessions' && request.method === 'GET') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      return json(await storage.sessions.list(sceneId));
    }

    const sessionMatch = path.match(/^\/api\/sessions\/([\w.-]+)(?:\/(finish))?$/);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!);
      if (sessionMatch[2] === 'finish' && request.method === 'POST') {
        const body = (await readJson<{ duration?: number }>(request)) ?? {};
        try {
          await storage.sessions.finish(id, body.duration ?? 0);
          return json({ ok: true });
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error), 404);
        }
      }
      if (request.method === 'GET') {
        const session = await storage.sessions.get(id);
        return session ? json(session) : fail('会话不存在。', 404);
      }
    }

    // -------------------------------------------------------------------------
    // 状态投影 / 指标
    // -------------------------------------------------------------------------
    if (path === '/api/state' && request.method === 'POST') {
      const sceneId = requireSceneId(url);
      const records = (await readJson<Parameters<typeof storage.state.upsert>[1]>(request)) ?? undefined;
      if (!sceneId || !Array.isArray(records)) return fail('缺少 sceneId 或状态数组。');
      return json({ written: await storage.state.upsert(sceneId, records) });
    }

    if (path === '/api/state' && request.method === 'GET') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      return json(await storage.state.list(sceneId));
    }

    if (path === '/api/metrics' && request.method === 'POST') {
      const rollups = (await readJson<Parameters<typeof storage.metrics.put>[0]>(request)) ?? undefined;
      if (!Array.isArray(rollups)) return fail('请求体必须是指标数组。');
      return json({ written: await storage.metrics.put(rollups) });
    }

    if (path === '/api/metrics' && request.method === 'GET') {
      const sceneId = requireSceneId(url);
      if (!sceneId) return fail('缺少 sceneId。');
      return json(
        await storage.metrics.query(sceneId, {
          metric: url.searchParams.get('metric') ?? undefined,
          entityId: url.searchParams.get('entityId') ?? undefined,
          fromBucket: num(url.searchParams.get('from')),
          toBucket: num(url.searchParams.get('to')),
        }),
      );
    }

    // -------------------------------------------------------------------------
    // Jev 判断：密钥只在服务端。前端打同源 /api/jev/*，与 TWIN_API_TOKEN 同思路。
    // -------------------------------------------------------------------------
    if (path === '/api/jev/status' && request.method === 'GET') {
      const result = jevStatus({ env: process.env });
      return json(result.body, result.status);
    }

    if (path === '/api/jev/decide' && request.method === 'POST') {
      const payload = await readJson<unknown>(request);
      if (payload === undefined) return fail('请求体必须是 JSON。');
      const result = await handleJevDecide(payload, { env: process.env });
      return json(result.body, result.status);
    }

    if (path.startsWith('/api/')) return fail('未知接口。', 404);

    // -------------------------------------------------------------------------
    // 静态资源：同源托管 Studio 构建产物（没构建过就跳过）
    // -------------------------------------------------------------------------
    if (existsSync(STUDIO_DIST)) {
      const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
      const file = Bun.file(join(STUDIO_DIST, relative));
      if (await file.exists()) return new Response(file);
      // SPA 回退：非 API 路径一律给 index.html，交给前端路由。
      const index = Bun.file(join(STUDIO_DIST, 'index.html'));
      if (await index.exists()) return new Response(index);
    } else if (path === '/') {
      return new Response(
        'Studio 尚未构建（apps/studio/dist 不存在）。开发模式请直接访问 vite 端口；同源托管请先 `bun run build`。',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }

    return fail('未找到。', 404);
  },
});

console.log(`[twin-server] http://localhost:${server.port}`);
console.log(`[twin-server] 存储后端：${serverStorage.backend}`, serverStorage.detail);
console.log(
  API_TOKEN
    ? '[twin-server] 鉴权：已启用（/api/* 需要 Authorization: Bearer <TWIN_API_TOKEN>）'
    : '[twin-server] 鉴权：未启用（TWIN_API_TOKEN 未设置）——公网部署前必须设置',
);
console.log(
  existsSync(STUDIO_DIST)
    ? `[twin-server] 静态托管：${STUDIO_DIST}`
    : '[twin-server] 未找到 Studio 构建产物，只提供 API（开发模式跑 vite 即可）',
);

const shutdown = async () => {
  // 文件后端退出前必须 flush（落盘窗口里可能还有未写入的改动）；postgres 端点连接释放。
  await serverStorage.close();
  console.log('\n[twin-server] 已关闭存储，退出。');
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
