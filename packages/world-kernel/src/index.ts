/**
 * `world-kernel` —— 零 UI 依赖的世界内核。
 *
 * 只依赖 `@twin-platform/scene-schema` 的类型，不碰 DOM、Solid、Three、数据库。
 * 因此同一个内核可以跑在浏览器主线程、Web Worker 和服务端回放任务里，
 * 三个地方算出同一个结果。
 */

export * from './behaviors';
export * from './clock';
export * from './entities';
export * from './events';
export * from './external';
export * from './path';
export * from './rng';
export * from './world';

export {
  TWIN_SCENE_VERSION,
  assertTwinScene,
  isTwinScene,
  migrateTwinScene,
  validateTwinScene,
  SceneValidationError,
  SCENE_MIGRATIONS,
  type SceneMigration,
  type SceneMigrationResult,
  type SceneValidationIssue,
  type TwinDataBinding,
  type TwinEntity,
  type TwinMotionBinding,
  type TwinScene,
  type TwinTransform,
  type TwinValue,
  type TwinVector3,
  type TwinVisualBinding,
} from '@twin-platform/scene-schema';
