/** 账号头像上传规则；上传后统一裁成正方形 WebP。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_REQUEST_MAX_BYTES = AVATAR_MAX_BYTES + 64 * 1024;
export const AVATAR_MAX_PIXELS = 16_000_000;
export const AVATAR_SIZE = 256;
export const AVATAR_ERROR = {
  size: '头像图片不能超过 2 MB。',
  type: '请选择静态 PNG、JPEG 或 WebP 图片。',
  invalid: '无法读取这张图片，请换一张再试。',
  count: '每次只能上传一张头像。',
  conflict: '更换头像和移除头像请选择一项。',
} as const;
