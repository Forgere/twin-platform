import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBiteAudio } from './biteAudio';

afterEach(() => vi.unstubAllGlobals());

describe('鱼口音效', () => {
  test('没有音频支持、创建失败或恢复被拒绝均静默降级', async () => {
    vi.stubGlobal('AudioContext', undefined);
    const unsupported = createBiteAudio();
    expect(() => { unsupported.unlock(); unsupported.play(); unsupported.dispose(); }).not.toThrow();
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('blocked'); } });
    const blocked = createBiteAudio();
    expect(() => { blocked.unlock(); blocked.play(); blocked.dispose(); }).not.toThrow();
    const resume = vi.fn().mockRejectedValue(new Error('not allowed'));
    vi.stubGlobal('AudioContext', class {
      state = 'suspended';
      resume = resume;
      close = vi.fn().mockResolvedValue(undefined);
    });
    const suspended = createBiteAudio();
    suspended.unlock();
    suspended.play();
    await Promise.resolve();
    expect(resume).toHaveBeenCalledOnce();
    suspended.dispose();
  });

  test('用户手势前不创建音频；短双音会停止并释放，卸载后不可重建', () => {
    const voices: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; onended?: () => void }[] = [];
    const close = vi.fn().mockResolvedValue(undefined);
    const construct = vi.fn();
    vi.stubGlobal('AudioContext', class {
      state = 'running';
      currentTime = 0;
      destination = {};
      close = close;
      constructor() { construct(); }
      createGain() {
        return { gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
      }
      createOscillator() {
        const voice = { type: '', frequency: { setValueAtTime: vi.fn() }, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
        voices.push(voice);
        return voice;
      }
    });
    const audio = createBiteAudio();
    audio.play();
    expect(construct).not.toHaveBeenCalled();
    audio.unlock(); audio.unlock();
    expect(construct).toHaveBeenCalledOnce();
    audio.play();
    expect(voices).toHaveLength(2);
    expect(voices[0]!.stop).toHaveBeenCalledWith(0.24);
    audio.silence();
    expect(voices[0]!.stop).toHaveBeenCalledTimes(2);
    voices.forEach((voice) => voice.onended?.());
    expect(voices[0]!.disconnect).toHaveBeenCalledOnce();
    audio.dispose();
    audio.unlock(); audio.play();
    expect(close).toHaveBeenCalledOnce();
    expect(construct).toHaveBeenCalledOnce();
  });
});
