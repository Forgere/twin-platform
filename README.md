# Twin Platform

面向低成本、可插拔数字孪生场景的平台，三个 app + 一组包：

| | |
|---|---|
| `apps/studio` | SolidJS 2 工作台（三维视口 + 回放 + 指标 + 方案对比） |
| `apps/server` | Bun 常驻服务端，路由一律 `/api/*`，同源时顺带托管 Studio 产物 |
| `apps/worker` | Cloudflare Worker：静态资产 + `/api/*` 反代并**注入** token |
| `packages/*` | `world-kernel` / `scene-schema` / `storage-*` / `replay-core` / `analytics-core` / `plugins-*` … |

架构与路线见 [行动计划](./docs/行动计划.md)，数据契约见 [服务端与持久化](./docs/服务端与持久化.md)，上云方案见 [云端部署](./docs/云端部署.md)，场景 JSON 见 [场景文件格式](./docs/场景文件格式.md)。

## 命令

用 Bun 管理依赖和执行命令：

| 命令 | 作用 |
|---|---|
| `bun install` | 装依赖（**在 WSL 里执行**，会重建 workspace 软链） |
| `bun run dev` | Studio 开发服务器 → `http://localhost:3000` |
| `bun run dev:server` | 服务端 → `:8787`（默认 file 后端，零外部依赖） |
| `bun run dev:worker` | `wrangler dev` → `:8787`（上游读 `apps/worker/.dev.vars`） |
| `bun run build` | 构建静态产物到 `apps/studio/dist/client` |
| `bun run test` | `bun test packages apps/server apps/worker`（包与服务端单测） |
| `bun run typecheck` | Studio + 全部包 + server / worker |

Studio 的组件测试走 vitest：`cd apps/studio && bun x vitest run`。

---

## 本地开发要配什么

### 1. 零配置起步（最常用）

```bash
bun install
bun run dev:server     # 终端 1：:8787，file 后端，不装数据库就能跑
bun run dev            # 终端 2：:3000
```

**不需要配任何变量。** Studio 的 dev 服务器自带 `/api` 代理（`apps/studio/vite.config.ts`），
把同源 `/api` 反代到 `127.0.0.1:8787`，并像线上 Worker 一样注入 `Authorization`。
所以浏览器**只认同源 `/api`**——dev 与部署是同一条拓扑，不靠 CORS、不靠跨源回退，
"本地看着对、上线不对"这类分叉也就不存在了。

> 服务端不在 8787 时（比如本地把 8787 让给 Worker、server 挪到 8799），
> 用 `TWIN_SERVER_ORIGIN=http://127.0.0.1:8799 bun run dev` 改代理上游。

### 2. Studio 怎么决定"连不连服务端"

启动时探一次 `GET /api/health`（`TwinViewport.tsx`），三种结果：

| 探测结果 | 行为 |
|---|---|
| `200` | 换成 HTTP 仓储：场景 / 事件 / 快照落服务端，刷新不丢 |
| `401` / `403` | **不静默降级**——场景面板明写"鉴权失败"，避免你以为存下来了其实全丢 |
| 探不到 / 非 2xx | 纯静态兜底：保持内存仓储，场景面板提示"未连接服务端（纯静态模式）：场景能导入导出，但刷新即丢" |

### 3. dev 环境变量

**Studio / vite 侧**（`apps/studio/vite.config.ts`、`import.meta.env`）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `TWIN_SERVER_ORIGIN` | dev 代理的上游 | `http://127.0.0.1:8787` |
| `TWIN_API_TOKEN` | dev 代理注入 `Bearer`（**服务端进程的 env，不是 `VITE_*`**），用于联调鉴权 | 空 = 不注入 |
| `VITE_TWIN_SERVER` | 覆盖服务端地址（跨源直连联调才用） | dev 走同源；生产走 `defaultServerUrl()` |
| `VITE_TWIN_API_TOKEN` | 浏览器直带 `Bearer`。**一般别用**——token 进了 bundle 就等于公开，线上一律由 Worker 注入 | 空 |

**服务端**（`apps/server`）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `8787` |
| `TWIN_STORAGE` | `file` \| `postgres`，后端开关 | 见下方选择逻辑 |
| `DATABASE_URL` | PG 连接串；**设了它就等于选 postgres**，也支持 `pglite://memory` | 空 |
| `TWIN_PG_SCHEMA` | 表前缀 schema | `public` |
| `TWIN_DATA` | file 后端的数据文件路径 | `data/twin.json` |
| `TWIN_API_TOKEN` | 非空则 `/api/*`（含 health）全部要求 `Bearer` | 空 = **不启用鉴权**（仅限内网/本地） |
| `TWIN_STUDIO_DIST` | 同源托管的静态产物目录 | `apps/studio/dist` |

后端选择逻辑（`apps/server/src/storage.ts`）：

- `TWIN_STORAGE=postgres`，**或**设了 `DATABASE_URL` → PostgreSQL，**启动时自动跑 `migrations/*.sql`**（幂等 + `_twin_migrations` 台账），不用手工 `psql`；
- 否则 → file 后端，落 `data/twin.json`（该目录已 gitignore）。

本地想验 PG 又没数据库：`cd apps/server && bun run smoke:postgres`（默认 `pglite://memory`）。

### 4. 可选：本地跑通 Worker 形态（与生产完全一致）

端口约定：**8787 留给 Worker**，server 挪到 8799。

```bash
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # UPSTREAM=http://127.0.0.1:8799, API_TOKEN=dev-token
PORT=8799 TWIN_API_TOKEN=dev-token bun run dev:server    # 终端 1
bun run dev:worker                                        # 终端 2：:8787
```

此时页面 origin 就是 `localhost:8787`，同源 `/api` 经 Worker 转发、token 由 Worker 注入，
浏览器全程不知道 token——和线上一模一样。

---

## 部署要配什么

两条路线二选一，**生产一律用 postgres 后端**（file 后端在容器里是临时存储）。

### 路线 A：Cloudflare Worker（静态资产 + 边缘反代）

```bash
bun run build                                   # 产出 apps/studio/dist/client（wrangler.jsonc 已指向）
cd apps/worker
wrangler secret put UPSTREAM                    # 服务端公网 URL，例如 https://twin-api.example.com
wrangler secret put API_TOKEN                   # 必须与服务端 TWIN_API_TOKEN 一致，否则上游全 401
bun run deploy                                  # 或回根目录 bun run --filter @twin-platform/worker deploy
```

- 两个值走 **secret**，故意不写进 `wrangler.jsonc`（写进配置的 `vars` 会被提交并随每次部署覆盖线上值）。
- token 只存在 Worker 与服务端，**不进前端 bundle**；Worker 先删掉客户端带来的 `authorization` 再盖上自己的。
- 静态资产目录、SPA 回退由 `apps/worker/wrangler.jsonc` 的 `assets` 段配置。
- 国内注意：`workers.dev` 被 DNS 污染，需绑自定义域名（详见 [云端部署 §4](./docs/云端部署.md)）。

### 路线 B：Docker Compose（服务端 + 托管 PostgreSQL）

```bash
cp deploy/.env.example deploy/.env              # 填 DATABASE_URL / TWIN_API_TOKEN
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

`deploy/.env` 里的关键项：

| 变量 | 作用 |
|---|---|
| `SERVER_PORT` | 宿主机映射端口（容器内固定 8787） |
| `DATABASE_URL` | 托管 PostgreSQL 连接串（RDS / TencentDB / PolarDB…） |
| `TWIN_PG_SCHEMA` | 表前缀，默认 `twin` |
| `TWIN_API_TOKEN` | 共享 token；**必须与边缘的 `API_TOKEN` 一致** |

要让服务端同源托管前端（不走 Worker），先 `bun run build`，再在 compose 的 `server.environment`
里打开 `TWIN_STUDIO_DIST: apps/studio/dist`。compose 的 healthcheck 已经带 `Bearer` 探活。

### 部署后验证

```bash
# 1) 服务端活着且后端正确（backend 应为 postgres）
curl -H "Authorization: Bearer $TWIN_API_TOKEN" https://你的域名/api/health
# => {"ok":true,"backend":"postgres"}

# 2) 鉴权真的开着：不带 token 应当 401
curl -o /dev/null -w '%{http_code}\n' https://你的域名/api/health   # => 401

# 3) 前端连上了服务端：场景面板出现"服务端"场景列表，
#    按 F5 刷新后场景/事件还在（不是"纯静态模式"提示）
```

### 上线前必查

- [ ] `TWIN_STORAGE=postgres`（或设了 `DATABASE_URL`），别把 `data/twin.json` 当生产存储
- [ ] `TWIN_API_TOKEN` 已设且与边缘 `API_TOKEN` 一致——**空值 = `/api/*` 全开**
- [ ] 公网走 HTTPS；`DATABASE_URL` 优先用内网地址
- [ ] 密钥只进 Secret / `deploy/.env`（均已 gitignore），绝不提交
- [ ] 迁移已自动跑过（启动日志 / `_twin_migrations` 表）

数据库选型、探活、连接池、水平扩展、备份见 [云端部署](./docs/云端部署.md)。

---

## 脚手架说明

`bare` plus the app floors most projects want: `@solidjs/router` with file-system routes, per-page titles via `@solidjs/meta`, and a `vitest` test suite.

**Deployment contract:** `vite build` still emits a purely static site — deploy `apps/studio/dist/client` to any static host and it runs (scenes live in memory, refreshed away). Persisting anything requires the server side documented above; the Studio detects it at startup and upgrades itself from memory storage to HTTP storage.

## How it works

There is no `index.html` and no mount file. `@solidjs/vite-plugin`'s turnkey mode (`start: true` in `vite.config.ts`) generates the entries around two conventions:

- **`src/App.tsx`** — the app, router included. The `<Router>` wraps a shared nav and a `<Loading>` boundary; its routes come from the file system (below).
- **`src/Document.tsx`** — the document shell, the new `index.html`. Site-wide head tags go here; it is compiled only into the prerendered static shell and adds **zero client-side JS**. Per-page head tags (`<Title>` from `@solidjs/meta`) live in the route modules.

## File-system routing

The `fileRoutes()` plugin (from `filesystem-routing/vite`) scans `src/routes` and exposes the result as the `virtual:file-routes` module, which `@solidjs/router/fs` turns into router routes inside `src/App.tsx`. You edit files under `src/routes`; the route table follows:

- `index.tsx` is `/`, `users/[id].tsx` is `/users/:id`, `[...404].tsx` catches everything else.
- Pairing `users.tsx` with the `users/` directory makes it a layout wrapping every page inside.
- A module is a page when it has a **default export** (a file without one is not a route), and may export a `route` config object — `src/routes/users/[id].tsx` uses `preload` to start its data fetch as navigation begins.

Every route is code-split automatically; navigating loads only that page's module.

## Data loading

`src/routes/users/[id].tsx` shows the data pattern: a `query()` (from `@solidjs/router`) over a plain `fetch`, read through a memo. The surrounding `<Loading>` boundary in `App.tsx` shows its fallback until the promise settles, and `query()` caches by key so preload and render share one request. Swap the static `/users.json` for any API endpoint.

## Testing

`vitest` runs component tests in jsdom via `@solidjs/testing-library` — add `*.test.tsx` files next to what they test. See `src/components/Counter.test.tsx` for the pattern; note Solid 2.0 batches DOM updates, so tests call `flush()` after firing events before asserting on the DOM.

## Usage

Dependencies are managed by Bun. The lockfile is `bun.lock`.

### Learn more on the [Solid Website](https://solidjs.com) and come chat with us on our [Discord](https://discord.com/invite/solidjs)

## Available Scripts

In the project directory, you can run:

### `npm run dev` or `npm start`

Runs the app in the development mode.<br>
Open [http://localhost:3000](http://localhost:3000) to view it in the browser.

The page will reload if you make edits.<br>

### `npm run build`

Builds the static production site to `dist/client`, routes code-split.

### `npm run serve`

Serves the production build locally.

### `npm test`

Runs the test suite.

## The `ssr` flip

Streaming SSR is one boolean: add `ssr: true` next to `start: true` in `vite.config.ts`. `src/App.tsx`, `src/Document.tsx`, and the routes carry over unchanged — `<HydrationScript />` is already in place in the Document (in client mode it is stripped from the static shell).

## Growing out of `basic`

- **A server** (data loading via server functions, mutations, sessions, API routes) is the `fullstack` template — same structure, more floors.
- Want less? The `bare` template is the same shape without the router.

## This project was created with the [Solid CLI](https://github.com/solidjs-community/solid-cli)
