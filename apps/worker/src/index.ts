/**
 * Cloudflare Worker：同源入口 = 静态资源 + `/api/*` 反代。
 *
 * 为什么需要它（而不是让浏览器直接打 apps/server）：
 * 1. **token 保密**。共享 API token 若编译进前端就对所有访客可见。这里反过来——
 *    浏览器只请求同源 `/api/*`，Worker 用服务端 secret 拼上 `Authorization` 再转发，
 *    前端从头到尾不知道 token 是什么。
 * 2. **顺带解决同源与 CORS**：静态资源与 API 同域，前端 `defaultServerUrl()`
 *    推断出的就是 origin，不需要跨源，也就没有 preflight。
 *
 * 依赖的上游是 `apps/server`（Bun 进程）。**线上 Worker 访问不到你的 localhost**，
 * 只有本机 `wrangler dev` 可以——所以本地联调时上游填 `http://127.0.0.1:8799`，
 * 真要上线得先把 server 放到公网可达的地址，再 `wrangler secret put UPSTREAM`。
 */

/** 静态资产绑定（wrangler `assets.binding`）。 */
interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerEnv {
  ASSETS: AssetFetcher;
  /** 上游服务端根地址（只认 origin，不带路径），例如 `http://127.0.0.1:8799`。 */
  UPSTREAM?: string;
  /** 注入的共享 Bearer token，必须与服务端 `TWIN_API_TOKEN` 一致；为空则不注入。 */
  API_TOKEN?: string;
  /**
   * 单场景静态部署（`bun run deploy:scene`）：设为 `1` 时 `/api/*` 一律 404，
   * 其余路径只发静态资产。没有 UPSTREAM 可配，也不再回 502「未配置上游」——
   * 这份站点根本没有服务端，页面启动时也不探测它（见 studio 的 staticScene.ts）。
   */
  STATIC_ONLY?: string;
}

export function isStaticOnly(env: Pick<WorkerEnv, 'STATIC_ONLY'>): boolean {
  return env.STATIC_ONLY === '1' || env.STATIC_ONLY === 'true';
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** 只有 `/api` 与 `/api/...` 走反代，其余交给静态资产。 */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** 拼上游地址：上游只认 origin，pathname/search 原样带过去。 */
export function upstreamUrl(request: Request, upstream: string): string {
  const url = new URL(request.url);
  const base = new URL(upstream);
  base.pathname = url.pathname;
  base.search = url.search;
  return base.toString();
}

export async function proxyApi(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (!env.UPSTREAM) return json({ error: '未配置上游 UPSTREAM。' }, 502);

  // 客户端带什么 Authorization 都不认：token 的唯一来源是 Worker 的 secret。
  // 否则"猜中 token 直连"和"猜不中"在上游看来没区别，等于给猜密留了观测面。
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  if (env.API_TOKEN) headers.set('authorization', `Bearer ${env.API_TOKEN}`);

  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers, redirect: 'manual' };
  // GET/HEAD 带 body 会被 fetch 直接拒绝，只有写方法才透传。
  if (method !== 'GET' && method !== 'HEAD') init.body = request.body;

  try {
    return await fetchImpl(upstreamUrl(request, env.UPSTREAM), init);
  } catch {
    return json({ error: '上游服务端不可达。' }, 502);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) {
      if (isStaticOnly(env)) return json({ error: '单场景静态部署：无服务端。' }, 404);
      return proxyApi(request, env);
    }
    // 非 API 路径（含 404）交给资产：wrangler.jsonc 里
    // `not_found_handling: single-page-application` 负责 SPA 回退到 index.html。
    return env.ASSETS.fetch(request);
  },
};
