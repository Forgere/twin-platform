import { CsvFrameSource, type CsvParseIssue } from '@twin-platform/data-source-csv';
import { ReplayController, SessionRecorder } from '@twin-platform/replay-core';
import { createMemoryStorage } from '@twin-platform/storage-memory';
import { TwinWorld, type WorldEvent } from '@twin-platform/world-kernel';
import { lineMetrics, type LineMetrics } from '@twin-platform/analytics-core';
import { PluginHost } from '@twin-platform/plugin-sdk';
import { buildLineScene, createLogisticsBehavior, logisticsPlugin } from '@twin-platform/plugins-logistics';
import { compareScenarios, type ScenarioDiff } from '@twin-platform/scenario-compare';

/**
 * Studio 的一次运行会话：插件宿主 + 世界 + 仓储 + 录制器 + 时间轴控制器。
 *
 * 阶段 D 之后，场景不再是写死的 `demoScene`，而是由 `logistics` 插件经
 * `PluginHost` 安装后、用它的场景模板生成；世界用插件贡献的行为驱动。
 * 这样"装插件 = 得到场景 + 仿真 + 指标"这条链路在 Studio 里是真实跑通的，
 * 而不是另写一份逻辑。
 *
 * Studio 自己不推演状态、不算指标：指标调用 `analytics-core`，分叉对比调用
 * `scenario-compare`。
 */

export interface CsvLoadResult {
  frames: number;
  duration: number;
  issues: CsvParseIssue[];
  /** CSV 里出现过的实体 id，用来把它们切成"听外部数据"。 */
  entities: string[];
}

export const SAMPLE_CSV = ['t,id,x,y,z', '0,cargo-01,-5.2,1.15,0', '1,cargo-01,-2.4,1.15,0', '2,cargo-01,0.6,1.15,0', '3,cargo-01,3.4,1.15,0', '4,cargo-01,5.2,1.15,0'].join('\n');

const LINE_PARAMS = { parcels: 5, length: 20 } as const;

export class StudioSession {
  readonly storage = createMemoryStorage();
  readonly host: PluginHost;
  readonly world: TwinWorld;
  readonly recorder: SessionRecorder;
  readonly controller: ReplayController;

  constructor() {
    // 1) 安装物流插件：拿到行为、指标、场景模板（故障隔离在宿主里）。
    this.host = new PluginHost();
    this.host.install(logisticsPlugin);

    // 2) 用插件模板生成场景，用插件行为驱动世界。
    const scene = buildLineScene(LINE_PARAMS);
    this.world = new TwinWorld(scene, {
      seed: 20240906,
      maxStepsPerAdvance: 600,
      behaviors: this.host.behaviors,
    });

    this.recorder = new SessionRecorder(this.world, this.storage, {
      sessionId: 'studio-live',
      label: 'Studio 实时录制',
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

  /** 当前产线指标（吞吐 / 积压 / 利用率 / 停机），全交给 analytics-core。 */
  metrics(): LineMetrics {
    return lineMetrics(this.world.getEventLog(), {
      bucketSize: Math.max(1 / 60, this.world.time / 20),
      enterTypes: ['parcel:enter'],
      exitTypes: ['parcel:exit'],
      busyStatuses: ['busy'],
      downStatuses: ['down'],
      until: this.world.time,
    });
  }

  /**
   * 方案分叉对比：以当前世界为基准，方案 A 用插件默认行为，
   * 方案 B 用收窄了检测区的同一行为，输出结构化差异。
   */
  compare(forkAt: number, horizon: number, zoneB: number): ScenarioDiff {
    return compareScenarios({
      scene: buildLineScene(LINE_PARAMS),
      forkAt,
      horizon,
      variants: [
        { id: 'A', label: '默认检测区', behaviors: this.host.behaviors },
        { id: 'B', label: '窄检测区', behaviors: [createLogisticsBehavior({ zoneHalfWidth: zoneB })] },
      ],
    });
  }
}
