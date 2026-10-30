/** 只做浏览器反馈，不参与仿真时间或随机数；必须由一次用户手势解锁。 */
export function createBiteAudio() {
  let context: AudioContext | undefined;
  let disposed = false;
  const voices = new Set<OscillatorNode>();

  const unlock = (): void => {
    if (disposed) return;
    try {
      const Audio = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Audio) return;
      context ??= new Audio();
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
    } catch {
      // 静音环境或浏览器拒绝音频时，视觉鱼口与提竿照常工作。
    }
  };

  const play = (): void => {
    if (disposed || !context || context.state !== 'running') return;
    try {
      const now = context.currentTime;
      for (const [offset, frequency] of [[0, 880], [0.13, 1174]] as const) {
        const tone = context.createOscillator();
        const gain = context.createGain();
        tone.type = 'sine';
        tone.frequency.setValueAtTime(frequency, now + offset);
        gain.gain.setValueAtTime(0, now + offset);
        gain.gain.linearRampToValueAtTime(0.12, now + offset + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.22);
        tone.connect(gain);
        gain.connect(context.destination);
        voices.add(tone);
        tone.onended = () => {
          voices.delete(tone);
          tone.disconnect();
          gain.disconnect();
        };
        tone.start(now + offset);
        tone.stop(now + offset + 0.24);
      }
    } catch {
      // 音效是可选反馈，设备切换/上下文挂起不能打断钓鱼。
    }
  };

  const silence = (): void => {
    for (const voice of voices) {
      try { voice.stop(); } catch { /* 已结束的声音无需再停止。 */ }
    }
    voices.clear();
  };

  return {
    unlock,
    play,
    silence,
    dispose(): void {
      disposed = true;
      silence();
      if (context) void context.close().catch(() => undefined);
      context = undefined;
    },
  };
}
