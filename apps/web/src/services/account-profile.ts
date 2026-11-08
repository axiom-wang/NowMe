import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { AVATAR_ERROR, AVATAR_MAX_BYTES, AVATAR_MAX_PIXELS, AVATAR_SIZE } from '@nowme/contracts';
import type { UsersRepo } from '../db/users.js';
import { sniffImage } from '../hosted/assets.js';
import { nicknameProblem } from './auth.js';

export async function saveAccountProfile(users: UsersRepo, userId: string, nickname: string, uploads: Uint8Array[], remove: boolean): Promise<string | null> {
  const problem = nicknameProblem(nickname);
  if (problem) return problem;
  if (uploads.length > 1) return AVATAR_ERROR.count;
  if (remove && uploads.length) return AVATAR_ERROR.conflict;
  let avatar: { bytes: Uint8Array; version: string } | null | undefined = remove ? null : undefined;
  const bytes = uploads[0];
  if (bytes) {
    if (bytes.byteLength > AVATAR_MAX_BYTES) return AVATAR_ERROR.size;
    const mime = sniffImage(bytes);
    if (!mime || mime === 'image/gif') return AVATAR_ERROR.type;
    try {
      const input = sharp(bytes, { limitInputPixels: AVATAR_MAX_PIXELS, failOn: 'warning' });
      const metadata = await input.metadata();
      if ((metadata.pages ?? 1) !== 1) return AVATAR_ERROR.type;
      const side = Math.min(AVATAR_SIZE, metadata.width ?? 0, metadata.height ?? 0);
      if (side < 1) return AVATAR_ERROR.invalid;
      avatar = { bytes: await input.rotate().resize(side, side, { fit: 'cover' }).webp({ quality: 85 }).toBuffer(), version: randomUUID() };
    } catch { return AVATAR_ERROR.invalid; }
  }
  users.saveProfile(userId, nickname, avatar);
  return null;
}
