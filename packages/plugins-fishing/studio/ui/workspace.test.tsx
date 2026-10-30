import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { captureArtifact } from '@solidjs/diagnostics';
import '@solidjs/diagnostics/vitest';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vitest';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { ReplayController } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { TwinWorld } from '@twin-platform/world-kernel';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { buildFishingScene, fishingPlugin } from '@twin-platform/plugins-fishing';
import { createFishingWorkspace } from '../workspace';

const audio = vi.hoisted(() => ({ unlock: vi.fn(), play: vi.fn(), silence: vi.fn(), dispose: vi.fn() }));
vi.mock('./biteAudio', () => ({ createBiteAudio: () => audio }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function sessionFor(configured: boolean): StudioSessionPort {
  const host = new PluginHost();
  host.install(fishingPlugin);
  const world = new TwinWorld(buildFishingScene({}), { behaviors: host.behaviors, seed: 7 });
  world.setAttr('rig-01', 'wizardDone', configured);
  return {
    world,
    host,
    controller: new ReplayController({ world, storage: createMemoryStorage() }),
    request: async () => new Response(JSON.stringify({ configured: false })),
  };
}

function mountWorkspace(session: StudioSessionPort, closeInspector = vi.fn()) {
  return render(() => {
    const workspace = createFishingWorkspace({ session, tick: () => 0, closeInspector });
    const Stage = workspace.Stage!;
    const Overlay = workspace.Overlay!;
    return <div><div data-testid="stage"><Stage /></div><div data-testid="overlay"><Overlay /></div></div>;
  });
}

test('插件插槽保留操作区与浮层的直接父元素，已配置会话不自动弹向导', () => {
  const view = mountWorkspace(sessionFor(true));
  flush();
  expect(view.getByLabelText('钓鱼操作').parentElement).toBe(view.getByTestId('stage'));
  expect(view.getByLabelText('钓况').parentElement).toBe(view.getByTestId('overlay'));
  expect(view.queryByLabelText('钓鱼助手 · 开钓向导')).toBeNull();
});

test('向导状态属于会话：初次自动打开，卸载不会恢复旧会话播放', async () => {
  const first = sessionFor(false);
  first.controller.play();
  const view = mountWorkspace(first);
  flush();
  expect(view.getByLabelText('钓鱼助手 · 开钓向导')).toBeTruthy();
  expect(first.controller.playing).toBe(false);
  view.unmount();
  flush();
  expect(first.controller.playing).toBe(false);
  expect(audio.dispose).toHaveBeenCalledOnce();

  const second = sessionFor(true);
  const { artifact } = await captureArtifact(() => {
    const next = mountWorkspace(second);
    flush();
    expect(next.queryByLabelText('钓鱼助手 · 开钓向导')).toBeNull();
  }, { scenario: 'fishing-workspace-session-replacement' });
  expect(artifact).toHaveNoDiagnostics();
  expect(first.controller.playing).toBe(false);
});

test('助手与重新配置通过通用动作关闭检视区', () => {
  const closeInspector = vi.fn();
  const view = mountWorkspace(sessionFor(true), closeInspector);
  flush();
  fireEvent.click(view.getByRole('button', { name: /助手/ }));
  flush();
  expect(closeInspector).toHaveBeenCalledOnce();
  fireEvent.click(view.getByRole('button', { name: '开钓向导' }));
  flush();
  expect(closeInspector).toHaveBeenCalledTimes(2);
  expect(view.getByLabelText('钓鱼助手 · 开钓向导')).toBeTruthy();
});
