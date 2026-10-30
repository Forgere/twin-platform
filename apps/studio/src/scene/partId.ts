interface PartHit {
  object: {
    name: string;
    userData: Record<string, unknown>;
  };
  instanceId?: number;
}

/** 射线命中对象的原始部件标识；不做语义映射，没有就明确返回空。 */
export function rawPartId(hit: PartHit): string | undefined {
  if (hit.object.name) return hit.object.name;
  const declared = hit.object.userData.partId;
  if (typeof declared === 'string' || typeof declared === 'number') return String(declared);
  return hit.instanceId === undefined ? undefined : String(hit.instanceId);
}
