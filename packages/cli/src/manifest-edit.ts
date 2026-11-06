/**
 * 只改 manifest.json 中顶层 `extraChars` 字段的值，其余文本（缩进、换行、字段顺序、紧凑数组）保持原样。
 *
 * 用一个最小的 JSON 扫描器定位顶层键的值的位置并替换；找不到、不是字符串或结果解析不一致时返回 null，
 * 由调用方退回到 `JSON.stringify(value, null, 2)` 整体重写。
 */
import { isDeepStrictEqual } from 'node:util';

interface Span {
  start: number;
  end: number;
  kind: 'string' | 'other';
}

class Scanner {
  index = 0;
  constructor(readonly text: string) {}

  ws(): void {
    while (this.index < this.text.length && /[ \t\n\r]/.test(this.text[this.index] as string)) this.index += 1;
  }

  string(): string {
    const start = this.index;
    if (this.text[this.index] !== '"') throw new Error('expected string');
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === '\\') this.index += 2;
      else if (char === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      } else this.index += 1;
    }
    throw new Error('unterminated string');
  }

  value(): Span {
    this.ws();
    const start = this.index;
    const char = this.text[this.index];
    if (char === '"') {
      this.string();
      return { start, end: this.index, kind: 'string' };
    }
    if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      this.index += 1;
      this.ws();
      if (this.text[this.index] === close) {
        this.index += 1;
        return { start, end: this.index, kind: 'other' };
      }
      for (;;) {
        if (char === '{') {
          this.ws();
          this.string();
          this.ws();
          if (this.text[this.index] !== ':') throw new Error('expected colon');
          this.index += 1;
        }
        this.value();
        this.ws();
        const next = this.text[this.index];
        this.index += 1;
        if (next === close) return { start, end: this.index, kind: 'other' };
        if (next !== ',') throw new Error('expected comma');
      }
    }
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.index));
    if (!literal) throw new Error('unexpected token');
    this.index += literal[0].length;
    return { start, end: this.index, kind: 'other' };
  }

  /** 顶层对象中键 `key` 的值的位置（重复键取最后一个，与 JSON.parse 一致）。 */
  topLevelValue(key: string): Span | null {
    this.ws();
    if (this.text[this.index] !== '{') throw new Error('not an object');
    this.index += 1;
    this.ws();
    let found: Span | null = null;
    if (this.text[this.index] === '}') return null;
    for (;;) {
      this.ws();
      const name = this.string();
      this.ws();
      if (this.text[this.index] !== ':') throw new Error('expected colon');
      this.index += 1;
      const span = this.value();
      if (name === key) found = span;
      this.ws();
      const next = this.text[this.index];
      this.index += 1;
      if (next === '}') return found;
      if (next !== ',') throw new Error('expected comma');
    }
  }
}

/**
 * 把顶层字符串字段 `key` 的值换成 `value`，只改这一处文本。
 * 返回 null：不是合法 JSON 对象、没有这个键、值不是字符串，或替换后的解析结果与预期不一致。
 */
export function replaceTopLevelString(text: string, key: string, value: string): string | null {
  let original: unknown;
  let span: Span | null;
  try {
    original = JSON.parse(text);
    span = new Scanner(text).topLevelValue(key);
  } catch {
    return null;
  }
  if (!span || span.kind !== 'string' || typeof original !== 'object' || original === null) return null;
  const next = `${text.slice(0, span.start)}${JSON.stringify(value)}${text.slice(span.end)}`;
  try {
    const expected = { ...(original as Record<string, unknown>), [key]: value };
    return isDeepStrictEqual(JSON.parse(next), expected) ? next : null;
  } catch {
    return null;
  }
}
