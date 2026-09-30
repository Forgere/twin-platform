export { selectPresentation } from './registry';

import type { Accessor, Component } from 'solid-js';
import type { PluginHost } from '@twin-platform/plugin-sdk';
import type { ReplayController } from '@twin-platform/replay-core';
import type { TwinScene, TwinVector3, TwinWorld } from '@twin-platform/world-kernel';
import type { Object3D, Scene } from 'three';

/** 浏览器展示所需的会话端口；领域插件不依赖 Studio 的实现类。 */
export interface StudioSessionPort {
  readonly world: TwinWorld;
  readonly controller: Pick<ReplayController, 'playing' | 'play' | 'pause' | 'stepFrames'>;
  readonly host: Pick<PluginHost, 'decisions'>;
  readonly request?: StudioRequest;
}

/** path 是同源 /api 路径；地址和鉴权由宿主决定。 */
export type StudioRequest = (path: string, init?: RequestInit) => Promise<Response>;

export interface InspectorTab {
  readonly id: string;
  readonly icon: string;
  readonly label: string;
}

export interface InspectorProfile {
  readonly tabs: readonly InspectorTab[];
  readonly defaultTab: string;
  readonly label?: string;
}

export interface WorkspaceContext {
  readonly session: StudioSessionPort;
  readonly tick: Accessor<number>;
  closeInspector(): void;
}

/** 同一会话内共享状态，宿主分别在已有布局的插槽挂载，不增加 DOM 包装。 */
export interface StudioWorkspace {
  readonly Stage?: Component;
  readonly Overlay?: Component;
  readonly panels?: Readonly<Record<string, Component>>;
}

export interface EntityMeshInput {
  readonly id: string;
  readonly kind: string;
  readonly visual?: { kind?: string; color?: string; size?: TwinVector3 };
  readonly transform: { position: TwinVector3; rotation?: TwinVector3 };
  readonly capabilities?: readonly string[];
  readonly config?: Record<string, unknown>;
}

export interface SceneViewContext {
  readonly world: Pick<TwinWorld, 'time' | 'getEntity' | 'listEntities'>;
  readonly scene: Scene;
  /** 由宿主维护，插件不缓存网格引用；重建/seek 后仍访问这张表。 */
  readonly meshes: ReadonlyMap<string, Object3D>;
}

export interface CameraView {
  readonly eye: TwinVector3;
  readonly target: TwinVector3;
}

/** 宿主拥有实体网格，Adapter 只释放自己添加的附属对象。 */
export interface ScenePresentation {
  readonly showHelpers?: boolean;
  buildEntity(entity: EntityMeshInput): Object3D | undefined;
  overview?(): CameraView | undefined;
  /** 每帧在世界增删/位姿应用后调用；包括暂停帧，不推进世界。 */
  update(): void;
  /** 实体网格重建前调用，丢弃由旧网格派生的缓存。 */
  reset?(): void;
  dispose(): void;
}

/** 一个领域的浏览器展示模块；纯仿真插件不需要导入此入口。 */
export interface StudioPresentation {
  readonly pluginId: string;
  matches(scene: TwinScene): boolean;
  readonly inspector: InspectorProfile;
  createWorkspace?(context: WorkspaceContext): StudioWorkspace;
  createScene?(context: SceneViewContext): ScenePresentation;
}
