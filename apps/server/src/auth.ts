/**
 * API 鉴权：共享 Bearer token。
 *
 * 为什么是"共享" token：服务端目前没有用户体系，这里能挡住的是"匿名公网访问"
 * 这件事本身。token 来自 `TWIN_API_TOKEN`，**不能编译进前端**——生产形态是
 * Cloudflare Worker 反代时注入（见 `apps/worker`），浏览器根本不知道 token 是什么；
 * 只有本地跨源联调才用 `VITE_TWIN_API_TOKEN` 前端自己带上。
 *
 * 两条不变量：
 * 1. `TWIN_API_TOKEN` 未设置 = **不启用鉴权**（本地 / 内网零配置照常跑，不破坏现有流程）。
 * 2. 一旦设置就一条都不放行，包括 `/api/health`。因为 token 是共享的，等于
 *    "所有访客都已鉴权"——留任何未鉴权面都会把后端元信息（存储后端、场景数）
 *    暴露给每一个访客。公网保活探针走 Worker 注入后的同一路径，不需要单独开口子。
 */

export interface ApiAuthDecision {
  ok: boolean;
  /** 失败时的 HTTP 状态码（永远是 401）。 */
  status?: 401;
  /** 给调用方读的一句话。 */
  message?: string;
}

/**
 * 读 token：**空白 = 未启用**。
 *
 * 空串或纯空白一律视为"没配"，而不是"配了个空 token"——后者会让服务端
 * 接受空 Bearer，等于没开还给人开了的错觉。
 *
 * 参数类型用 `Record<string, string | undefined>` 而不是 `{ TWIN_API_TOKEN?: ... }`：
 * 后者会让 `process.env`（弱类型）触发 TS 的 "no properties in common" 报错。
 */
export function readApiToken(env: Record<string, string | undefined>): string | null {
  const raw = env.TWIN_API_TOKEN;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 校验 `Authorization` 头。
 *
 * 比较走恒定时间：token 会经由 HTTP 头逐字节上网络，用 `===` 逐位短路会给
 * 远程时序侧信道留口子。这里对长度差和内容差合并成一次累积 XOR。
 */
export function authorizeApi(authorization: string | null, expected: string | null): ApiAuthDecision {
  if (expected === null) return { ok: true };

  if (authorization === null || authorization.trim() === '') {
    return { ok: false, status: 401, message: '缺少 Authorization：需要 Bearer <token>。' };
  }

  const match = /^bearer[ \t]+(.*)$/i.exec(authorization.trim());
  const presented = match?.[1]?.trim() ?? '';
  if (presented === '') {
    return { ok: false, status: 401, message: 'Authorization 必须是 Bearer <token> 形式。' };
  }

  if (!constantTimeEquals(presented, expected)) {
    return { ok: false, status: 401, message: 'API token 无效。' };
  }
  return { ok: true };
}

/** 恒定时间的字符串比较：长度不等也算一次完整遍历，不按位短路。 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  // 长度差并进同一个累加器：不单独 return，避免"长度对了才继续比"的时序差。
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
