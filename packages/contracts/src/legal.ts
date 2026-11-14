/**
 * 用户协议与隐私政策（contracts 16）：版本、年龄门槛与同意表单字段。
 * 协议文字一改就要升版本号：版本不同的老用户下次登录需要重新确认（apps/web 的 `/consent`）。
 */
/** 《用户协议》与《隐私政策》当前版本（同一个版本号，日期格式）。 */
export const LEGAL_VERSION = '2026-11-15';
/** 当前版本的生效日期，显示在两份文档顶部。 */
export const LEGAL_EFFECTIVE_DATE = '2026-11-15';
/** 使用 NOWMe 的最低年龄（周岁）。 */
export const MIN_USER_AGE = 18;
/** 同意勾选框的表单字段名（值为 `1` 才算同意）。 */
export const CONSENT_FIELD_NAME = 'agree';
