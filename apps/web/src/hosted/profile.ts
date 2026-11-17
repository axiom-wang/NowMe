/** 相似度只用于建议人工合并，不以相似度自动删除事实。 */
import type { ProfileEntry } from '../db/hosted.js';
export function normalizedProfileText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\p{Z}\s，。！？、；：…“”‘’「」『』]/gu, '');
}
export function similarEntries(entry: ProfileEntry, entries: ProfileEntry[]): ProfileEntry[] {
  const grams = (text: string) => {
    const chars = Array.from(text);
    return new Set(chars.slice(1).map((c, i) => chars[i]! + c));
  };
  const a = grams(normalizedProfileText(entry.text));
  return entries.filter((other) => {
    if (other.id === entry.id || other.category !== entry.category || other.scope !== entry.scope) return false;
    const b = grams(normalizedProfileText(other.text));
    const shared = [...a].filter((g) => b.has(g)).length;
    return a.size + b.size > 0 && 2 * shared / (a.size + b.size) >= 0.5;
  });
}
