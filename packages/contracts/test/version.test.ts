import { describe, expect, it } from 'vitest';
import { compareVersions, isVersion } from '../src/index.js';

describe('版本号', () => {
  it('格式', () => {
    for (const good of ['0.1.0', '1.2.3', '10.0.0-beta.1']) expect(isVersion(good)).toBe(true);
    for (const bad of ['', '1', '1.2', 'v1.2.3', '1.2.3.4', '1.2.3-', '1.2.3-a b', '1.2.3 ']) expect(isVersion(bad)).toBe(false);
  });

  it('比较：主、次、修订按数字比较；预发布版本小于正式版', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(() => compareVersions('x', '1.0.0')).toThrow();
  });
});
