/** 显示用的格式化。时间统一按北京时间显示（原型的用户都在国内）。 */

const DATE_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** 北京时间的“年/月/日 时:分”。 */
export function formatDateTime(value: Date | string): string {
  return DATE_TIME.format(typeof value === 'string' ? new Date(value) : value);
}
