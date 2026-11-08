/** 墙封面只接受静态位图；解码后重编码，剥离 EXIF / 文本 / 附加数据。 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { WALL_COVER_ERROR, WALL_COVER_HEIGHT, WALL_COVER_MAX_BYTES, WALL_COVER_MAX_PIXELS, WALL_COVER_WIDTH } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import { findOrganizerWall } from './access.js';
import { sniffImage } from '../hosted/assets.js';

export type CoverResult = { ok: true } | { ok: false; error: string; status: 400 | 404 | 413 };

export async function uploadWallCover(deps: Pick<AppDeps, 'repos' | 'now'>, userId: string, wallId: string, uploads: Uint8Array[]): Promise<CoverResult> {
  if (!findOrganizerWall(deps.repos, userId, wallId)) return { ok: false, error: '', status: 404 };
  if (uploads.length !== 1) return { ok: false, error: uploads.length ? WALL_COVER_ERROR.count : WALL_COVER_ERROR.missing, status: 400 };
  const bytes = uploads[0]!;
  if (bytes.byteLength > WALL_COVER_MAX_BYTES) return { ok: false, error: WALL_COVER_ERROR.size, status: 413 };
  const type = sniffImage(bytes);
  if (!type || type === 'image/gif') return { ok: false, error: WALL_COVER_ERROR.type, status: 400 };
  let image: Buffer;
  try {
    const input = sharp(bytes, { limitInputPixels: WALL_COVER_MAX_PIXELS, failOn: 'warning' });
    const metadata = await input.metadata();
    if ((metadata.pages ?? 1) !== 1) return { ok: false, error: WALL_COVER_ERROR.type, status: 400 };
    // 先按原图短边限制目标边长，确保小图也会裁成正方形且不放大。
    const side = Math.min(WALL_COVER_WIDTH, WALL_COVER_HEIGHT, metadata.width ?? 0, metadata.height ?? 0);
    if (side < 1) return { ok: false, error: WALL_COVER_ERROR.invalid, status: 400 };
    image = await input.rotate().resize(side, side, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  } catch {
    return { ok: false, error: WALL_COVER_ERROR.invalid, status: 400 };
  }
  // 解码期间组织者可能关闭墙；写入前再次检查。
  if (!findOrganizerWall(deps.repos, userId, wallId)) return { ok: false, error: '', status: 404 };
  deps.repos.walls.saveCover(wallId, randomUUID(), image, deps.now().toISOString());
  return { ok: true };
}
