import { createSignal } from 'solid-js';
import type { StudioSessionPort, StudioWorkspace, WorkspaceContext } from '@twin-platform/studio-sdk';
import FishingAssistant from './ui/FishingAssistant';
import FishingControls from './ui/FishingControls';
import FishingHud from './ui/FishingHud';
import RigInspector from './ui/RigInspector';
import { readRig } from './ui/fishingWorld';
import './ui/fishing.css';

/** 每个会话独立持有开钓流程，宿主只挂载插槽，不解释钓场状态。 */
export function createFishingWorkspace(context: WorkspaceContext): StudioWorkspace {
  const session = context.session;
  const [setup, setSetup] = createSignal<StudioSessionPort | undefined>(
    readRig(session)?.wizardDone ? undefined : session,
    { name: 'fishing.workspace.setup' },
  );
  const openSetup = (): void => {
    context.closeInspector();
    setSetup(session);
  };

  return {
    Stage: () => <FishingControls session={session} tick={context.tick()} />,
    Overlay: () => (
      <>
        <FishingHud session={session} tick={context.tick()} />
        <FishingAssistant
          session={session}
          tick={context.tick()}
          setup={setup()}
          onOpen={context.closeInspector}
          onSetup={openSetup}
          onSetupClose={() => setSetup(undefined)}
        />
      </>
    ),
    panels: {
      rig: () => <RigInspector session={session} tick={context.tick()} />,
    },
  };
}
