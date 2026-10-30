import { fileRoutes } from 'filesystem-routing/vite';
import { defineConfig } from 'vitest/config';
import solid from '@solidjs/vite-plugin';

// 本项目 tsconfig 只装了 `vite/client`（没装 node types），config 又确实跑在 node/bun 里，
// 就地声明一小块 env：不污染全局，也不用为了两行 process.env 把整个 @types/node 拉进
// Studio 的类型空间（那会一次性改变所有 DOM 全局的类型，基线已经红了，别雪上加霜）。
declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  // Turnkey client mode: no index.html and no mount file — the plugin
  // generates the entries around src/App.tsx, wrapped in src/Document.tsx
  // (or a built-in shell). `vite build` prerenders the shell into
  // dist/client/index.html and emits a purely static dist/client.
  plugins: [
    // `extensions` makes @solidjs/vite-plugin also compile the `?pick=` route
    // modules the fileRoutes plugin emits (their ids end in a query string).
    solid({ start: true, extensions: ['.jsx', '.tsx'], diagnostics: true }), // add `ssr: true` for streaming SSR
    fileRoutes({ types: new URL('./file-routes.d.ts', import.meta.url).pathname }),
  ],
  server: {
    port: 3000,
    // 本地 dev 与线上同构：浏览器**只认同源 /api**，由这里反代到 apps/server（默认 :8787），
    // 并像 apps/worker 一样注入 Authorization —— token 只活在服务端，不进前端 bundle。
    // 这样 dev 与部署跑的是同一条拓扑（不靠 CORS、不靠跨源回退 8787），
    // "本地看着对、上线不对"这类分叉就没了。
    // 上游用 TWIN_SERVER_ORIGIN 覆盖；token 从 TWIN_API_TOKEN 读（服务端进程 env，不是 VITE_*）。
    proxy: {
      '/api': {
        target: process.env.TWIN_SERVER_ORIGIN || 'http://127.0.0.1:8787',
        changeOrigin: true,
        configure: (proxy) => {
          const token = process.env.TWIN_API_TOKEN;
          if (!token) return;
          proxy.on('proxyReq', (proxyReq) => proxyReq.setHeader('authorization', `Bearer ${token}`));
        },
      },
    },
  },
  resolve: {
    dedupe: ['solid-js', '@solidjs/web', '@solidjs/signals', 'three'],
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}', '../../packages/plugins-fishing/studio/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest-setup.ts'],
    // if you have few tests, try commenting this
    // out to improve performance:
    isolate: false,
  },
  build: {
    target: 'esnext',
    // Keep images as asset files instead of inlining them into the JS bundle.
    assetsInlineLimit: 0,
  },
});
