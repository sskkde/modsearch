import { describe, expect, it } from 'vitest';
import { quotaClassOf, splitApiKeys } from './apiKeys.ts';

describe('splitApiKeys', () => {
  it('trims comma-separated keys, preserves order, and drops empty items', () => {
    expect(splitApiKeys(' first-key , , second-key,,third-key ')).toEqual([
      'first-key',
      'second-key',
      'third-key',
    ]);
    expect(splitApiKeys(', ,')).toEqual([]);
    expect(splitApiKeys(undefined)).toEqual([]);
  });
});

describe('quotaClassOf', () => {
  // The cooldown classifier only reads the neutral English terms. Everything
  // here exists so a vendor answering in its own language still reaches it.
  it('reads English quota wording', () => {
    expect(quotaClassOf('You are out of credits')).toBe('quota');
    expect(quotaClassOf('quota exceeded')).toBe('quota');
  });

  it('reads the Chinese wording the Chinese-market engines answer with', () => {
    expect(quotaClassOf('搜索套餐额度不足')).toBe('quota');
    expect(quotaClassOf('配额已用尽')).toBe('quota');
    expect(quotaClassOf('账户余额不足')).toBe('quota');
  });

  it('keeps a per-second rate limit transient', () => {
    expect(quotaClassOf('rate limit exceeded')).toBe('rate');
    expect(quotaClassOf('请求频率超过限制')).toBe('rate');
    expect(quotaClassOf('HTTP 429 Too Many Requests')).toBe('rate');
  });

  it('returns null for wording that is neither', () => {
    expect(quotaClassOf('invalid api key')).toBe(null);
    expect(quotaClassOf('Authorization failed')).toBe(null);
    expect(quotaClassOf('参数错误')).toBe(null);
  });
});
