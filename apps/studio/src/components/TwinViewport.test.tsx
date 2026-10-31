import { cleanup, fireEvent, render, within } from '@solidjs/testing-library';
import { captureArtifact } from '@solidjs/diagnostics';
import '@solidjs/diagnostics/vitest';
import { flush } from 'solid-js';
import { afterEach, expect, test, vi } from 'vitest';
import TwinViewport from './TwinViewport';
import type { TwinEntityView, TwinSceneControllerOptions } from '../scene/TwinSceneController';

const mounted = vi.hoisted(() => [] as {
  options: TwinSceneControllerOptions;
  select: (entity: TwinEntityView | undefined) => void;
  dispose: ReturnType<typeof vi.fn>;
}[]);
vi.mock('../scene/TwinSceneController', () => ({
  TwinSceneController: class {
    entities = [];
    themeName = 'pastel';
    dispose = vi.fn();
    constructor(_host: unknown, select: (entity: TwinEntityView | undefined) => void, options: TwinSceneControllerOptions) {
      mounted.push({ options, select, dispose: this.dispose });
    }
    setCameraPreset() {}
    setAuditSpots() {}
    setBackdrop() {}
    setTheme() {}
    codePath() { return 'mock/TwinSceneController.ts'; }
    listEntities() { return []; }
  },
}));

afterEach(() => {
  cleanup();
  mounted.length = 0;
  localStorage.clear();
  vi.unstubAllGlobals();
});

test('画布选中后在当前选择卡展示原始 partId，不提供剖切操作', () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline test')));
  const view = render(() => <TwinViewport />);
  flush();

  mounted[0]!.select({ id: 'pump-01', kind: 'pump', label: '主泵', partId: 'IMPELLER-MAIN' });
  flush();

  expect(view.container.querySelector('.part-id')?.textContent).toBe('partId：IMPELLER-MAIN');
  expect(view.queryByRole('button', { name: /剖切/ })).toBeNull();
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
    expect(view.getByRole('tab', { name: /实体/ })).toBeInTheDocument();
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

test('时间轴透镜切换展开抽屉，工具条浮层与全局配置弹窗正常响应', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline test')));
  const view = render(() => <TwinViewport />);
  flush();

  // 1. 验证默认抽屉收起
  expect(view.container.querySelector('.timeline-drawer')).toBeNull();

  // 2. 点击「审计」透镜展开抽屉
  const auditLensBtn = view.getByRole('button', { name: /审计透镜/ });
  fireEvent.click(auditLensBtn);
  flush();
  expect(view.container.querySelector('.timeline-drawer')).not.toBeNull();
  expect(view.container.querySelector('.audit-panel')).not.toBeNull();

  // 3. 点击抽屉内的「事件」Tab 切换
  const drawer = view.container.querySelector('.timeline-drawer') as HTMLElement;
  const eventsDrawerTab = within(drawer).getByRole('tab', { name: /事件/ });
  fireEvent.click(eventsDrawerTab);
  flush();
  expect(view.container.querySelector('.event-log')).not.toBeNull();

  // 4. 点击抽屉关闭按钮
  const closeDrawerBtn = view.getByRole('button', { name: /收起抽屉/ });
  fireEvent.click(closeDrawerBtn);
  flush();
  expect(view.container.querySelector('.timeline-drawer')).toBeNull();

  // 5. 右上角指标浮岛默认展开（独立磨砂卡），工具栏按钮负责收起 / 再展开
  expect(view.getByText('吞吐（件）')).toBeTruthy();
  expect(view.getByText('积压（件）')).toBeTruthy();
  const metricsToolbarBtn = view.getByRole('button', { name: /指标看板悬浮窗/ });
  fireEvent.click(metricsToolbarBtn);
  flush();
  expect(view.container.querySelector('.metric-pods')).toBeNull();
  fireEvent.click(metricsToolbarBtn);
  flush();
  expect(view.container.querySelector('.metric-pods')).not.toBeNull();

  // 指标浮岛自带的关闭按钮同样能收起
  fireEvent.click(view.getByRole('button', { name: /关闭指标看板/ }));
  flush();
  expect(view.container.querySelector('.metric-pods')).toBeNull();

  // 6. 点击工具栏「场景与插件切换」呼出浮层
  const switchToolbarBtn = view.getByRole('button', { name: /场景与插件切换/ });
  fireEvent.click(switchToolbarBtn);
  flush();
  expect(view.container.querySelector('.floating-switch-popover')).not.toBeNull();
  const closeSwitchBtn = view.getByRole('button', { name: /关闭切换面板/ });
  fireEvent.click(closeSwitchBtn);
  flush();
  expect(view.container.querySelector('.floating-switch-popover')).toBeNull();

  // 7. 点击工具栏「数据源与场景高级管理」呼出全局 Modal
  const configToolbarBtn = view.getByRole('button', { name: /系统与数据配置/ });
  fireEvent.click(configToolbarBtn);
  flush();
  expect(view.container.querySelector('.studio-modal')).not.toBeNull();
  const closeModalBtn = view.getByRole('button', { name: /关闭配置弹窗/ });
  fireEvent.click(closeModalBtn);
  flush();
  expect(view.container.querySelector('.studio-modal')).toBeNull();
});

test('Esc 逐层关闭浮层，方向键在检视页签间移动，空格切换播放', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline test')));
  const view = render(() => <TwinViewport />);
  flush();

  // 时间轴抽屉：Esc 只关它，指标浮岛保持打开。
  fireEvent.click(view.getByRole('button', { name: /审计透镜/ }));
  flush();
  expect(view.container.querySelector('.timeline-drawer')).not.toBeNull();
  fireEvent.keyDown(window, { key: 'Escape' });
  flush();
  expect(view.container.querySelector('.timeline-drawer')).toBeNull();
  expect(view.container.querySelector('.metric-pods')).not.toBeNull();

  // 指标浮岛：再按一次才关。
  fireEvent.keyDown(window, { key: 'Escape' });
  flush();
  expect(view.container.querySelector('.metric-pods')).toBeNull();

  // 配置弹窗：Esc 关闭并把焦点还给触发按钮。
  const configBtn = view.getByRole('button', { name: /系统与数据配置/ });
  configBtn.focus();
  fireEvent.click(configBtn);
  flush();
  await Promise.resolve();
  expect(document.activeElement).toBe(view.container.querySelector('.studio-modal'));
  fireEvent.keyDown(window, { key: 'Escape' });
  flush();
  await Promise.resolve();
  expect(view.container.querySelector('.studio-modal')).toBeNull();
  expect(document.activeElement).toBe(configBtn);

  // 检视页签：右方向键把选中态移到下一个页签。
  const tablist = view.container.querySelector('.tab-list') as HTMLElement;
  const current = tablist.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
  const tabs = [...tablist.querySelectorAll<HTMLElement>('[role="tab"]')];
  const index = tabs.indexOf(current);
  current.focus();
  fireEvent.keyDown(current, { key: 'ArrowRight' });
  flush();
  const expected = tabs[(index + 1) % tabs.length];
  expect(expected.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement).toBe(expected);

  // 空格：焦点不在控件上时切换播放。
  const controller = mounted[0]!.options.controller;
  const before = controller.playing;
  (document.activeElement as HTMLElement | null)?.blur();
  fireEvent.keyDown(window, { code: 'Space', key: ' ' });
  flush();
  expect(controller.playing).toBe(!before);
});
