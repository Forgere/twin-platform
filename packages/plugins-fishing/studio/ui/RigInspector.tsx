import { createMemo, Show } from 'solid-js';
import type { StudioSessionPort } from '@twin-platform/studio-sdk';
import { readRig } from './fishingWorld';
import FishingSandbox from './FishingSandbox';
import DecisionPanel from './DecisionPanel';
import RigSettings from './RigSettings';

/** 右侧保留完整配置、剖面与记录；中间只提供逐项快捷调整。 */
export default function RigInspector(props: { session: StudioSessionPort; tick: number }) {
  const rig = createMemo(() => {
    props.tick;
    return readRig(props.session);
  }, { name: 'fishing.inspector.rig' });

  return (
    <section aria-label="钓组">
      <h2>🎣 钓组</h2>
      <Show when={rig()} fallback={<p class="plugin-note">当前场景没有钓组实体（rig-01）。</p>}>
        {(current) => (
          <>
            <FishingSandbox session={props.session} tick={props.tick} />
            <Show when={current().error}>{(message) => <p class="plugin-errors">{message()}</p>}</Show>
            <RigSettings session={props.session} rig={current()} />
            <details class="rig-more">
              <summary>判断者记录与校准</summary>
              <DecisionPanel session={props.session} />
            </details>
          </>
        )}
      </Show>
    </section>
  );
}
