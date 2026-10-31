import type { ParentProps } from 'solid-js';
import { HydrationScript } from '@solidjs/web';

// The document shell — the new index.html: picked up by the src/Document.*
// convention, it wraps the app in the plugin's generated entries and must
// render the full <html>. Head tags go here. It is compiled only into the
// prerendered static shell and ships zero client-side JS: in client mode
// <HydrationScript /> is stripped from the shell, and it activates when the
// app flips to SSR (`ssr: true` in vite.config.ts) — no document changes
// needed. Delete this file to fall back to the plugin's built-in shell.
export default function Document(props: ParentProps) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
        <link rel="icon" href="/favicon.ico" />
        {/* 只有明亮一档：声明 light，原生滚动条 / 下拉框才不会被浏览器涂成深色。 */}
        <meta name="color-scheme" content="light" />
        <title>Twin Studio · 数字孪生工作台</title>
        <HydrationScript />
      </head>
      <body>{props.children}</body>
    </html>
  );
}
