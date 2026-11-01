# Twin Platform

可验证仿真场景的基础设施：参考运行时 + 两套跨领域参考实现 + 多个外部 adapter + 一条验证链 CLI。

## 开源定位

Twin Platform 的长期目标是成为**可验证仿真场景（Verifiable Simulation Scenes）的基础设施**——
让数字孪生与仿真场景像代码一样**可测试、可回放、可审计、可进 CI**（类比 Playwright for simulation scenes）。

当前仓库已包含参考运行时 `world-kernel`、版本化场景格式 `scene-schema`、插件契约 `plugin-sdk`，
以及两套跨领域参考实现：**物流工厂插件**（证明工业不变量）与**钓鱼场景插件**（证明随机行为也能被验证）。
外部 runtime adapter 进一步证明同一套验证链不只服务内核：`adapters/simpy` 既跑内置离散事件模型，也能经静态预检与受限沙箱执行任意 SimPy 模型文件，`adapters/fmu` 用 ctypes 真加载 FMI 2.0 Co-Simulation FMU 二进制，`adapters/openscenario` 导入 ASAM OpenSCENARIO 1.x 场景 XML 的显式子集；三者都产出同一套 trace，并接受公共审计、差分与 CI 门禁；`adapters/introspector` 再提供不执行外部代码的通用 introspection，自动抽取模型事实并生成可运行场景草案；`adapters/opendrive` 负责 OpenDRIVE 路网求解，把 `LanePosition` 真解算成世界坐标并支持车道级跨道路换路；`examples/packages/` 给出 scene package 目录约定，`packages/plugin-conformance` 提供插件自检套件；[贡献指南](./CONTRIBUTING.md) 给出写规则 / 场景 / adapter / 插件的门槛，`examples/community/mini-line/` 演示外部贡献场景包。
战略与落地路线见 [开源方向与行动计划](./docs/开源方向与行动计划.md)，公共 trace / run / audit / replay / diff / report 接口见 [可验证场景公共层](./docs/可验证场景.md)。

## 5 分钟上手

不装数据库、不开浏览器，从克隆一直跑到一份 HTML 审计报告：

```bash
git clone https://github.com/Forgere/twin-platform.git && cd twin-platform
bun install

# 跑一个工厂场景：智能物流中心（产出 → 打包 → 入库 → 出库 → 卡车运走）
bun run scene run \
  --scene examples/packages/logistics-center/scene.json \
  --plugin logistics --seed 7 --seconds 300 \
  --out .scene-ci/logistics-center

open .scene-ci/logistics-center/report.html   # Linux 用 xdg-open
```

`scene run` 用固定步长跑完整段仿真，执行 2 条运行时不变式（全链路 + 物料守恒），
产出 `trace.json`（可回放 / 可 diff）、`report.json` 与 `report.html`。把它和黄金基线比对，分歧即退出 1：

```bash
bun run scene replay \
  --scene examples/packages/logistics-center/scene.json \
  --plugin logistics --seed 7 --seconds 300 \
  --baseline examples/packages/logistics-center/expected/trace.json
```

同一套验证链跨语言：`adapters/simpy` 用真实 Python 产出同一份 trace，`bun run scene verify` 用 TypeScript 重算其哈希。
最小基线在 `examples/packages/hello`，外部贡献示例在 `examples/community/mini-line`，
场景包目录约定见 [`examples/packages/README.md`](./examples/packages/README.md)，公共接口见 [可验证场景公共层](./docs/可验证场景.md)。

## 在线演示

<https://twin-scene.forgere123zw.workers.dev> 跑的是 **Studio 展示层**：单场景静态托管（`scene.json` + 前端资产，不接 `/api`），
用来在浏览器里看场景、播放回放。它不跑验证链——要验证，用上面的 `bun run scene`。

## 仓库结构

| | |
|---|---|
| `apps/studio` | SolidJS 2 工作台（三维视口 + 回放 + 指标 + 方案对比） |
| `apps/server` | Bun 常驻服务端，路由一律 `/api/*`，同源时顺带托管 Studio 产物 |
| `apps/worker` | Cloudflare Worker：静态资产 + `/api/*` 反代并**注入** token |
| `packages/*` | `world-kernel` / `scene-schema` / `storage-*` / `replay-core` / `analytics-core` / `plugins-*` … |

架构与路线见 [行动计划](./docs/行动计划.md) 与 [开源方向与行动计划](./docs/开源方向与行动计划.md)，贡献规则见 [贡献指南](./CONTRIBUTING.md)。

## 命令

用 Bun 管理依赖和执行命令：

| 命令 | 作用 |
|---|---|
| `bun install` | 装依赖（**在 WSL 里执行**，会重建 workspace 软链） |
| `bun run dev` | Studio 开发服务器 → `http://localhost:3000` |
| `bun run dev:server` | 服务端 → `:8787`（默认 file 后端，零外部依赖） |
| `bun run dev:worker` | `wrangler dev` → `:8787`（上游读 `apps/worker/.dev.vars`） |
| `bun run dev:scene` | 单场景开发 → `:3000`（不开服务端；`VITE_SCENE_URL` 指定场景） |
| `bun run deploy:scene` | 构建单场景静态站点（`-- scene.json --plugin logistics`），配 `wrangler deploy --env scene` 上 Cloudflare |
| `bun run build` | 构建静态产物到 `apps/studio/dist/client` |
| `bun run test` | `bun test packages apps/server apps/worker`（包与服务端单测） |
| `bun run typecheck` | Studio + 全部包 + server / worker |
| `bun run scene run/audit/replay/diff/report` | 场景验证 CLI（上手见上方 5 分钟；接口见 [可验证场景公共层](./docs/可验证场景.md)） |
| `bun run scene package <dir>` | 校验 scene package 目录契约（不跑仿真） |
| `bun run scene:build` | 把 CLI 打成单文件 `packages/scene-cli/bin/scene.mjs`；`npm pack` 后可 `npm i` 进任意目录，`node bin/scene.mjs` 即用 |

Studio 的组件测试走 vitest：`cd apps/studio && bun x vitest run`。

---

## 本地开发（平台 app，可选）

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

### 1b. 只看一个场景（不开服务端）

```bash
bun run dev:scene        # 先把物流中心示例拷进 public/scene.json，再以单场景模式启动 :3000
# 换场景 / 换领域包：
bun scripts/deploy-scene.ts --no-build -- path/to/scene.json --plugin logistics
VITE_SCENE_URL=/scene.json bun run dev
```

单场景模式由 `VITE_SCENE_URL` 开启（`apps/studio/src/scene/staticScene.ts`）：启动直接取这份
`scene.json` 建会话，**跳过 localStorage 记忆与服务端探测**，所以页面打开就是它，
不会被上一次会话或某个不存在的服务端影响。`VITE_SCENE_PLUGINS` 选领域包
（逗号分隔的插件 id，留空用默认）。`public/scene.json` 是生成物（已 gitignore），
`bun run build` 不会带它——普通构建仍是多场景工作台。

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

## 部署（可选）

两种形态，按你要发布的东西选：

| 形态 | 适用 | 需要服务端 / 数据库 |
|---|---|---|
| **单场景静态站点** | 给别人看**一个**场景（演示、文档、交付） | 都不需要，零 secret |
| 平台 app（多场景工作台） | 完整工作台：场景库、版本、事件落库 | 需要（postgres 后端） |

### 单场景：一条命令发到 Cloudflare

```bash
bun run deploy:scene                                  # 默认物流中心示例
bun run deploy:scene -- path/to/scene.json --plugin logistics
cd apps/worker && bun x wrangler deploy --env scene   # 静态专用 Worker（twin-scene）
```

`deploy:scene` 做三件事：场景过一遍 `parseSceneDocument`（与 Studio 导入同一道校验）→
拷进 `apps/studio/public/scene.json` → 用 `VITE_SCENE_URL=/scene.json` + `VITE_SCENE_PLUGINS`
构建出 `apps/studio/dist/client`。`--env scene` 那个 Worker 只发静态资产、`/api/*` 回 404
（`STATIC_ONLY=1`，见 `apps/worker/wrangler.jsonc`），**不需要 `UPSTREAM` / `API_TOKEN`**。
想换 Pages 而不是 Worker：`bun run deploy:scene -- --out .scene-ci/site`，再
`bun x wrangler pages deploy .scene-ci/site --project-name twin-scene`。

下面是**平台 app** 的部署；两条路线二选一，**生产一律用 postgres 后端**（file 后端在容器里是临时存储）。

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
- 国内注意：`workers.dev` 被 DNS 污染，需绑自定义域名。

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
