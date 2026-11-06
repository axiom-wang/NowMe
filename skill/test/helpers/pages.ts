/**
 * 示例页的简单解析工具（正则级别，只用于自查；正式规则由 packages/validator 实现）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { KitFont } from '@nowme/contracts';
import { EXAMPLES_DIR } from '../../src/index.js';

export interface ExamplePage {
  dir: string;
  path: string;
  html: string;
  htmlBytes: number;
  card: unknown;
  manifest: unknown;
  files: string[];
}

export function readExample(dir: string): ExamplePage {
  const path = join(EXAMPLES_DIR, dir);
  const htmlPath = join(path, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');
  return {
    dir,
    path,
    html,
    htmlBytes: statSync(htmlPath).size,
    card: JSON.parse(readFileSync(join(path, 'card.json'), 'utf8')),
    manifest: JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')),
    files: listFiles(path),
  };
}

function listFiles(root: string, prefix = ''): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(join(root, entry.name), rel) : [rel];
  });
}

/** 内联 `<script>` 的内容（不含 src 的）。 */
export function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1] ?? ''))
    .map((match) => match[2] ?? '');
}

/** `<style>` 的内容与 style 属性。 */
export function styles(html: string): string {
  const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1] ?? '');
  const attrs = [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((match) => match[1] ?? '');
  return [...blocks, ...attrs].join('\n');
}

/** 去掉 script / style / 注释 / 标签后的文本（静态文本）。 */
export function staticText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** 中文及全角字符（需要中文字体渲染的字）。 */
const CJK = /[⺀-⿿　-〿぀-ヿ㄀-ㄯ㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/gu;

export function cjkSet(text: string): Set<string> {
  return new Set(text.match(CJK) ?? []);
}

/** data-* 属性值（脚本可能读出来显示）。 */
export function dataAttributeText(html: string): string {
  return [...html.matchAll(/\sdata-[a-z-]+\s*=\s*"([^"]*)"/gi)].map((match) => match[1] ?? '').join(' ');
}

/** 所有开始标签（标签名小写 + 原文）。 */
export function startTags(html: string): { name: string; raw: string }[] {
  const withoutScripts = html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script$1></script>');
  return [...withoutScripts.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)].map((match) => ({
    name: (match[1] ?? '').toLowerCase(),
    raw: match[0],
  }));
}

export function attribute(raw: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(raw);
  if (match === null) return null;
  return match[2] ?? match[3] ?? match[4] ?? '';
}

export function hasAttribute(raw: string, name: string): boolean {
  return new RegExp(`\\s${name}(\\s|=|>|/)`, 'i').test(raw);
}

/** 页面里用到的 Kit 字体：`var(--nm-font-<id>)` 或带引号的 family 名。 */
export function kitFontsUsed(html: string, fonts: readonly KitFont[]): string[] {
  const css = styles(html) + '\n' + html;
  return fonts
    .filter((font) => css.includes(`var(--nm-font-${font.id})`) || css.includes(`"${font.family}"`) || css.includes(`'${font.family}'`))
    .map((font) => font.id);
}

/** contracts 2.2 FORBIDDEN_API。 */
export const FORBIDDEN_API: readonly [label: string, pattern: RegExp][] = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['sendBeacon', /sendBeacon/],
  ['RTCPeerConnection', /RTCPeerConnection/],
  ['WebTransport', /WebTransport/],
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['indexedDB', /indexedDB/i],
  ['caches.', /\bcaches\s*\./],
  ['document.cookie', /document\s*\.\s*cookie/],
  ['cookieStore', /cookieStore/],
  ['window.open', /window\s*\.\s*open\b/],
  ['window.top', /window\s*\.\s*top\b/],
  ['top.location', /\btop\s*\.\s*location/],
  ['parent.location', /parent\s*\.\s*location/],
  ['location.href =', /location\s*\.\s*href\s*=/],
  ['location.assign', /location\s*\.\s*assign/],
  ['location.replace', /location\s*\.\s*replace/],
  ['serviceWorker', /serviceWorker/],
  ['importScripts', /importScripts/],
  ['new Worker', /new\s+Worker/],
  ['new SharedWorker', /new\s+SharedWorker/],
  ['import(', /\bimport\s*\(/],
  ['eval(', /\beval\s*\(/],
  ['new Function', /new\s+Function/],
  ['setTimeout("..."', /setTimeout\s*\(\s*['"`]/],
  ['getUserMedia', /getUserMedia/],
  ['geolocation', /geolocation/],
];
