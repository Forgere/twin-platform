import { describe, expect, test } from 'bun:test';
import { authorizeApi, readApiToken } from './auth';

describe('readApiToken', () => {
  test('没设 / 空串 / 纯空白都算未启用', () => {
    expect(readApiToken({})).toBeNull();
    expect(readApiToken({ TWIN_API_TOKEN: '' })).toBeNull();
    expect(readApiToken({ TWIN_API_TOKEN: '   ' })).toBeNull();
  });

  test('有值时去掉首尾空白，内部空白保留', () => {
    expect(readApiToken({ TWIN_API_TOKEN: '  s3cret  ' })).toBe('s3cret');
    expect(readApiToken({ TWIN_API_TOKEN: 'a b' })).toBe('a b');
  });
});

describe('authorizeApi', () => {
  test('未启用鉴权时一律放行（哪怕带着错误 token）', () => {
    expect(authorizeApi(null, null)).toEqual({ ok: true });
    expect(authorizeApi('Bearer whatever', null)).toEqual({ ok: true });
  });

  test('启用后没带头 → 401，并说明缺什么', () => {
    const decision = authorizeApi(null, 's3cret');
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(401);
    expect(decision.message).toContain('Bearer');
  });

  test('格式不对（不是 Bearer）→ 401', () => {
    expect(authorizeApi('Basic c2VjcmV0', 's3cret').ok).toBe(false);
    expect(authorizeApi('Bearer', 's3cret').ok).toBe(false);
    expect(authorizeApi('Bearer    ', 's3cret').ok).toBe(false);
    expect(authorizeApi('', 's3cret').ok).toBe(false);
  });

  test('token 不对 → 401', () => {
    const decision = authorizeApi('Bearer wrong', 's3cret');
    expect(decision.ok).toBe(false);
    expect(decision.status).toBe(401);
    expect(decision.message).toBe('API token 无效。');
  });

  test('token 对 → 放行；scheme 大小写不敏感，首尾空白容忍', () => {
    expect(authorizeApi('Bearer s3cret', 's3cret').ok).toBe(true);
    expect(authorizeApi('bearer s3cret', 's3cret').ok).toBe(true);
    expect(authorizeApi('  Bearer   s3cret  ', 's3cret').ok).toBe(true);
  });

  test('Bearer 后的 token 含空格时按整体比较（不被 trim 掉内部空白）', () => {
    expect(authorizeApi('Bearer  a b  ', 'a b').ok).toBe(true);
    expect(authorizeApi('Bearer  a b  ', 'a').ok).toBe(false);
  });

  test('长度不同的 token 不会被当成相等', () => {
    expect(authorizeApi('Bearer s3cret-plus-more', 's3cret').ok).toBe(false);
    expect(authorizeApi('Bearer s3', 's3cret').ok).toBe(false);
  });
});
