import type { StudioRequest } from '@twin-platform/studio-sdk';
import { resolveServerUrl } from '../scene/serverUrl';

/** 插件只知道 /api 路径；地址由宿主选择，共享密钥由同源代理注入。 */
export const requestApi: StudioRequest = (path, init) => {
  if (!path.startsWith('/api/') || path.includes('..')) throw new Error('插件请求必须使用 /api/ 路径。');
  return fetch(resolveServerUrl() + path, init);
};
