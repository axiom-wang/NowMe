/** 组织者上传的墙封面；与成员页面的 cover.png 相互独立。 */
export const WALL_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const WALL_COVER_REQUEST_MAX_BYTES = WALL_COVER_MAX_BYTES + 64 * 1024;
export const WALL_COVER_MAX_PIXELS = 40_000_000;
export const WALL_COVER_WIDTH = 1200;
export const WALL_COVER_HEIGHT = 1200;
export const WALL_COVER_ERROR = {
  missing: '请选择一张封面图。',
  count: '每次只能上传一张封面图。',
  size: '封面图不能超过 5 MB，请压缩后重试。',
  type: '请选择 JPG、PNG 或 WebP 格式的图片，不支持 SVG 和动图。',
  invalid: '图片无法读取，或尺寸超过 4000 万像素，请换一张图片。',
} as const;
