/**
 * 静态单场景（Static single-scene）部署。
 *
 * 想给别人看**一个**场景时，不该要求他先跑服务端、建库、录事件。做法是把那份
 * `scene.json` 当成静态资产一起发出去，页面启动时直接加载它——没有 `/api`，
 * 不探测服务端，记忆（localStorage）也不覆盖这一份，刷新永远是同一个场景。
 *
 * 入口只有两个构建期变量（浏览器 `import.meta.env.*`）：
 * - `VITE_SCENE_URL`：场景 JSON 地址。不设 = 多场景工作台；`/scene.json` = Cloudflare
 *   单场景部署；dev 路径 = 本地直接指向任意场景文件，例如
 *   `VITE_SCENE_URL=/examples/packages/logistics-center/scene.json bun run dev`。
 * - `VITE_SCENE_PLUGINS`：逗号分隔的插件 id，决定这份场景用哪个领域包跑；留空回落到默认。
 *
 * `deploy:scene` 会把 scene.json 拷进 `apps/studio/public/` 并同时注入这两个变量，
 * 所以线上不用再手配。
 */

/** 构建期注入的静态场景地址；空字符串表示没开单场景模式。 */
export function staticSceneUrl(): string {
  return import.meta.env.VITE_SCENE_URL ?? '';
}

export function isStaticScene(): boolean {
  return staticSceneUrl().length > 0;
}

/** 单场景部署的插件集；未配置时返回 undefined，由调用方回落到默认。 */
export function staticPluginIds(): readonly string[] | undefined {
  const raw: unknown = import.meta.env.VITE_SCENE_PLUGINS;
  if (typeof raw !== 'string') return undefined;
  const ids = raw.split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * 取场景 JSON。失败直接抛错：单场景部署拿不到那一份就是整页不可用，
 * 静默回落到模板会让人以为发出去的是错的场景。
 */
export async function fetchStaticScene(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`场景加载失败：${response.status} ${response.statusText}（${url}）`);
  return response.text();
}
