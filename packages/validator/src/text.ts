/**
 * 文本工具：解码、行号、中文字符集合。全部是纯函数。
 */

const utf8 = new TextDecoder('utf-8');
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
/** WHATWG 的 latin1 实际是 windows-1252；凭证扫描只关心 ASCII，结果一致。 */
const latin1 = new TextDecoder('latin1');

/** UTF-8 解码（非法序列替换为 U+FFFD，去掉 BOM）。 */
export function decodeUtf8(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

/** 严格 UTF-8 解码；非法序列返回 null。 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return utf8Fatal.decode(bytes);
  } catch {
    return null;
  }
}

/** 按单字节解码（二进制文件扫描 ASCII 模式用）。 */
export function decodeLatin1(bytes: Uint8Array): string {
  return latin1.decode(bytes);
}

/** 由偏移量求 1 起的行号。 */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
    }
  }

  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

/** 字符串中换行符的个数。 */
export function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1;
  return count;
}

/**
 * “中文字符”：汉字（含扩展区）、CJK 符号与标点、全角符号，以及中文排版常用的
 * 间隔号、破折号、引号、省略号。字体子集化需要这些字形。不含空白。
 */
const CJK_CHAR =
  /^[\p{Script=Han}\u3001-\u303F\uFF01-\uFF65\uFFE0-\uFFE6\uFE10-\uFE1F\uFE30-\uFE4F\u00B7\u2014\u2018\u2019\u201C\u201D\u2026]$/u;

export function isCjkChar(char: string): boolean {
  return CJK_CHAR.test(char);
}

/** 把文本中的中文字符加入集合（按码点）。 */
export function addCjkChars(text: string, into: Set<string>): void {
  for (const char of text) {
    // 快速跳过 ASCII
    if (char.charCodeAt(0) < 0xb7) continue;
    if (isCjkChar(char)) into.add(char);
  }
}

/** 去重并按码点排序后拼接。 */
export function sortChars(chars: Iterable<string>): string {
  return [...new Set(chars)].sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0)).join('');
}

/** 截断展示用的长字符串。 */
export function clip(value: string, max = 80): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
}

/** 列表展示：最多 n 项，多出的用“等 N 项”。 */
export function listPreview(items: readonly string[], max = 8, separator = '、'): string {
  if (items.length <= max) return items.join(separator);
  return `${items.slice(0, max).join(separator)} 等 ${items.length} 项`;
}

/**
 * CSS 转义解码（CSS Syntax 4.3.7）：`\` + 1–6 个十六进制数字（可跟一个空白）→ 对应码点；
 * `\` + 换行 → 删除（字符串续行）；`\` + 其他字符 → 该字符本身。
 */
export function cssUnescape(value: string): string {
  if (!value.includes('\\')) return value;
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) break;
    if (next === '\n' || next === '\r' || next === '\f') {
      i += 1;
      if (next === '\r' && value[i + 1] === '\n') i += 1;
      continue;
    }
    let hex = '';
    let j = i + 1;
    while (j < value.length && hex.length < 6 && /[0-9a-fA-F]/.test(value[j] as string)) {
      hex += value[j];
      j += 1;
    }
    if (hex.length > 0) {
      const code = Number.parseInt(hex, 16);
      out += code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code);
      if (value[j] === ' ' || value[j] === '\t' || value[j] === '\n') j += 1;
      i = j - 1;
    } else {
      out += next;
      i += 1;
    }
  }
  return out;
}
