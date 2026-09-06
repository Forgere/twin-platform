export const TWIN_SCENE_VERSION = 1 as const;

export interface TwinTransform {
  position: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
}

export interface TwinEntity {
  id: string;
  kind: string;
  transform: TwinTransform;
  capabilities: string[];
  config?: Record<string, unknown>;
}

export interface TwinScene {
  version: typeof TWIN_SCENE_VERSION;
  id: string;
  name: string;
  entities: TwinEntity[];
}

export interface SceneValidationIssue {
  path: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isVector3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'number' && Number.isFinite(part));

export function validateTwinScene(input: unknown): SceneValidationIssue[] {
  if (!isRecord(input)) return [{ path: '$', message: '场景必须是对象。' }];
  const issues: SceneValidationIssue[] = [];
  if (input.version !== TWIN_SCENE_VERSION) issues.push({ path: '$.version', message: `必须是版本 ${TWIN_SCENE_VERSION}。` });
  if (typeof input.id !== 'string' || input.id.length === 0) issues.push({ path: '$.id', message: '必须是非空字符串。' });
  if (typeof input.name !== 'string' || input.name.length === 0) issues.push({ path: '$.name', message: '必须是非空字符串。' });
  if (!Array.isArray(input.entities)) return [...issues, { path: '$.entities', message: '必须是实体数组。' }];
  const ids = new Set<string>();
  input.entities.forEach((entity, index) => {
    const path = `$.entities[${index}]`;
    if (!isRecord(entity)) { issues.push({ path, message: '必须是对象。' }); return; }
    if (typeof entity.id !== 'string' || entity.id.length === 0) issues.push({ path: `${path}.id`, message: '必须是非空字符串。' });
    else if (ids.has(entity.id)) issues.push({ path: `${path}.id`, message: '实体 id 必须唯一。' });
    else ids.add(entity.id);
    if (typeof entity.kind !== 'string' || entity.kind.length === 0) issues.push({ path: `${path}.kind`, message: '必须是非空字符串。' });
    if (!isRecord(entity.transform) || !isVector3(entity.transform.position)) issues.push({ path: `${path}.transform.position`, message: '必须是三个有限数字。' });
    if (!Array.isArray(entity.capabilities) || entity.capabilities.some((item) => typeof item !== 'string')) issues.push({ path: `${path}.capabilities`, message: '必须是字符串数组。' });
  });
  return issues;
}

export function isTwinScene(input: unknown): input is TwinScene {
  return validateTwinScene(input).length === 0;
}
