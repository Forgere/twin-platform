import { describe, expect, test } from 'bun:test';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { fishingPlugin } from './plugin';

describe('fishingPlugin', () => {
  test('manifest 声明 decision / behavior / scene-template', () => {
    expect(fishingPlugin.manifest.id).toBe('fishing');
    expect(fishingPlugin.manifest.capabilities).toEqual(expect.arrayContaining(['decision', 'behavior', 'scene-template']));
  });

  test('宿主安装后拿到决策域、行为与场景模板', () => {
    const host = new PluginHost();
    const record = host.install(fishingPlugin);
    expect(record.state).toBe('active');
    expect(host.decisions).toHaveLength(1);
    expect(host.decisions[0]?.id).toBe('fishing');
    expect(host.decisions[0]?.actions.length).toBeGreaterThan(0);
    expect(host.behaviors.map((behavior) => behavior.id)).toContain('fish-sim');
    expect(host.template('fishing-pond')?.build({}).length).toBeGreaterThan(0);
  });

  test('宿主里的决策域判断者仍是规则基线', () => {
    const host = new PluginHost();
    host.install(fishingPlugin);
    expect(host.decisions[0]?.judge.id).toBe('rule');
  });
});
