import { afterEach, expect, test, vi } from 'vitest';
import { TwinWorld } from '@twin-platform/world-kernel';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { ReplayController } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import type { StudioRequest, StudioSessionPort } from '@twin-platform/studio-sdk';
import { buildFishingScene, fishingPlugin, observeFishingWorld } from '@twin-platform/plugins-fishing';
import { fetchJevStatus, judgeDomain } from './judging';

afterEach(() => vi.unstubAllGlobals());

function sessionFor(request?: StudioRequest): StudioSessionPort {
  const host = new PluginHost();
  host.install(fishingPlugin);
  const world = new TwinWorld(buildFishingScene({}), { behaviors: host.behaviors });
  return { world, host, request, controller: new ReplayController({ world, storage: createMemoryStorage() }) };
}

test('状态和决策只走宿主请求端口，插件不装配地址或鉴权', async () => {
  const request = vi.fn<StudioRequest>(async () => new Response(JSON.stringify({ configured: true, actionConfidence: 0.8 })));
  const rawFetch = vi.fn(() => { throw new Error('不应绕过宿主请求端口'); });
  vi.stubGlobal('fetch', rawFetch);
  const session = sessionFor(request);
  expect(await fetchJevStatus(session)).toMatchObject({ configured: true });
  expect(request).toHaveBeenNthCalledWith(1, '/api/jev/status');
  await judgeDomain(session, 'jev')!.judge.judge(observeFishingWorld(session.world), { now: session.world.time });
  expect(request).toHaveBeenNthCalledWith(2, '/api/jev/decide', expect.objectContaining({
    method: 'POST', headers: { 'content-type': 'application/json' }, body: expect.any(String),
  }));
  expect(rawFetch).not.toHaveBeenCalled();
});

test('未注入请求端口时仍用同源路径，离线状态安全降级', async () => {
  const rawFetch = vi.fn<StudioRequest>(async () => { throw new Error('离线'); });
  vi.stubGlobal('fetch', rawFetch);
  expect(await fetchJevStatus(sessionFor())).toEqual({ configured: false });
  expect(rawFetch).toHaveBeenCalledWith('/api/jev/status', undefined);
});
