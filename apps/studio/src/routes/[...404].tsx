import { Title } from '@solidjs/meta';
import type { RouteDefinition } from '@solidjs/router';
import { httpStatus } from '@solidjs/web';
import { REPO_URL } from '../links';

// The catch-all route. httpStatus() is a no-op in the browser and takes
// effect when SSR is enabled; it runs in preload so the status code is set
// before the response head flushes.
export const route = {
  preload: () => httpStatus(404),
} satisfies RouteDefinition;

export default function NotFound() {
  return (
    <main>
      <Title>页面不存在 · Twin Studio</Title>
      <h1>页面不存在</h1>
      <p>这个地址没有对应的场景或面板。</p>
      <p>
        <a href="/">返回工作台</a>
        {' · '}
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          在 GitHub 上查看源码
        </a>
      </p>
    </main>
  );
}
