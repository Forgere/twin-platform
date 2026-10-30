import { createRoot } from 'solid-js';
import type { StudioPresentation, StudioWorkspace, WorkspaceContext } from '@twin-platform/studio-sdk';

export interface WorkspaceHandle {
  readonly views: StudioWorkspace;
  dispose(): void;
}

/** 每个会话一个响应式 owner；宿主先卸载插槽，再释放共享状态。 */
export function createWorkspace(presentation: StudioPresentation | undefined, context: WorkspaceContext): WorkspaceHandle {
  return createRoot((dispose) => ({ views: presentation?.createWorkspace?.(context) ?? {}, dispose }));
}
