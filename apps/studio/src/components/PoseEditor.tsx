import { createEffect, createSignal, For, Show } from 'solid-js';
import type { TwinTransform, TwinVector3 } from '@twin-platform/scene-schema';

/**
 * 布局位姿编辑器：位置三轴（米）+ 朝向（绕 Y，弧度）。
 *
 * 为什么只给 Y 一个朝向输入框：渲染层对模型的朝向**只认 Y**（X/Z 是给模型工厂
 * 自己摆造型用的）。给用户一个改了没效果的输入框比不给更糟。
 *
 * 两条关键约束：
 * 1. 输入框绑的是**声明**（`props.getDeclared()`，来自场景文档），不是运行时位姿——
 *    仿真里跑动的货绝不该出现在布局输入框里；
 * 2. 只有 `props.revision` 变（= 一次编辑真的提交成功了）或换会话时才回填输入框。
 *    面板每 120ms 都在采样刷新，如果把输入值挂在那个节拍上，打字打到一半就会被
 *    回填冲掉——所以这里刻意**不读**面板的采样 tick。
 *
 * 它自己不碰世界：改完把一版新的位姿交出去，由父组件拼成 `setTransform` op。
 */
export const POSE_AXES = ['X', 'Y', 'Z'] as const;

/** 拷贝位姿并切断数组别名：op 要长期持有，不能跟调用方共享数组。 */
export function copyTransform(value: TwinTransform): TwinTransform {
  const out: TwinTransform = { position: [value.position[0], value.position[1], value.position[2]] };
  if (value.rotation) out.rotation = [value.rotation[0], value.rotation[1], value.rotation[2]];
  if (value.scale) out.scale = [value.scale[0], value.scale[1], value.scale[2]];
  return out;
}

const numberOrNull = (raw: string): number | null => {
  const trimmed = raw.trim();
  // 空串要单独挡掉：`Number('')` 是 0，用户刚清空还没打数字就会被当成"移到原点"。
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
};

export default function PoseEditor(props: {
  /** 换选中对象时父组件会重建整个编辑器，这里再读一次以防复用。 */
  entityId: string;
  /** 编辑版本号：一次提交成功 +1，用它把输入框回填成新的声明。 */
  revision: number;
  /** 从会话里取**声明**位姿（函数形式传入，便于在 effect 里建立响应式依赖）。 */
  getDeclared: () => TwinTransform | undefined;
  /** 不可编辑时的原因（人话，来自内核）；undefined 表示可编辑。 */
  locked?: string;
  /** 提交一版新位姿；父组件负责拼 op、应用、自动保存。 */
  onCommit: (next: TwinTransform) => void;
}) {
  const [pos, setPos] = createSignal<TwinVector3>([0, 0, 0]);
  const [yaw, setYaw] = createSignal(0);

  // 回填只挂两个触发点：编辑提交（revision）与会话/实体变化（getDeclared 内部读的信号）。
  // Solid 2 的 createEffect 是双参形态：compute 负责建立依赖，effectFn 拿结果做事。
  createEffect(
    () => {
      props.revision;
      props.entityId;
      return props.getDeclared();
    },
    (declared) => {
      if (!declared) return;
      // 函数形式回填：TwinVector3 是元组，直接传数组字面量会撞上 setter 的元组重载。
      setPos(() => [declared.position[0], declared.position[1], declared.position[2]]);
      setYaw(declared.rotation?.[1] ?? 0);
    },
  );

  const commitPosition = (axis: number, raw: string): void => {
    const value = numberOrNull(raw);
    if (value === null) return; // 正在输入 "-"、"1." 这类半截值，等用户敲完
    const declared = props.getDeclared();
    if (!declared) return;
    const position = copyTransform(declared).position;
    if (position[axis] === value) return;
    position[axis] = value;
    setPos(position);
    props.onCommit({ ...copyTransform(declared), position });
  };

  const commitYaw = (raw: string): void => {
    const value = numberOrNull(raw);
    if (value === null) return;
    const declared = props.getDeclared();
    if (!declared) return;
    if ((declared.rotation?.[1] ?? 0) === value) return;
    setYaw(value);
    // 声明里没有 rotation 时补 [0, y, 0]：渲染层只读 [1]，但补全比留半截更一致。
    props.onCommit({
      ...copyTransform(declared),
      rotation: [declared.rotation?.[0] ?? 0, value, declared.rotation?.[2] ?? 0],
    });
  };

  const disabled = props.locked !== undefined;

  return (
    <div class="pose-editor">
      <div class="pose-group">
        <span class="pose-title">位置（米）</span>
        <div class="pose-row">
          <For each={POSE_AXES}>
            {(axis, index) => (
              <label class="pose-field">
                <span>{axis}</span>
                <input
                  type="number"
                  step={0.1}
                  disabled={disabled}
                  value={pos()[index()]}
                  aria-label={`位置 ${axis}`}
                  onChange={(event) => commitPosition(index(), event.currentTarget.value)}
                />
              </label>
            )}
          </For>
        </div>
      </div>

      <div class="pose-group">
        <span class="pose-title">朝向（弧度，绕 Y）</span>
        <div class="pose-row">
          <label class="pose-field">
            <span>Y</span>
            <input
              type="number"
              step={0.01}
              disabled={disabled}
              value={yaw()}
              aria-label="朝向 Y"
              onChange={(event) => commitYaw(event.currentTarget.value)}
            />
          </label>
        </div>
      </div>

      <Show when={props.locked}>
        {(reason) => (
          <p class="pose-lock" title={reason()}>
            🔒 {reason()}
          </p>
        )}
      </Show>
    </div>
  );
}
