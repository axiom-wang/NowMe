/**
 * 采访素材（hosted-route 2、S7）：主人上传的图片。
 * - 类型只按文件头魔数判断（PNG / JPEG / WebP / GIF），不信任文件名与客户端 MIME；
 * - 文件名由平台生成（`photo-<n>.<ext>`），原文件名不保存；
 * - 文件在 `<dataDir>/hosted/<pageId>/assets/`；删除 brief / 页面时整目录删除。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRIEF_ASSET_MAX_BYTES, PAGE_ID_PATTERN } from '@nowme/contracts';
import type { BriefAssetMime } from '../db/hosted.js';

const EXTENSIONS: Record<BriefAssetMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** 按魔数判断图片类型；不是这四种返回 null。 */
export function sniffImage(bytes: Uint8Array): BriefAssetMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

export type UploadCheck = { ok: true; mime: BriefAssetMime } | { ok: false; reason: 'too-large' | 'type' | 'empty' };

export function checkUpload(bytes: Uint8Array): UploadCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty' };
  if (bytes.byteLength > BRIEF_ASSET_MAX_BYTES) return { ok: false, reason: 'too-large' };
  const mime = sniffImage(bytes);
  return mime ? { ok: true, mime } : { ok: false, reason: 'type' };
}

export function assetFileName(index: number, mime: BriefAssetMime): string {
  return `photo-${index}.${EXTENSIONS[mime]}`;
}

/** `<dataDir>/hosted/<pageId>`。 */
export function hostedPageDir(dataDir: string, pageId: string): string {
  if (!PAGE_ID_PATTERN.test(pageId)) throw new Error(`pageId 格式不对：${pageId}`);
  return join(dataDir, 'hosted', pageId);
}

export function hostedAssetsDir(dataDir: string, pageId: string): string {
  return join(hostedPageDir(dataDir, pageId), 'assets');
}

const ASSET_NAME = /^photo-\d{1,2}\.(png|jpg|webp|gif)$/;

export async function writeAsset(dataDir: string, pageId: string, fileName: string, bytes: Uint8Array): Promise<string> {
  if (!ASSET_NAME.test(fileName)) throw new Error(`素材文件名不对：${fileName}`);
  const dir = hostedAssetsDir(dataDir, pageId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, fileName), bytes, { mode: 0o600 });
  return createHash('sha256').update(bytes).digest('hex');
}

export async function readAsset(dataDir: string, pageId: string, fileName: string): Promise<Uint8Array> {
  if (!ASSET_NAME.test(fileName)) throw new Error(`素材文件名不对：${fileName}`);
  return new Uint8Array(await readFile(join(hostedAssetsDir(dataDir, pageId), fileName)));
}

/** 删除这一页的全部托管文件（素材）。 */
export async function removeHostedPageFiles(dataDir: string, pageId: string): Promise<void> {
  await rm(hostedPageDir(dataDir, pageId), { recursive: true, force: true });
}
