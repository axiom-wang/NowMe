/**
 * 主站自己的常量（contracts 没有规定、T2.1 补充的取值，[T2.1 暂定]，需要时由总规划师确认）。
 * contracts 规定的常量一律从 @nowme/contracts 取。
 */

/** 同一邮箱的验证码限流：WINDOW 秒内最多 MAX 次。 */
export const LOGIN_CODE_RATE_WINDOW_SECONDS = 10 * 60;
export const LOGIN_CODE_RATE_MAX = 5;

/** 昵称长度（按 Unicode 码点）。 */
export const NICKNAME_LIMITS = { min: 1, max: 24 } as const;
/** 邮箱最长 254 个字符。 */
export const EMAIL_MAX_LENGTH = 254;

/** 主站表单请求体上限（Agent API 另有上限）。 */
export const FORM_BODY_MAX_BYTES = 64 * 1024;

/** “每页每日 50 次”按滚动 24 小时计算。 */
export const REVISION_RATE_WINDOW_HOURS = 24;

/** 墙名、简介、组织者一句话的长度（建墙表单，T3.1 使用）。 */
export const WALL_TEXT_LIMITS = {
  name: { min: 1, max: 40 },
  description: { min: 0, max: 200 },
  organizerNote: { min: 0, max: 80 },
} as const;

/** 静态文件的 URL 前缀（`apps/web/static/`）。 */
export const STATIC_PATH_PREFIX = '/static/';

/** `/dev/outbox` 显示的最近邮件条数。 */
export const DEV_OUTBOX_LIMIT = 50;
