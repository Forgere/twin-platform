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
import { readRig, setFishingMode, stepRigParam, switchBait, switchGear } from './fishingWorld';
import RigSettings from './RigSettings';

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
  const openBait = () => { fireEvent.click(view.getByRole('button', { name: '换饵', exact: true })); flush(); };
  return { ...view, session, world, refresh, event, events, setSession, openBait };
};

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('钓鱼操作与只读钓况', () => {
  test('右上角无操作，底部换饵→抛竿→提竿，等鱼时禁止换饵', () => {
    const view = setup();
    const hud = view.getByLabelText('钓况');
    expect(hud.querySelectorAll('button,input,select,a,[tabindex]')).toHaveLength(0);
    view.openBait();
    fireEvent.click(view.getByRole('button', { name: '玉米粒' }));
    view.refresh();
    expect(readRig(view.session)?.loadout.bait).toBe('corn');
    expect(view.queryByRole('button', { name: '玉米粒' })).toBeNull();
    view.openBait();
    expect(view.getByRole('button', { name: '玉米粒' })).toHaveAttribute('aria-pressed', 'true');
    view.openBait();
    fireEvent.click(view.getByRole('button', { name: /抛竿/ }));
    view.refresh();
    expect(audio.unlock).toHaveBeenCalledOnce();
    expect(readRig(view.session)?.counts.casts).toBe(1);
    expect(view.getByRole('button', { name: '换饵', exact: true })).toBeDisabled();
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

  test('一次只调一个参数：低频装备藏在更多里，选完收起且保留测量值', () => {
    const view = setup();
    const controls = within(view.getByLabelText('钓鱼操作'));
    expect(controls.queryByRole('combobox')).toBeNull();
    expect(controls.queryByText('调目（测量值）')).toBeNull();
    expect(controls.queryByRole('button', { name: /竿长/ })).toBeNull();
    const before = readRig(view.session)!.state!.rig;
    for (const [label, key, option, value] of [
      ['目标鱼', 'targetFish', '鲤鱼', 'carp'], ['竿长', 'rodLength', '5.4m', 5.4],
      ['主线', 'mainLine', '2号', 2], ['子线', 'subLine', '1号', 1],
      ['钩', 'hookSize', '5号', 5], ['浮漂', 'floatSize', '2g', 2],
    ] as const) {
      fireEvent.click(controls.getByRole('button', { name: '更多', exact: true })); flush();
      fireEvent.click(controls.getByRole('button', { name: new RegExp('^' + label + '( ·|$)') })); flush();
      const panel = controls.getByRole('region', { name: label });
      expect(view.container.querySelectorAll('.fish-quick-panel')).toHaveLength(1);
      fireEvent.click(within(panel).getByRole('button', { name: option, exact: true }));
      view.refresh();
      expect(readRig(view.session)!.loadout[key]).toBe(value);
      expect(view.container.querySelector('.fish-quick-panel')).toBeNull();
    }
    const after = readRig(view.session)!.state!.rig;
    expect([after.t0, after.t, after.w]).toEqual([before.t0, before.t, before.w]);
    fireEvent.click(controls.getByRole('button', { name: /^钓 .* 目$/ })); flush();
    fireEvent.click(controls.getByRole('button', { name: '钓目加半目' })); view.refresh();
    expect(readRig(view.session)!.state!.rig.d).toBe(before.d + 0.5);
    fireEvent.keyDown(controls.getByRole('button', { name: '完成' }), { key: 'Escape' }); flush();
    expect(view.container.querySelector('.fish-quick-panel')).toBeNull();
    const peer = render(() => <RigSettings session={view.session} rig={readRig(view.session)!} />);
    expect(within(peer.container).getByLabelText('竿长')).toHaveValue('5.4');
    const w = readRig(view.session)!.state!.rig.w;
    expect(stepRigParam(view.session, 'w', -100)).toBeTruthy();
    expect(readRig(view.session)!.state!.rig.w).toBe(w);
  });

  test('写入口守卫收竿及配置状态，真实模式仍可逐项编辑', () => {
    const view = setup();
    fireEvent.click(view.getByRole('button', { name: /抛竿/ })); view.refresh();
    const before = readRig(view.session)!;
    expect(view.getByRole('button', { name: '更多', exact: true })).toBeDisabled();
    expect(switchGear(view.session, { rodLength: 7.2 })).toContain('收竿');
    expect(stepRigParam(view.session, 'd', 0.5)).toContain('收竿');
    expect(readRig(view.session)!.loadout).toEqual(before.loadout);
    setFishingMode(view.session, 'real'); view.refresh();
    view.openBait();
    fireEvent.click(view.getByRole('button', { name: '玉米粒' })); view.refresh();
    expect(readRig(view.session)!.loadout.bait).toBe('corn');
    view.world.setAttr('rig-01', 'rigPhase', 'measure_w'); view.refresh();
    expect(view.getByRole('button', { name: '更多', exact: true })).toBeDisabled();
    expect(switchGear(view.session, { bait: 'worm' })).toContain('配置');
  });

  test('消息与鱼获放在上方提示层，底部只留操作；HUD显示钩底状态', () => {
    const view = setup();
    const notices = view.getByLabelText('钓鱼提示');
    const controls = view.getByLabelText('钓鱼操作');
    expect(notices.querySelector('.fish-controls-hint')).not.toBeNull();
    expect(controls.querySelector('.fish-controls-hint')).toBeNull();
    view.event('fish:lift', { result: 'caught', fishId: 'carp' });
    expect(within(notices).getByText('钓到了！')).toBeTruthy();
    for (const [d, label] of [[1.5, '单钩轻微触底'], [2, '单钩触底'], [3.5, '一钩躺底、一钩触底']] as const) {
      for (const [key, value] of Object.entries({ t0: 4, t: 2, w: 1, d })) view.world.setAttr('rig-01', key, value);
      view.refresh();
      expect(view.getByLabelText('钩底状态')).toHaveTextContent(label);
    }
    expect(view.getByLabelText('钓况')).not.toHaveTextContent(/偏灵|偏钝|不灵不钝/);
  });

  test('装备切换无响应式诊断，沿用控件单次采样', async () => {
    const { artifact } = await captureArtifact(() => {
      const view = setup();
      fireEvent.click(view.getByRole('button', { name: '更多', exact: true })); flush();
      fireEvent.click(view.getByRole('button', { name: /^竿长 ·/ })); flush();
      fireEvent.click(view.getByRole('button', { name: '5.4m', exact: true })); view.refresh();
    }, { scenario: 'fishing-gear' });
    expect(artifact).toHaveNoDiagnostics();
    expect(artifact).toStayWithinRerunBudget(2, { scope: /fishing.controls.rig/ });
  });

  test('换饵/抛竿的 Solid 响应式诊断为空，采样只读取一次控件模型', async () => {
    const { artifact } = await captureArtifact(() => {
      const view = setup();
      view.openBait();
      fireEvent.click(view.getByRole('button', { name: '蚯蚓' }));
      view.refresh();
      fireEvent.click(view.getByRole('button', { name: /抛竿/ }));
      view.refresh();
    }, { scenario: 'fishing-cast' });
    expect(artifact).toHaveNoDiagnostics();
    expect(artifact).toStayWithinRerunBudget(3, { scope: /fishing.controls.rig/ });
  });
});
