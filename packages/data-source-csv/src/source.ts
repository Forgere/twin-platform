import type { ExternalFrameSource } from '@twin-platform/replay-core';
import type { ExternalFrame, TwinWorld } from '@twin-platform/world-kernel';
import { parseCsv, type CsvParseOptions, type CsvParseResult } from './parse';

/**
 * CSV 帧源：实现 `ExternalFrameSource`，可以直接塞给 `ReplayController`。
 *
 * 只有一个游标，且只向前推；`rewind()` 把游标拨回 0。因此"喂帧"这件事是
 * 时间的纯函数——同样的时间轴走两遍，喂进去的帧序列一模一样，
 * 这正是 `seek` 敢用重算而不是插值的原因。
 */
export class CsvFrameSource implements ExternalFrameSource {
  private readonly frames: readonly ExternalFrame[];
  private readonly explicitDuration?: number;
  private cursor = 0;

  constructor(frames: readonly ExternalFrame[], options: { duration?: number } = {}) {
    this.frames = frames;
    this.explicitDuration = options.duration;
  }

  /** 从 CSV 文本构造。解析问题通过 `issues` 暴露，不静默丢行。 */
  static fromCsv(text: string, options: CsvParseOptions = {}): { source: CsvFrameSource; result: CsvParseResult } {
    const result = parseCsv(text, options);
    return { source: new CsvFrameSource(result.frames), result };
  }

  get frameCount(): number {
    return this.frames.length;
  }

  get duration(): number {
    if (this.explicitDuration !== undefined) return this.explicitDuration;
    const last = this.frames[this.frames.length - 1];
    return last?.sourceTime ?? 0;
  }

  /** 已喂到第几帧（时间轴进度用）。 */
  get fedCount(): number {
    return this.cursor;
  }

  feedTo(world: TwinWorld, time: number): void {
    while (this.cursor < this.frames.length) {
      const frame = this.frames[this.cursor] as ExternalFrame;
      if ((frame.sourceTime ?? 0) > time) return;
      this.cursor += 1;
      world.ingestExternalFrame(frame);
    }
  }

  rewind(): void {
    this.cursor = 0;
  }
}
