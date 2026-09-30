import { describe, expect, test } from 'vitest';
import { StudioSession } from '../scene/studioSession';
import { resolvePlugins } from './catalog';
import { presentationFor } from './presentations';
import { buildCenterScene } from '@twin-platform/plugins-logistics';

describe('领域展示装配', () => {
  test('场景和已激活插件共同决定展示，导入其他领域不会误挂钓场', () => {
    const fishing = new StudioSession(undefined, undefined, resolvePlugins(['fishing']), { autoPlay: false });
    expect(presentationFor(fishing)?.pluginId).toBe('fishing');
    expect(presentationFor(fishing)?.inspector.defaultTab).toBe('rig');
    const imported = new StudioSession(buildCenterScene({}), undefined, resolvePlugins(['fishing', 'logistics']), { autoPlay: false });
    expect(presentationFor(imported)).toBeUndefined();
    fishing.host.uninstall('fishing');
    expect(presentationFor(fishing)).toBeUndefined();
    fishing.host.dispose();
    imported.host.dispose();
  });
});
