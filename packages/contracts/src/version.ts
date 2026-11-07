/**
 * 版本号（contracts 4.1、4.5）：CLI 与 Skill 的版本、Skill 包版本都用 `主.次.修订[-预发布]`。
 */

/** 版本号格式。长度受限，可以安全地存库和显示。 */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,24})?$/;

export function isVersion(value: string): boolean {
  return VERSION_PATTERN.test(value);
}

/**
 * 比较两个版本号：a < b 返回负数，相等返回 0，a > b 返回正数。
 * 先比主、次、修订；相同时，带预发布标记的版本小于不带的；两个都带时按字符串比较。
 */
export function compareVersions(a: string, b: string): number {
  if (!isVersion(a) || !isVersion(b)) throw new Error(`版本号格式不对：${a} / ${b}`);
  const [coreA = '', preA] = a.split('-', 2) as [string, string | undefined];
  const [coreB = '', preB] = b.split('-', 2) as [string, string | undefined];
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === preB) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  return preA < preB ? -1 : 1;
}
