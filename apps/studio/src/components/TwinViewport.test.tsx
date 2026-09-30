import { cleanup, fireEvent, render } from '@solidjs/testing-library';
import { captureArtifact } from '@solidjs/diagnostics';
import '@solidjs/diagnostics/vitest';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vitest';
import TwinViewport from './TwinViewport';
import type { TwinSceneControllerOptions } from '../scene/TwinSceneController';

const mounted = vi.hoisted(() => [] as { options: TwinSceneControllerOptions; dispose: ReturnType<typeof vi.fn> }[]);
vi.mock('../scene/TwinSceneController', () => ({
  TwinSceneController: class {
    entities = [];
    themeName = 'pastel';
    dispose = vi.fn();
    constructor(_host: unknown, _select: unknown, options: TwinSceneControllerOptions) { mounted.push({ options, dispose: this.dispose }); }
    setCameraPreset() {}
    listEntities() { return []; }
  },
}));

afterEach(() => {
  cleanup();
  mounted.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
});

test('真实视口通过插件插槽挂载钓场，换领域卸载旧 UI 并暂停旧会话', async () => {
  localStorage.setItem('twin.plugins.v1', JSON.stringify(['fishing']));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline test')));
  const { artifact } = await captureArtifact(async () => {
    const view = render(() => <TwinViewport />);
    flush();
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.options.presentation).toBeTypeOf('function');
    expect(view.getByRole('tab', { name: /钓组/ })).toBeInTheDocument();
    // 首次进场的向导由插件初始化；宿主只消费其 Overlay。
    expect(view.container.querySelector('.onboard')).not.toBeNull();
    fireEvent.click(view.getByRole('tab', { name: /插件/ }));
    flush();
    fireEvent.click(view.getByRole('checkbox', { name: /^物流/ }));
    flush();
    expect(mounted).toHaveLength(2);
    expect(mounted[0]!.dispose).toHaveBeenCalledOnce();
    expect(mounted[0]!.options.controller.playing).toBe(false);
    expect(mounted[1]!.options.presentation).toBeUndefined();
    expect(view.queryByRole('tab', { name: /钓组/ })).toBeNull();
    expect(view.container.querySelector('.onboard')).toBeNull();
    expect(view.container.querySelector('.fish-controls')).toBeNull();
    expect(view.getByRole('tab', { name: /指标/ })).toBeInTheDocument();
    // 换回新钓场时，领域状态必须重新初始化，而非沿用已卸载的向导。
    fireEvent.click(view.getByRole('tab', { name: /插件/ }));
    flush();
    fireEvent.click(view.getByRole('checkbox', { name: /^台钓/ }));
    flush();
    expect(mounted).toHaveLength(3);
    expect(mounted[1]!.options.controller.playing).toBe(false);
    expect(view.container.querySelector('.onboard')).not.toBeNull();
    cleanup();
  }, { scenario: 'studio-domain-switch' });
  expect(artifact).toHaveNoDiagnostics();
});
