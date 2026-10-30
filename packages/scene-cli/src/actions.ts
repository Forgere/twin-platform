import type { TwinSceneAction } from '@twin-platform/scene-runner';
import type { JsonValue } from '@twin-platform/scene-spec';
import type { TwinWorld } from '@twin-platform/world-kernel';

export interface ActionSpec {
  /** 第几个固定步之前应用（优先）。 */
  readonly atStep?: number;
  /** 仿真秒；换算成步数，必须落在整数步上。 */
  readonly at?: number;
  readonly id: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

const isJsonPrimitive = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null;

const asString = (params: Readonly<Record<string, unknown>>, key: string): string => {
  const value = params[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`动作参数 ${key} 必须是非空字符串。`);
  return value;
};

const asNumber = (params: Readonly<Record<string, unknown>>, key: string): number => {
  const value = params[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`动作参数 ${key} 必须是有限数字。`);
  return value;
};

const asVector = (params: Readonly<Record<string, unknown>>, key: string): [number, number, number] => {
  const value = params[key];
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== 'number' || !Number.isFinite(part))) {
    throw new Error(`动作参数 ${key} 必须是三个有限数字。`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
};

const asPayload = (params: Readonly<Record<string, unknown>>, key: string): Record<string, string | number | boolean> | undefined => {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`动作参数 ${key} 必须是对象。`);
  const out: Record<string, string | number | boolean> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[name] = item;
    else throw new Error(`动作参数 ${key}.${name} 必须是字符串 / 数字 / 布尔。`);
  }
  return out;
};

/**
 * 把 JSON 动作脚本翻译成 runner 的动作。
 *
 * 动作只通过内核公开接口改世界，且参数全部可序列化——这样才能进 trace、
 * 被回放复用、被审计配对（"这个旋钮到底有没有效果"）。
 */
export function buildTwinActions(specs: readonly ActionSpec[], step: number): TwinSceneAction[] {
  return specs.map((spec, index) => {
    const atStep = spec.atStep ?? (spec.at === undefined ? undefined : Math.round(spec.at / step));
    if (atStep === undefined) throw new Error(`动作 #${index} 缺少 atStep 或 at。`);
    if (spec.atStep !== undefined && spec.at !== undefined && Math.abs(spec.at / step - spec.atStep) > 1e-9) {
      throw new Error(`动作 #${index} 的 atStep 与 at 不一致。`);
    }
    if (!Number.isInteger(atStep) || atStep < 0) throw new Error(`动作 #${index} 的步数必须是非负整数。`);
    const params = spec.params ?? {};
    const serializable: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(params)) {
      if (!isJsonPrimitive(value) && typeof value !== 'object') throw new Error(`动作 #${index} 的 ${key} 不可序列化。`);
      serializable[key] = (Array.isArray(value) ? [...value] : value) as JsonValue;
    }

    switch (spec.id) {
      case 'set-attr': {
        const entityId = asString(params, 'entityId');
        const key = asString(params, 'key');
        const value = params['value'];
        if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
          throw new Error(`动作 #${index} 的 value 必须是字符串 / 数字 / 布尔。`);
        }
        return {
          atStep,
          id: spec.id,
          params: serializable,
          apply: (world: TwinWorld) => world.setAttr(entityId, key, value),
        };
      }
      case 'dispatch': {
        const type = asString(params, 'type');
        const entityId = typeof params['entityId'] === 'string' ? params['entityId'] : undefined;
        const detail = typeof params['detail'] === 'string' ? params['detail'] : undefined;
        const payload = asPayload(params, 'payload');
        return {
          atStep,
          id: spec.id,
          params: serializable,
          apply: (world: TwinWorld) => world.dispatch(type, { entityId, detail, payload }),
        };
      }
      case 'move': {
        const entityId = asString(params, 'entityId');
        const distance = asNumber(params, 'distance');
        return {
          atStep,
          id: spec.id,
          params: serializable,
          apply: (world: TwinWorld) => {
            world.move(entityId, distance);
          },
        };
      }
      case 'set-transform': {
        const entityId = asString(params, 'entityId');
        const position = asVector(params, 'position');
        const rotation = params['rotation'] === undefined ? undefined : asVector(params, 'rotation');
        const scale = params['scale'] === undefined ? undefined : asVector(params, 'scale');
        return {
          atStep,
          id: spec.id,
          params: serializable,
          apply: (world: TwinWorld) => {
            const entity = world.getEntity(entityId);
            if (!entity) throw new Error(`实体 ${entityId} 不存在，set-transform 无法执行。`);
            world.applySceneOps([
              {
                type: 'setTransform',
                entityId,
                before: { ...entity.transform, position: [...entity.transform.position] },
                after: { position, rotation, scale },
              },
            ]);
          },
        };
      }
      default:
        throw new Error(`未知动作 ${spec.id}；可用：set-attr / dispatch / move / set-transform。`);
    }
  });
}
