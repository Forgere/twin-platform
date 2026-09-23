import { defaultServerUrl } from '@twin-platform/storage-http';

/**
 * 服务端地址解析（唯一真相，别再各写一份）。
 *
 * - 线上：同源（经 Cloudflare Worker 反代并注入 token），前端不需要知道地址；
 * - dev：也走同源 —— vite.config.ts 的 /api 代理反代到 :8787 并注入 token，
 *   于是 dev 与部署是同一条拓扑，不会出现"本地看着对、上线不对"；
 * - 本地跨源联调才用 VITE_TWIN_SERVER 覆盖。
 */
export function resolveServerUrl(): string {
  return import.meta.env.VITE_TWIN_SERVER || (import.meta.env.DEV ? location.origin : defaultServerUrl());
}
