import type { TwinEntity, TwinScene, TwinTransform, TwinValue, TwinVector3 } from '@twin-platform/scene-schema';
import { migrateTwinScene } from '@twin-platform/scene-schema';
import type { BehaviorContext, WorldBehavior } from './behaviors';
import { FixedStepClock } from './clock';
import { createEntityState, toSnapshotEntity, type EntityMotionState, type WorldEntityState, type WorldSnapshotEntity } from './entities';
import { EventLog, type WorldEvent, type WorldEventInput } from './events';
import {
  resolveExternalMotion,
  type DataMode,
  type EntityDataSource,
  type ExternalEntityState,
  type ExternalFrame,
  type ExternalSignal,
} from './external';
import { buildPath, samplePath } from './path';
import { createRng, type Rng } from './rng';

/**
 * 世界内核。
 *
 * 深 Module：对外只有 `loadScene / advance / step / dispatch / seek / snapshot` 这一层
 * 薄接口，Three、Solid、SQL、CSV、MQTT 全在它外面当 Adapter。内核本身不认识
 * "输送线""质检""缓存"这些词——那是行为插件的事（见 `behaviors.ts`）。
 *
 * 确定性三条铁律（从 r3f-tools 的 FactorySim 继承）：
 * 1. 时间只走固定步长，渲染帧率抖动不会改变仿真结果；
 * 2. 随机只来自注入的种子 RNG，内核里没有 `Math.random()`；
 * 3. 遍历顺序固定（场景顺序 + 行为注册顺序），顺序即契约。
 */

export interface TwinWorldOptions {
  /** 种子。默认 1：未显式给种子也必须可复现。 */
  seed?: number;
  /** 固定步长（秒），默认 1/60。 */
  step?: number;
  /** 内存事件日志容量。 */
  eventLogSize?: number;
  /**
   * 单次 `advance` 最多补多少步（默认 8）。
   *
   * 交互演示下卡顿后补太多步会雪崩；但回放要跑到 10×、100×，一帧就得吃掉几十步。
   * 所以回放场景（`replay-core`）会显式调大这个值——步长本身没变，确定性不受影响。
   */
  maxStepsPerAdvance?: number;
  mode?: DataMode;
  behaviors?: readonly WorldBehavior[];
}

export interface WorldSnapshot {
  sceneId: string;
  /** 快照时刻的下一条事件 sequence，回放从此续算。 */
  sequence: number;
  time: number;
  step: number;
  seed: number;
  rngState: number;
  mode: DataMode;
  entities: WorldSnapshotEntity[];
}

export interface EntityDelta {
  id: string;
  transform?: TwinTransform;
  attrs?: Record<string, TwinValue>;
  status?: string;
}

/** 一帧里"变化的部分"——渲染层只消费它，绝不自己重算状态。 */
export interface FrameDelta {
  time: number;
  sequence: number;
  added: string[];
  removed: string[];
  changed: EntityDelta[];
}

const DEFAULT_STEP = 1 / 60;

export class TwinWorld {
  readonly scene: TwinScene;
  private readonly clock: FixedStepClock;
  private readonly log: EventLog;
  private readonly behaviors: WorldBehavior[];
  private readonly entities = new Map<string, WorldEntityState>();
  private readonly fed = new Map<string, ExternalEntityState>();
  private readonly overrides = new Map<string, EntityDataSource>();
  private rng: Rng;
  private seedValue: number;
  private dataMode: DataMode;
  private currentTime = 0;
  private stepCountValue = 0;
  private dirty = new Set<string>();
  private added = new Set<string>();
  private removed = new Set<string>();

  constructor(scene: TwinScene, options: TwinWorldOptions = {}) {
    this.scene = scene;
    this.clock = new FixedStepClock({
      step: options.step ?? DEFAULT_STEP,
      maxStepsPerAdvance: options.maxStepsPerAdvance ?? 8,
    });
    this.log = new EventLog(options.eventLogSize ?? 4096);
    this.behaviors = [...(options.behaviors ?? [])];
    this.seedValue = options.seed ?? 1;
    this.rng = createRng(this.seedValue);
    this.dataMode = options.mode ?? 'sim';
    this.rebuild();
  }

  /** 从任意历史版本的场景 JSON 建世界：先迁移再校验，失败直接抛，不留半截状态。 */
  static fromScene(input: unknown, options: TwinWorldOptions = {}): TwinWorld {
    return new TwinWorld(migrateTwinScene(input).scene, options);
  }

  get time(): number {
    return this.currentTime;
  }

  /** 固定步长（秒）。 */
  get stepSize(): number {
    return this.clock.step;
  }

  get stepCount(): number {
    return this.stepCountValue;
  }

  get seed(): number {
    return this.seedValue;
  }

  /** 当前数据模式。 */
  get dataModeValue(): DataMode {
    return this.dataMode;
  }

  // ---------------------------------------------------------------------------
  // 推进
  // ---------------------------------------------------------------------------

  /**
   * 吃真实帧间隔，内部切成整数个固定步长执行，返回合并后的帧差量。
   * 卡顿时最多补 `maxStepsPerAdvance` 步，宁可慢放也不雪崩。
   */
  advance(realDelta: number): FrameDelta {
    const steps = this.clock.advance(realDelta);
    const frames: FrameDelta[] = [];
    for (let i = 0; i < steps; i += 1) frames.push(this.step());
    return frames.length === 0 ? this.emptyFrame() : mergeFrames(frames);
  }

  /** 手动推进一个固定步长。测试与确定性仿真回放用这个，不要用 `advance`。 */
  step(dt: number = this.clock.step): FrameDelta {
    this.stepOnce(dt);
    return this.flushFrame();
  }

  /**
   * 一次推进 `count` 个固定步长，只返回最后一帧的差量。
   *
   * 高倍速回放时渲染 Adapter 本来就不需要中间帧，但世界事件一条都不能少——
   * 这里跳过的是"差量的合并与传输"，不是世界推进。
   */
  runSteps(count: number): FrameDelta {
    if (!Number.isInteger(count) || count < 0) throw new Error('步数必须是非负整数。');
    for (let i = 0; i < count; i += 1) this.stepOnce(this.clock.step);
    return count === 0 ? this.emptyFrame() : this.flushFrame();
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  dispatch(type: string, options: Omit<WorldEventInput, 'type'> = {}): WorldEvent {
    return this.log.append({ type, ...options }, this.currentTime);
  }

  getEventLog(): readonly WorldEvent[] {
    return this.log.all();
  }

  /** 取出尚未落库的事件；由 storage Adapter 写库成功后丢弃。 */
  drainEvents(): WorldEvent[] {
    return this.log.takePending();
  }

  // ---------------------------------------------------------------------------
  // 实体读写
  // ---------------------------------------------------------------------------

  listEntities(): readonly WorldEntityState[] {
    return [...this.entities.values()];
  }

  getEntity(id: string): WorldEntityState | undefined {
    return this.entities.get(id);
  }

  addEntity(entity: TwinEntity): WorldEntityState {
    if (this.entities.has(entity.id)) throw new Error(`实体 ${entity.id} 已存在。`);
    const state = createEntityState(entity, buildMotionState);
    this.entities.set(entity.id, state);
    this.added.add(entity.id);
    this.dirty.add(entity.id);
    return state;
  }

  removeEntity(id: string): boolean {
    if (!this.entities.delete(id)) return false;
    this.removed.add(id);
    this.dirty.delete(id);
    return true;
  }

  setAttr(id: string, key: string, value: TwinValue): void {
    const state = this.require(id);
    state.attrs[key] = value;
    this.dirty.add(id);
  }

  setStatus(id: string, status: string | undefined): void {
    const state = this.require(id);
    state.status = status;
    this.dirty.add(id);
  }

  setTransform(id: string, transform: TwinTransform): void {
    const state = this.require(id);
    state.transform = { ...transform, position: [...transform.position] };
    this.dirty.add(id);
  }

  /** 沿实体自身路径推进；无路径返回 false。 */
  move(id: string, distanceDelta: number): boolean {
    const state = this.entities.get(id);
    if (!state?.motion) return false;
    this.applyDistance(state, state.motion.distance + distanceDelta);
    return true;
  }

  // ---------------------------------------------------------------------------
  // 数据模式与外部数据
  // ---------------------------------------------------------------------------

  setMode(mode: DataMode): void {
    this.dataMode = mode;
    this.dispatch('world:mode', { detail: `mode → ${mode}`, payload: { mode } });
  }

  /** hybrid 模式下逐实体指定数据来源。 */
  setEntityDataSource(id: string, source: EntityDataSource): void {
    this.overrides.set(id, source);
    const state = this.entities.get(id);
    if (state) state.dataSource = this.effectiveSource(id);
  }

  getEntityDataSource(id: string): EntityDataSource {
    return this.effectiveSource(id);
  }

  /**
   * 接收一帧外部数据。只登记，不立即改写世界：真正的换算发生在 `step()` 里，
   * 这样每一帧世界状态都有一个明确的、可回放的时间点。
   */
  ingestExternalFrame(frame: ExternalFrame): void {
    for (const state of frame.entities) this.fed.set(state.id, state);
  }

  // ---------------------------------------------------------------------------
  // 快照 / 恢复 / 重置
  // ---------------------------------------------------------------------------

  snapshot(): WorldSnapshot {
    return {
      sceneId: this.scene.id,
      sequence: this.log.nextSequence,
      time: this.currentTime,
      step: this.clock.step,
      seed: this.seedValue,
      rngState: this.rng.getState(),
      mode: this.dataMode,
      entities: [...this.entities.values()].map(toSnapshotEntity),
    };
  }

  restore(snapshot: WorldSnapshot): void {
    this.currentTime = snapshot.time;
    this.stepCountValue = Math.round(snapshot.time / this.clock.step);
    this.dataMode = snapshot.mode;
    this.seedValue = snapshot.seed;
    this.rng = createRng(snapshot.seed);
    this.rng.setState(snapshot.rngState);

    const kept = new Set(snapshot.entities.map((entity) => entity.id));
    for (const id of [...this.entities.keys()]) if (!kept.has(id)) this.entities.delete(id);

    for (const record of snapshot.entities) {
      const state = this.entities.get(record.id);
      if (!state) {
        this.entities.set(record.id, {
          id: record.id,
          kind: record.kind,
          capabilities: [],
          baseTransform: { ...record.transform, position: [...record.transform.position] },
          transform: { ...record.transform, position: [...record.transform.position] },
          attrs: { ...record.attrs },
          config: {},
          status: record.status,
          dataSource: record.dataSource,
        });
        continue;
      }
      state.transform = { ...record.transform, position: [...record.transform.position] };
      state.attrs = { ...record.attrs };
      state.status = record.status;
      state.dataSource = record.dataSource;
      if (state.motion && record.motionDistance !== undefined) state.motion.distance = record.motionDistance;
      this.dirty.add(record.id);
    }
  }

  /**
   * 恢复快照并把事件日志游标对齐到快照的 sequence——回放与分叉的标准入口。
   *
   * 与 `restore` 的差别：`restore` 只搬状态，事件日志继续往后编号；重算会让同一条
   * 事件以"未来的编号"再写一遍。分叉必须调用这个方法，再配合
   * `EventRepository.truncateAfter`，事件流才不会出现重复或空洞。
   */
  restoreFrom(snapshot: WorldSnapshot): void {
    this.restore(snapshot);
    this.log.resetTo(snapshot.sequence);
    this.dirty.clear();
    this.added.clear();
    this.removed.clear();
  }

  /** 回到 t=0。不传 seed 则重放同一集，传了就换一集但依然可复现。 */
  reset(seed?: number): void {
    this.seedValue = seed ?? this.seedValue;
    this.rng = createRng(this.seedValue);
    this.currentTime = 0;
    this.stepCountValue = 0;
    this.clock.reset();
    this.log.clear();
    this.fed.clear();
    this.overrides.clear();
    this.dirty.clear();
    this.added.clear();
    this.removed.clear();
    this.rebuild();
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  private rebuild(): void {
    this.entities.clear();
    for (const entity of this.scene.entities) this.entities.set(entity.id, createEntityState(entity, buildMotionState));
    for (const [id, source] of this.overrides) {
      const state = this.entities.get(id);
      if (state) state.dataSource = source;
    }
  }

  /** 推进一个固定步长的全部工作，不含差量刷新（`runSteps` 只在最后刷一次）。 */
  private stepOnce(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) throw new Error('dt 必须是正数。');
    this.currentTime += dt;
    this.stepCountValue += 1;

    this.advanceSimMotion(dt);
    this.applyExternalFeed();
    for (const behavior of this.behaviors) behavior.step(this.context(dt));
  }

  private require(id: string): WorldEntityState {
    const state = this.entities.get(id);
    if (!state) throw new Error(`实体 ${id} 不存在。`);
    return state;
  }

  private effectiveSource(id: string): EntityDataSource {
    if (this.dataMode === 'sim') return 'sim';
    if (this.dataMode === 'external') return 'external';
    return this.overrides.get(id) ?? 'sim';
  }

  private advanceSimMotion(dt: number): void {
    for (const state of this.entities.values()) {
      if (!state.motion || this.effectiveSource(state.id) !== 'sim') continue;
      this.applyDistance(state, state.motion.distance + state.motion.speed * dt);
    }
  }

  private applyDistance(state: WorldEntityState, distance: number): void {
    const motion = state.motion;
    if (!motion) return;
    const { path, loop } = motion;
    let next = distance;
    if (loop === 'repeat') {
      if (path.length > 0) next = ((next % path.length) + path.length) % path.length;
    } else {
      next = Math.min(Math.max(next, 0), path.length);
    }
    motion.distance = next;
    const sample = samplePath(path, next);
    state.transform = { ...state.transform, position: sample.position, rotation: withYaw(state.transform.rotation, sample.heading) };
    this.dirty.add(state.id);
  }

  private applyExternalFeed(): void {
    if (this.dataMode === 'sim') return;
    for (const [id, fed] of this.fed) {
      if (this.effectiveSource(id) !== 'external') continue;
      const state = this.ensureExternalEntity(id, fed);
      if (!state) continue;

      if (fed.attrs) {
        state.attrs = { ...fed.attrs };
        this.dirty.add(id);
      }

      const signal = fed.signal ?? defaultSignal(fed, state);
      if (!signal) continue;
      const resolved = resolveExternalMotion(signal, {
        time: this.currentTime,
        pathLength: state.motion?.path.length ?? 0,
        speed: state.motion?.speed ?? 0,
        origin: state.baseTransform.position,
        yaw: state.baseTransform.rotation?.[1] ?? 0,
      });

      if (resolved.distance !== undefined && state.motion) {
        this.applyDistance(state, resolved.distance);
      } else if (resolved.position) {
        state.transform = {
          ...state.transform,
          position: resolved.position,
          rotation: withYaw(state.transform.rotation, resolved.heading ?? 0),
        };
        this.dirty.add(id);
      }
    }
  }

  private ensureExternalEntity(id: string, fed: ExternalEntityState): WorldEntityState | undefined {
    const existing = this.entities.get(id);
    if (existing) {
      existing.dataSource = 'external';
      return existing;
    }
    const transform: TwinTransform = fed.transform ?? { position: [0, 0, 0] };
    this.entities.set(id, {
      id,
      kind: fed.kind ?? 'unknown',
      capabilities: [],
      baseTransform: { ...transform, position: [...transform.position] },
      transform: { ...transform, position: [...transform.position] },
      attrs: { ...(fed.attrs ?? {}) },
      config: {},
      dataSource: 'external',
    });
    this.added.add(id);
    this.dispatch('entity:external-bound', { entityId: id, detail: `外部实体 ${id} 接入` });
    return this.entities.get(id);
  }

  private context(dt: number): BehaviorContext {
    const entities = [...this.entities.values()];
    return {
      dt,
      time: this.currentTime,
      rng: this.rng,
      entities,
      entity: (id) => this.entities.get(id),
      setAttr: (id, key, value) => this.setAttr(id, key, value),
      setStatus: (id, status) => this.setStatus(id, status),
      setTransform: (id, transform) => this.setTransform(id, transform),
      move: (id, distanceDelta) => this.move(id, distanceDelta),
      emit: (type, options) => this.dispatch(type, options ?? {}),
    };
  }

  private emptyFrame(): FrameDelta {
    return { time: this.currentTime, sequence: this.log.nextSequence, added: [], removed: [], changed: [] };
  }

  private flushFrame(): FrameDelta {
    const changed: EntityDelta[] = [];
    for (const id of this.dirty) {
      const state = this.entities.get(id);
      if (!state) continue;
      changed.push({
        id,
        transform: { ...state.transform, position: [...state.transform.position] },
        attrs: { ...state.attrs },
        status: state.status,
      });
    }
    const frame: FrameDelta = {
      time: this.currentTime,
      sequence: this.log.nextSequence,
      added: [...this.added],
      removed: [...this.removed],
      changed,
    };
    this.dirty.clear();
    this.added.clear();
    this.removed.clear();
    return frame;
  }
}

function withYaw(rotation: TwinVector3 | undefined, yaw: number): TwinVector3 {
  const next: TwinVector3 = rotation ? [...rotation] : [0, 0, 0];
  next[1] = yaw;
  return next;
}

function buildMotionState(entity: TwinEntity): EntityMotionState | undefined {
  const binding = entity.motion;
  if (!binding || binding.points.length < 2) return undefined;
  return {
    path: buildPath(binding.points, { cornerRadius: binding.cornerRadius ?? 0.45, arcSegments: binding.arcSegments ?? 6 }),
    distance: 0,
    speed: binding.speed,
    loop: binding.loop ?? 'clamp',
  };
}

/** 外部帧没给 signal 时：给了 transform 就当世界位姿，否则无法换算。 */
function defaultSignal(fed: ExternalEntityState, state: WorldEntityState): ExternalSignal | undefined {
  if (fed.transform) return { kind: 'pose', frame: 'world', position: fed.transform.position, heading: fed.transform.rotation?.[1] ?? 0 };
  return state.motion ? { kind: 'progress', progress: 0 } : undefined;
}

function mergeFrames(frames: FrameDelta[]): FrameDelta {
  const last = frames[frames.length - 1];
  const merged: FrameDelta = { time: last?.time ?? 0, sequence: last?.sequence ?? 0, added: [], removed: [], changed: [] };
  const changedById = new Map<string, EntityDelta>();
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const frame of frames) {
    for (const id of frame.added) added.add(id);
    for (const id of frame.removed) {
      removed.add(id);
      changedById.delete(id);
    }
    for (const delta of frame.changed) changedById.set(delta.id, delta);
  }
  merged.added = [...added].filter((id) => !removed.has(id));
  merged.removed = [...removed];
  merged.changed = [...changedById.values()];
  return merged;
}
