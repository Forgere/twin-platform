import { describe, expect, test } from 'bun:test';
import type { TwinScene } from '@twin-platform/scene-schema';
import { runConformance, scanSources } from './conformance';

const scene: TwinScene = {
  version: 1,
  id: 'conformance-scene',
  name: 'Conformance scene',
  entities: [{ id: 'box', kind: 'box', transform: { position: [0, 0, 0] }, capabilities: [], attrs: { count: 0 } }],
};

const goodPlugin = {
  manifest: {
    id: 'demo-plugin',
    version: '1.0.0',
    sdkVersion: '^0.1.0',
    name: 'Demo',
    description: '确定性示例插件',
    capabilities: ['behavior'],
  },
  activate: () => ({
    behaviors: [{
      id: 'demo-tick',
      step(ctx) {
        const entity = ctx.entities.find((item) => item.id === 'box');
        if (!entity) return;
        ctx.setAttr('box', 'count', Number(entity.attrs.count ?? 0) + 1);
      },
    }],
  }),
};

const undeclaredCapabilityPlugin = {
  ...goodPlugin,
  manifest: { ...goodPlugin.manifest, id: 'demo-undeclared', capabilities: ['analytics'] },
};

const nondeterministicPlugin = {
  ...goodPlugin,
  manifest: { ...goodPlugin.manifest, id: 'demo-random', capabilities: ['behavior'] },
};

describe('plugin conformance kit', () => {
  test('合规插件通过全部检查', () => {
    const report = runConformance({
      plugin: goodPlugin,
      scene,
      steps: 30,
      sources: [{ path: 'plugin.ts', text: 'export const step = (ctx) => ctx.setAttr("box", "count", 1);' }],
    });
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      'conformance.manifest',
      'conformance.activate',
      'conformance.host-install',
      'conformance.capabilities',
      'conformance.determinism',
      'conformance.source-hygiene',
    ]);
    expect(report.metrics.behaviors).toBe(1);
    expect(report.metrics.behaviorsVisibleToHost).toBe(1);
  });

  test('声明外贡献会被能力检查抓住', () => {
    const report = runConformance({ plugin: undeclaredCapabilityPlugin, scene, steps: 10 });
    const check = report.checks.find((item) => item.id === 'conformance.capabilities')!;
    expect(check.status).toBe('fail');
    expect(report.passed).toBe(false);
  });

  test('源码里的裸随机与挂钟会被静态检查抓住', () => {
    const findings = scanSources([
      { path: 'a.ts', text: 'const x = Math.random();\n// Math.random() 在注释里不算\nconst t = Date.now();' },
      { path: 'b.ts', text: 'setTimeout(() => {}, 10);' },
    ]);
    expect(findings.map((item) => item.id)).toEqual(['global-random', 'wall-clock', 'timer']);
    const report = runConformance({
      plugin: nondeterministicPlugin,
      scene,
      steps: 10,
      sources: [{ path: 'a.ts', text: 'const x = Math.random();' }],
    });
    expect(report.passed).toBe(false);
    expect(report.checks.find((item) => item.id === 'conformance.source-hygiene')?.status).toBe('fail');
  });

  test('不提供源码时只警告，不假装检查过', () => {
    const report = runConformance({ plugin: goodPlugin, scene, steps: 10 });
    expect(report.passed).toBe(true);
    expect(report.warnings.join(' ')).toContain('跳过裸随机');
  });
});
