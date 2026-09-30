import { createSignal, flush } from 'solid-js';
import { cleanup, fireEvent, render, within } from '@solidjs/testing-library';
import { captureArtifact } from '@solidjs/diagnostics';
import '@solidjs/diagnostics/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TwinWorld, type WorldEvent } from '@twin-platform/world-kernel';
import { buildFishingScene, createFishSimBehavior } from '@twin-platform/plugins-fishing';
import { ReplayController } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import FishingControls from './FishingControls';
import FishingHud from './FishingHud';
import { readRig, setFishingMode, switchBait } from './fishingWorld';

const audio = vi.hoisted(() => ({ unlock: vi.fn(), play: vi.fn(), silence: vi.fn(), dispose: vi.fn() }));
vi.mock('./biteAudio', () => ({ createBiteAudio: () => audio }));

const setup = () => {
  const world = new TwinWorld(buildFishingScene({ castInterval: 0.5 }), { seed: 5, behaviors: [createFishSimBehavior()] });
  world.setAttr('rig-01', 'wizardDone', true);
  const controller = new ReplayController({ world, storage: createMemoryStorage() });
  const session: StudioSessionPort = { world, controller, host: { decisions: [] } };
  setFishingMode(session, 'sim');
  const events = [...world.getEventLog()];
  vi.spyOn(world, 'getEventLog').mockImplementation(() => events);
  const [tick, setTick] = createSignal(0, { name: 'test.fishing.tick' });
  const [currentSession, setSession] = createSignal(session, { name: 'test.fishing.session' });
  const view = render(() => <><FishingControls session={currentSession()} tick={tick()} /><FishingHud session={currentSession()} tick={tick()} /></>);
  const refresh = () => { setTick((n) => n + 1); flush(); };
  const event = (type: string, payload: WorldEvent['payload']) => {
    events.push({ sequence: (events.at(-1)?.sequence ?? 0) + 1, occurredAt: world.time, type, entityId: 'rig-01', payload });
    refresh();
  };
  flush();
  return { ...view, session, world, refresh, event, events, setSession };
};

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('钓鱼操作与只读钓况', () => {
  test('右上角无操作，底部换饵→抛竿→提竿，等鱼时禁止换饵', () => {
    const view = setup();
    const hud = view.getByLabelText('钓况');
    expect(hud.querySelectorAll('button,input,select,a,[tabindex]')).toHaveLength(0);
    fireEvent.click(view.getByRole('button', { name: '玉米粒' }));
    view.refresh();
    expect(readRig(view.session)?.loadout.bait).toBe('corn');
    expect(view.getByRole('button', { name: '玉米粒' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(view.getByRole('button', { name: /抛竿/ }));
    view.refresh();
    expect(audio.unlock).toHaveBeenCalledOnce();
    expect(readRig(view.session)?.counts.casts).toBe(1);
    expect(view.getByRole('button', { name: '蚯蚓' })).toBeDisabled();
    switchBait(view.session, 'worm');
    expect(readRig(view.session)?.loadout.bait).toBe('corn');
    fireEvent.click(view.getByRole('button', { name: /提竿/ }));
    view.refresh();
    expect(readRig(view.session)?.lastLift).toBe('blank');
    expect(view.getByRole('button', { name: /抛竿/ })).toBeEnabled();
  });

  test('未完成配置时操作不可用；真实做钓仍可记录一竿且不会弹模拟鱼获', () => {
    const view = setup();
    view.world.setAttr('rig-01', 'rigPhase', 'measure_t0');
    view.refresh();
    expect(view.getByRole('button', { name: /抛竿/ })).toBeDisabled();
    view.world.setAttr('rig-01', 'rigPhase', 'fishing');
    setFishingMode(view.session, 'real');
    view.refresh();
    fireEvent.click(view.getByRole('button', { name: /记录一竿/ }));
    flush();
    fireEvent.click(within(view.getByRole('group', { name: '记一竿' })).getByRole('button', { name: /中鱼/ }));
    view.refresh();
    expect(readRig(view.session)?.counts.catches).toBe(1);
    expect(view.queryByText('钓到了！')).toBeNull();
    expect(view.queryByRole('button', { name: /抛竿/ })).toBeNull();
  });

  test('每条新鱼口只响一次，普通 tick / 静音切换不补播', () => {
    const view = setup();
    view.event('fish:bite', { bite: true });
    expect(audio.play).toHaveBeenCalledOnce();
    view.refresh(); view.refresh();
    expect(audio.play).toHaveBeenCalledOnce();
    fireEvent.click(view.getByRole('button', { name: '鱼口音效' }));
    flush();
    view.event('fish:bite', { bite: true });
    expect(audio.play).toHaveBeenCalledOnce();
    fireEvent.click(view.getByRole('button', { name: '鱼口音效' }));
    flush(); view.refresh();
    expect(audio.play).toHaveBeenCalledOnce();
    view.event('fish:cast', { bite: true });
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  test('只展示成功结算的鱼种、无交互不抢焦点；连续鱼获重置自动消失计时', () => {
    const view = setup();
    const button = view.getByRole('button', { name: /抛竿/ });
    button.focus();
    view.event('fish:lift', { result: 'empty', fishId: 'carp' });
    expect(view.queryByText('钓到了！')).toBeNull();
    view.event('fish:lift', { result: 'caught', fishId: 'carp' });
    expect(within(view.getByRole('status')).getByText('鲤鱼')).toBeTruthy();
    expect(view.getByRole('status').querySelectorAll('button,input,[tabindex]')).toHaveLength(0);
    expect(document.activeElement).toBe(button);
    vi.advanceTimersByTime(2000); flush();
    view.event('fish:lift', { result: 'caught', fishId: 'grass_carp' });
    vi.advanceTimersByTime(1500); flush();
    expect(within(view.getByRole('status')).getByText('草鱼')).toBeTruthy();
    vi.advanceTimersByTime(1500); flush();
    expect(view.queryByText('钓到了！')).toBeNull();
  });

  test('回退、切换模式/会话不播历史反馈；卸载释放音效和计时器', () => {
    const view = setup();
    view.world.runSteps(60);
    view.event('fish:lift', { result: 'caught', fishId: 'carp' });
    expect(view.queryByText('钓到了！')).toBeTruthy();
    view.world.reset();
    view.world.setAttr('rig-01', 'wizardDone', true);
    setFishingMode(view.session, 'sim');
    view.refresh();
    expect(view.queryByText('钓到了！')).toBeNull();
    view.event('fish:lift', { result: 'caught', fishId: 'carp' });
    setFishingMode(view.session, 'real');
    view.refresh();
    expect(view.queryByText('钓到了！')).toBeNull();
    view.setSession({ ...view.session } as StudioSessionPort); flush();
    expect(audio.play).not.toHaveBeenCalled();
    view.unmount();
    expect(audio.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('换饵/抛竿的 Solid 响应式诊断为空，采样只读取一次控件模型', async () => {
    const { artifact } = await captureArtifact(() => {
      const view = setup();
      fireEvent.click(view.getByRole('button', { name: '蚯蚓' }));
      view.refresh();
      fireEvent.click(view.getByRole('button', { name: /抛竿/ }));
      view.refresh();
    }, { scenario: 'fishing-cast' });
    expect(artifact).toHaveNoDiagnostics();
    expect(artifact).toStayWithinRerunBudget(3, { scope: /fishing.controls.rig/ });
  });
});
