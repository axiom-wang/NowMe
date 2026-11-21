/**
 * 内容安全检查的共享定义（contracts 16.1）：检查点类型、外部词表文件的解析与校验、外部审核接口的约定。
 * 检查本身在 `apps/web/src/services/content-safety.ts`。
 */
import { readFileSync } from 'node:fs';

/** 检查点：用户写给平台或别人看的文字出现在哪里。 */
export const CONTENT_KINDS = ['wall', 'nickname', 'interview', 'edit', 'message', 'page', 'answer'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** 外部审核接口失败（超时、非 2xx、返回格式不对）时：放行并记日志，或拦截。 */
export const MODERATION_FAILURE_MODES = ['allow', 'block'] as const;
export type ModerationFailureMode = (typeof MODERATION_FAILURE_MODES)[number];

/** 外部审核接口单次请求的超时（毫秒）。 */
export const MODERATION_TIMEOUT_MS = 3000;
/** 交给外部审核接口的文字最多多少字符（更长的只送前面这些；本地规则检查全文）。 */
export const MODERATION_TEXT_MAX_CHARS = 8000;
/** 外部词表：最多多少条、每条最长多少字符、文件最大多少字节。 */
export const BLOCKLIST_MAX_ENTRIES = 5000;
export const BLOCKLIST_ENTRY_MAX_CHARS = 200;
export const BLOCKLIST_FILE_MAX_BYTES = 512 * 1024;

export interface BlocklistEntry {
  /** 规则编号 `F<行号>`，日志与拦截提示里只出现它，不出现词本身。 */
  rule: string;
  pattern: RegExp;
}

export class BlocklistError extends Error {
  override name = 'BlocklistError';
}

/** 与内置规则相同的预处理：全角转半角、小写、去掉词与词之间用来躲避匹配的空白与符号。 */
export function squashForMatching(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u200b-\u200f\u2028-\u202f\u2060\ufeff·.。,，、_\-*~|/\\'"`^]+/g, '');
}

/**
 * 解析词表文本。每行一条：`#` 开头是注释、空行忽略；`/正则/标志` 是正则（标志只允许 i、u、s、m，默认不区分大小写，
 * 在原文上匹配）；其余是普通词（不区分大小写、忽略空白与标点地匹配）。
 * 任何一行不合法都抛 BlocklistError，信息里只带行号，不带词本身。
 */
export function parseBlocklist(text: string): BlocklistEntry[] {
  const entries: BlocklistEntry[] = [];
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const rule = `F${index + 1}`;
    if (line.length > BLOCKLIST_ENTRY_MAX_CHARS) throw new BlocklistError(`词表第 ${index + 1} 行太长（最多 ${BLOCKLIST_ENTRY_MAX_CHARS} 个字符）`);
    if (entries.length >= BLOCKLIST_MAX_ENTRIES) throw new BlocklistError(`词表最多 ${BLOCKLIST_MAX_ENTRIES} 条`);
    const asRegex = /^\/(.+)\/([a-z]*)$/.exec(line);
    if (asRegex) {
      const flags = asRegex[2] ?? '';
      if (!/^[iusm]*$/.test(flags)) throw new BlocklistError(`词表第 ${index + 1} 行：正则标志只允许 i、u、s、m`);
      try {
        entries.push({ rule, pattern: new RegExp(asRegex[1]!, flags.includes('i') ? flags : `${flags}i`) });
      } catch {
        throw new BlocklistError(`词表第 ${index + 1} 行：正则无法解析`);
      }
      return;
    }
    const word = squashForMatching(line);
    if (!word) return;
    entries.push({ rule, pattern: new RegExp(`(?:${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'u') });
  });
  return entries;
}

/** 读取并解析词表文件；读不到或不合法都抛 BlocklistError（启动时拒绝启动，而不是悄悄不检查）。 */
export function loadBlocklistFile(file: string): BlocklistEntry[] {
  let text: string;
  try {
    const buffer = readFileSync(file);
    if (buffer.byteLength > BLOCKLIST_FILE_MAX_BYTES) throw new BlocklistError(`词表文件太大（最多 ${BLOCKLIST_FILE_MAX_BYTES / 1024} KB）`);
    text = buffer.toString('utf8');
  } catch (error) {
    if (error instanceof BlocklistError) throw error;
    throw new BlocklistError('NOWME_BLOCKLIST_FILE 指向的词表文件读不到');
  }
  return parseBlocklist(text);
}

/** 词表条目匹配：普通词在压缩后的文字上、正则（带 `/` 的写法）在原文上都试一遍。 */
export function matchBlocklist(entries: readonly BlocklistEntry[], text: string): string | null {
  const squashed = squashForMatching(text);
  for (const entry of entries) {
    if (entry.pattern.test(text) || entry.pattern.test(squashed)) return entry.rule;
  }
  return null;
}
