/** 从 `unknown`（实体 config / attrs）里安全取标量。 */
export const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

export const str = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

export const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
