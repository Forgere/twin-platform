/**
 * 插件配置用的轻量 Schema。
 *
 * 一期不引第三方校验库：配置只有标量、数组和对象三种形态，
 * 自己写 200 行就能覆盖，而且校验结果可以直接塞进 Studio 的表单提示。
 *
 * 只做"结构对不对"，不做"语义合不合法"——语义由插件在 `activate` 里自己判，
 * 因为只有插件知道两个字段之间是不是互斥。
 */

export type ConfigValue = string | number | boolean | ConfigValue[] | { [key: string]: ConfigValue };

export interface SchemaIssue {
  /** JSON 路径，例如 `config.speed`。 */
  path: string;
  message: string;
}

export interface ScalarSchema {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  /** 字符串的可选枚举。 */
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
}

export interface ObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, ValueSchema>;
  required?: readonly string[];
  /** 默认 true：未声明的字段被拒绝，防止拼错的配置静默生效。 */
  additionalProperties?: boolean;
}

export interface ArraySchema {
  type: 'array';
  description?: string;
  items: ValueSchema;
  minItems?: number;
  maxItems?: number;
}

export type ValueSchema = ScalarSchema | ObjectSchema | ArraySchema;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 校验配置；返回空数组表示通过。路径从 `root`（默认 `config`）开始。 */
export function validateConfig(schema: ValueSchema, value: unknown, root = 'config'): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  collectIssues(schema, value, root, issues);
  return issues;
}

export function isValidConfig(schema: ValueSchema, value: unknown): boolean {
  return validateConfig(schema, value).length === 0;
}

function collectIssues(schema: ValueSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (schema.type === 'object') {
    if (!isPlainObject(value)) {
      issues.push({ path, message: `应为对象，实际是 ${typeName(value)}。` });
      return;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) issues.push({ path: `${path}.${key}`, message: '必填字段缺失。' });
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties[key];
      if (!childSchema) {
        if (schema.additionalProperties === false) {
          issues.push({ path: `${path}.${key}`, message: '未声明的字段。' });
        }
        continue;
      }
      collectIssues(childSchema, child, `${path}.${key}`, issues);
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `应为数组，实际是 ${typeName(value)}。` });
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `至少需要 ${schema.minItems} 项，实际 ${value.length} 项。` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, message: `最多 ${schema.maxItems} 项，实际 ${value.length} 项。` });
    }
    value.forEach((item, index) => collectIssues(schema.items, item, `${path}[${index}]`, issues));
    return;
  }

  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, message: `应为有限数字，实际是 ${typeName(value)}。` });
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `不能小于 ${schema.minimum}，实际 ${value}。` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `不能大于 ${schema.maximum}，实际 ${value}。` });
    }
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') {
      issues.push({ path, message: `应为字符串，实际是 ${typeName(value)}。` });
      return;
    }
    if (schema.enum && !schema.enum.includes(value)) {
      issues.push({ path, message: `只能是 ${schema.enum.join(' / ')}，实际 "${value}"。` });
    }
    return;
  }

  if (typeof value !== 'boolean') {
    issues.push({ path, message: `应为布尔值，实际是 ${typeName(value)}。` });
  }
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value === 'object' ? '对象' : typeof value === 'number' ? '数字' : typeof value === 'string' ? '字符串' : typeof value === 'boolean' ? '布尔值' : String(typeof value);
}

/** 深拷贝 + 缺省填充：插件拿到的配置永远是可安全改写的私有副本。 */
export function withDefaults(schema: ValueSchema, defaults: ConfigValue | undefined, value: ConfigValue | undefined): ConfigValue {
  const base = defaults !== undefined ? (structuredClone(defaults) as ConfigValue) : undefined;
  if (value === undefined) return (base ?? {}) as ConfigValue;
  if (base === undefined) return structuredClone(value) as ConfigValue;
  if (Array.isArray(base) || Array.isArray(value)) return structuredClone(value) as ConfigValue;
  if (isPlainObject(base) && isPlainObject(value)) {
    return { ...base, ...value } as ConfigValue;
  }
  return structuredClone(value) as ConfigValue;
}
