/**
 * 真实邮件投递（contracts 10.2）：`NOWME_MAIL_TRANSPORT=smtp` 时，登录验证码经 SMTP 发到用户邮箱。
 *
 * - 连接串 `NOWME_SMTP_URL`（`smtps://用户:密码@主机:465` 或 `smtp://用户:密码@主机:587`）只从环境变量读，
 *   不进配置对象、不写日志；用户名与密码按 URL 规则百分号编码。
 * - `smtp://` 在生产环境强制 STARTTLS（验证码不走明文）；本地开发连 Mailpit 之类的测试服务器时不强制。
 * - 日志只记“发给哪个域名、成功还是失败”，不记完整邮箱、主题与正文（主题和正文里有验证码）。
 * - 发不出去时抛 `MailError`（固定文案，不带服务器的原始回复），由登录路由告诉用户稍后再试。
 */
import nodemailer from 'nodemailer';
import type { Outbox, OutboxMessage } from './outbox.js';

export class MailError extends Error {
  override name = 'MailError';
  constructor(readonly reason: 'config' | 'send') {
    super(reason === 'config' ? '邮件服务没有配置好' : '邮件暂时发不出去');
  }
}

/** 我们用到的 nodemailer 发送接口（测试注入 `jsonTransport`）。 */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string; html?: string }): Promise<unknown>;
  close?(): void;
}

export interface SmtpOutboxOptions {
  /** `NOWME_SMTP_URL`。 */
  url: string | undefined;
  /** `NOWME_MAIL_FROM`。 */
  from: string | null;
  isProduction: boolean;
  log?: (line: string) => void;
  /** 测试注入；不传时按 `url` 建立连接池。 */
  transport?: MailTransport;
}

const SEND_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, dnsTimeout: 10_000 } as const;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 由连接串建立 SMTP 连接池。连接串不合法时抛 `MailError('config')`（不带连接串本身）。 */
export function createSmtpTransport(rawUrl: string | undefined, isProduction: boolean): MailTransport {
  let url: URL;
  try {
    url = new URL(rawUrl ?? '');
  } catch {
    throw new MailError('config');
  }
  if ((url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname) throw new MailError('config');
  const secure = url.protocol === 'smtps:';
  return nodemailer.createTransport({
    host: url.hostname,
    port: url.port ? Number(url.port) : secure ? 465 : 587,
    secure,
    requireTLS: !secure && isProduction,
    auth: url.username ? { user: decode(url.username), pass: decode(url.password) } : undefined,
    pool: true,
    maxConnections: 3,
    ...SEND_TIMEOUTS,
  });
}

/** 日志里只留域名：`a***@example.com`。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `${email[0]}***${email.slice(at)}` : '***';
}

export function createSmtpOutbox(options: SmtpOutboxOptions): Outbox {
  const { from } = options;
  if (!from) throw new MailError('config');
  const log = options.log ?? (() => {});
  const transport = options.transport ?? createSmtpTransport(options.url, options.isProduction);
  return {
    inspectable: false,
    async send(message: OutboxMessage) {
      try {
        await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.body, ...(message.html ? { html: message.html } : {}) });
        log(`[web] 邮件已交给发信服务 → ${maskEmail(message.to)}`);
      } catch (error) {
        // 只记错误类别（nodemailer 的 code，如 ECONNECTION / EAUTH / EENVELOPE），不记服务器回复原文
        const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
        log(`[web] 邮件发送失败 → ${maskEmail(message.to)}（${code}）`);
        throw new MailError('send');
      }
    },
    list() {
      return [];
    },
    close() {
      transport.close?.();
    },
  };
}
