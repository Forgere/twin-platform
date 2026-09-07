import { CsvFrameSource, type CsvParseIssue } from '@twin-platform/data-source-csv';
import { ReplayController, SessionRecorder } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { TwinWorld, type WorldEvent } from '@twin-platform/world-kernel';
import { demoScene } from './demoScene';

/**
 * Studio 的一次运行会话：世界 + 仓储 + 录制器 + 时间轴控制器。
 *
 * Studio 自己不推演任何状态，只负责把这四样东西接起来：
 * 渲染层消费帧差量，时间轴消费 `ReplayController`，持久化交给 `SessionRecorder`。
 * 换 PostgreSQL 只需把 `createMemoryStorage()` 换成 `createPostgresStorage(pool)`。
 */

export interface CsvLoadResult {
  frames: number;
  duration: number;
  issues: CsvParseIssue[];
  /** CSV 里出现过的实体 id，用来把它们切成"听外部数据"。 */
  entities: string[];
}

export const SAMPLE_CSV = ['t,id,x,y,z', '0,cargo-01,-5.2,1.15,0', '1,cargo-01,-2.4,1.15,0', '2,cargo-01,0.6,1.15,0', '3,cargo-01,3.4,1.15,0', '4,cargo-01,5.2,1.15,0'].join('\n');

export class StudioSession {
  readonly storage = createMemoryStorage();
  readonly world: TwinWorld;
  readonly recorder: SessionRecorder;
  readonly controller: ReplayController;

  constructor() {
    this.world = new TwinWorld(demoScene, { seed: 20240906, maxStepsPerAdvance: 600 });
    this.recorder = new SessionRecorder(this.world, this.storage, {
      sessionId: 'studio-live',
      label: 'Studio 实时录制',
      // 演示里 2 秒一份快照，方便拖动时间轴时验证"从快照恢复 + 重算"
      snapshotIntervalSteps: 120,
    });
    this.controller = new ReplayController({
      world: this.world,
      storage: this.storage,
      maxStepsPerAdvance: 600,
      onFrame: (frame) => {
        void this.recorder.tick(frame);
      },
    });
    void this.recorder.start();
    this.controller.play(1);
  }

  /** 载入 CSV：切到 hybrid 模式，并把 CSV 里出现过的实体标成外部数据源。 */
  loadCsv(text: string): CsvLoadResult {
    const { source, result } = CsvFrameSource.fromCsv(text);
    this.controller.attachSource(source);
    this.world.setMode('hybrid');
    const entities = [...new Set(result.frames.flatMap((frame) => frame.entities.map((entity) => entity.id)))];
    for (const id of entities) this.world.setEntityDataSource(id, 'external');
    return { frames: result.frames.length, duration: source.duration, issues: result.issues, entities };
  }

  /** 丢掉数据源，回到纯仿真。 */
  useSimulation(): void {
    this.controller.attachSource(undefined);
    this.world.setMode('sim');
  }

  /** 时间轴上的最近事件（世界内存日志的尾部）。 */
  recentEvents(count = 8): WorldEvent[] {
    return this.world.getEventLog().slice(-count).reverse();
  }

  /** 已落库事件数，用来确认录制在跑。 */
  async storedEventCount(): Promise<number> {
    return this.storage.events.latestSequence(this.world.scene.id);
  }
}
