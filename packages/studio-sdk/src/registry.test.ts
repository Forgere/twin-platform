import { expect, test } from 'bun:test';
import { PluginHost, type TwinPlugin } from '@twin-platform/plugin-sdk';
import { TWIN_SCENE_VERSION, type TwinScene } from '@twin-platform/world-kernel';
import { selectPresentation, type StudioPresentation } from './index';

const scene: TwinScene = { version: TWIN_SCENE_VERSION, id: 'empty', name: 'Empty', entities: [] };
const plugin = (id: string): TwinPlugin => ({
  manifest: { id, version: '1.0.0', sdkVersion: '*', capabilities: ['behavior'] },
  activate: () => ({}),
});
const presentation = (pluginId: string): StudioPresentation => ({
  pluginId, matches: () => true,
  inspector: { defaultTab: 'custom', tabs: [{ id: 'custom', icon: '', label: 'Custom' }] },
});

test('only active installed plugins may claim a matching scene', () => {
  const host = new PluginHost();
  const view = presentation('demo');
  expect(selectPresentation(host, scene, [view])).toBeUndefined();
  host.install(plugin('demo'));
  expect(selectPresentation(host, scene, [view])).toBe(view);
  expect(selectPresentation(host, scene, [{ ...view, matches: () => false }])).toBeUndefined();
  host.uninstall('demo');
  expect(selectPresentation(host, scene, [view])).toBeUndefined();
});

test('failed activation never mounts its browser presentation', () => {
  const host = new PluginHost();
  host.install({ ...plugin('broken'), activate: () => { throw new Error('unavailable'); } });
  expect(selectPresentation(host, scene, [presentation('broken')])).toBeUndefined();
});

test('ambiguous claims and invalid inspector configuration fail explicitly', () => {
  const host = new PluginHost();
  host.install(plugin('first'));
  host.install(plugin('second'));
  expect(() => selectPresentation(host, scene, [presentation('second'), presentation('first')])).toThrow('first / second');
  expect(() => selectPresentation(host, scene, [{ ...presentation('first'), inspector: { defaultTab: 'missing', tabs: [] } }])).toThrow('检视页配置');
  const view = presentation('first');
  expect(() => selectPresentation(host, scene, [{ ...view, inspector: { ...view.inspector, tabs: [...view.inspector.tabs, ...view.inspector.tabs] } }])).toThrow('检视页配置');
});
