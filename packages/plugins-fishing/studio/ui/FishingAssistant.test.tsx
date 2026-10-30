import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { captureArtifact } from '@solidjs/diagnostics';
import '@solidjs/diagnostics/vitest';
import { createSignal, flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vitest';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { ReplayController } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { TwinWorld } from '@twin-platform/world-kernel';
import { buildFishingScene, fishingPlugin } from '@twin-platform/plugins-fishing';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import FishingAssistant from './FishingAssistant';

vi.mock('./judging', async (original) => ({
  ...await original<typeof import('./judging')>(),
  fetchJevStatus: async () => ({ configured: false }),
}));
afterEach(cleanup);

test('condition buttons keep their DOM and focus across world samples', async () => {
  const host = new PluginHost();
  host.install(fishingPlugin);
  const world = new TwinWorld(buildFishingScene({}), { seed: 20240906, behaviors: host.behaviors });
  const controller = new ReplayController({ world, storage: createMemoryStorage() });
  const session: StudioSessionPort = { world, controller, host };
  session.world.setAttr('rig-01', 'wizardDone', true);
  session.world.setAttr('rig-01', 'mode', 'sim');
  let sample!: () => void;
  const ui = render(() => {
    const [tick, setTick] = createSignal(0, { name: 'test.assistantSample' });
    sample = () => { setTick(t => t + 1); flush(); };
    return <FishingAssistant session={session} tick={tick()} onSetup={() => {}} onSetupClose={() => {}} />;
  });
  fireEvent.click(ui.getByRole('button', { name: /助手/ }));
  flush();
  const group = ui.getByRole('group', { name: '制造情况' });
  const button = group.querySelector('button')!;
  button.focus();
  const { artifact } = await captureArtifact(() => {
    for (let i = 0; i < 4; i += 1) sample();
  }, { scenario: 'fishing-condition-stability' });
  expect(group.querySelector('button')).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(artifact).toHaveNoDiagnostics();
  fireEvent.click(button);
  sample();
  expect(session.world.getEntity('rig-01')?.attrs.drift).toBe(true);
  expect(button).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(button);
  sample();
  expect(session.world.getEntity('rig-01')?.attrs.drift).toBe(false);
});
