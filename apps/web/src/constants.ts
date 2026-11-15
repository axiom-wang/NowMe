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

/**
 * 按来源地址 / 按用户的短时限流（contracts 10.3，security/rate-limit.ts）。
 * 按地址的上限放得比较宽：目标用户常在同一个校园网出口后面，一场招新会有上百人在十分钟内登录。
 * 这些上限挡的是脚本批量轰炸（换着邮箱让平台发信、暴力试验证码），不是正常人的使用。
 */
export const RATE_RULES = {
  /** 同一地址请求发验证码。 */
  loginRequest: { max: 120, windowMs: 10 * 60 * 1000 },
  /** 同一地址提交验证码。 */
  loginVerify: { max: 300, windowMs: 10 * 60 * 1000 },
  /** 同一地址用一次性 token 换页面凭证。 */
  agentExchange: { max: 60, windowMs: 10 * 60 * 1000 },
  /** 同一用户发消息（群聊 + 私聊合计）。 */
  chatSend: { max: 40, windowMs: 60 * 1000 },
  /** 同一用户尝试兑换码。 */
  redeem: { max: 10, windowMs: 10 * 60 * 1000 },
  /** 同一用户导出自己的数据（contracts 14：打包全部页面文件，比较重）。 */
  accountExport: { max: 5, windowMs: 60 * 60 * 1000 },
} as const;

/** 必答题（contracts 19.1）：每面墙最多 3 道；题目 2–30 字；每道 2–12 个选项，每个选项 1–12 字。 */
export const WALL_QUESTION_LIMITS = {
  maxQuestions: 3,
  prompt: { min: 2, max: 30 },
  options: { min: 2, max: 12 },
  option: { min: 1, max: 12 },
} as const;

/** 一键提醒（contracts 19.2）：同一面墙里，每人 48 小时内最多一封，总共最多 3 封。 */
export const REMINDER_LIMITS = {
  cooldownMs: 48 * 3600 * 1000,
  maxPerMember: 3,
} as const;

/** 墙的群像（contracts 19.3）。 */
export const PORTRAIT_LIMITS = {
  /** 至少这么多人上墙才能生成（人太少时“群像”就是在描述个人）。 */
  minPages: 3,
  /** 交给模型的页面数上限（超过时取最近发布的）。 */
  maxPages: 150,
  /** 每个主题至少几个人（同上，避免指向个人）。 */
  minThemeMembers: 2,
  themes: 5,
  summary: 80,
  title: 12,
  detail: 36,
  /** 每面墙每滚动 24 小时最多生成几次（成功与失败都算）。 */
  dailyPerWall: 6,
  timeoutMs: 90 * 1000,
} as const;
