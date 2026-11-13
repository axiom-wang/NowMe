/**
 * 登录验证码的真实投递（contracts 10.2）：SMTP 发件箱、邮件内容、发不出去时的处理。
 * 不连真实服务器：用 nodemailer 的 jsonTransport（只生成邮件，不发送）或会失败的假传输。
 */
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { loginCodeMail } from '../src/services/auth.js';
import { createSmtpOutbox, createSmtpTransport, MailError, maskEmail, type MailTransport } from '../src/services/mailer.js';
import { createTestWeb, get, latestCode, MINUTE, postForm, type TestWeb } from './helpers.js';

const FROM = 'NOWMe <no-reply@nowme.example>';

interface Sent {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function recordingTransport(): MailTransport & { sent: Sent[] } {
  const json = nodemailer.createTransport({ jsonTransport: true });
  const sent: Sent[] = [];
  return {
    sent,
    async sendMail(mail) {
      await json.sendMail(mail);
      sent.push(mail);
    },
  };
}

function failingTransport(code: string): MailTransport {
  return {
    async sendMail() {
      throw Object.assign(new Error('535 5.7.8 Authentication failed: secret-server-detail'), { code });
    },
  };
}

describe('邮件内容（loginCodeMail）', () => {
  it('主题以验证码开头；正文与 HTML 都有验证码和有效期，没有链接', () => {
    const mail = loginCodeMail('482913');
    expect(mail.subject).toBe('482913 是你的 NOWMe 登录验证码');
    expect(mail.body).toContain('482913');
    expect(mail.body).toContain('10 分钟内有效');
    expect(mail.html).toContain('482913');
    expect(mail.html).not.toMatch(/href=|<script|<img/i);
  });
});

describe('SMTP 发件箱', () => {
  it('把邮件交给发信服务；不能在 /dev/outbox 查看；日志里没有完整邮箱、主题与验证码', async () => {
    const transport = recordingTransport();
    const logs: string[] = [];
    const outbox = createSmtpOutbox({ url: undefined, from: FROM, isProduction: true, transport, log: (line) => logs.push(line) });
    await outbox.send({ at: '2026-11-06T08:00:00.000Z', to: 'ayou@example.com', ...loginCodeMail('482913') });
    expect(transport.sent).toEqual([{ from: FROM, to: 'ayou@example.com', subject: '482913 是你的 NOWMe 登录验证码', text: loginCodeMail('482913').body, html: loginCodeMail('482913').html }]);
    expect(outbox.inspectable).toBe(false);
    expect(outbox.list(10)).toEqual([]);
    expect(logs).toEqual(['[web] 邮件已交给发信服务 → a***@example.com']);
  });

  it('发不出去时抛固定文案的 MailError；日志只有错误类别，没有服务器回复原文', async () => {
    const logs: string[] = [];
    const outbox = createSmtpOutbox({ url: undefined, from: FROM, isProduction: true, transport: failingTransport('EAUTH'), log: (line) => logs.push(line) });
    const error = await Promise.resolve(outbox.send({ at: '', to: 'ayou@example.com', ...loginCodeMail('482913') })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailError);
    expect((error as Error).message).toBe('邮件暂时发不出去');
    expect(logs).toEqual(['[web] 邮件发送失败 → a***@example.com（EAUTH）']);
    expect(logs.join('\n')).not.toMatch(/482913|secret-server-detail|ayou@/);
  });

  it('没有发件人、连接串不合法：配置错误，错误信息里不带连接串', () => {
    expect(() => createSmtpOutbox({ url: 'smtps://u:p@smtp.example.com', from: null, isProduction: true })).toThrow(MailError);
    for (const url of [undefined, '', 'https://user:secret-pass@smtp.example.com', 'user:secret-pass']) {
      let message = '';
      try {
        createSmtpTransport(url, true);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe('邮件服务没有配置好');
    }
  });

  it('连接串里的端口、加密方式与百分号编码的账号密码被正确解析', () => {
    const secure = createSmtpTransport('smtps://no-reply%40nowme.example:p%40ss%2Fword@smtp.example.com', true) as unknown as { options: Record<string, unknown> };
    expect(secure.options).toMatchObject({ host: 'smtp.example.com', port: 465, secure: true, requireTLS: false, auth: { user: 'no-reply@nowme.example', pass: 'p@ss/word' }, pool: true });
    const starttls = createSmtpTransport('smtp://user:pass@smtp.example.com', true) as unknown as { options: Record<string, unknown> };
    expect(starttls.options).toMatchObject({ port: 587, secure: false, requireTLS: true });
    const local = createSmtpTransport('smtp://localhost:1025', false) as unknown as { options: Record<string, unknown> };
    expect(local.options).toMatchObject({ host: 'localhost', port: 1025, secure: false, requireTLS: false, auth: undefined });
    for (const transport of [secure, starttls, local]) (transport as unknown as MailTransport).close?.();
  });

  it('maskEmail 只留首字母和域名', () => {
    expect(maskEmail('ayou@example.com')).toBe('a***@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('登录时的投递', () => {
  let t: TestWeb | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  it('真实投递：验证码进用户邮箱，页面上没有开发发件箱入口，/dev/outbox 不存在', async () => {
    const transport = recordingTransport();
    t = createTestWeb({ mailOutbox: createSmtpOutbox({ url: undefined, from: FROM, isProduction: false, transport }) });
    const response = await postForm(t, '/login', { email: 'ayou@example.com' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('/dev/outbox');
    expect(transport.sent).toHaveLength(1);
    const code = /^(\d{6}) /.exec(transport.sent[0]?.subject ?? '')?.[1] ?? '';
    expect(html).not.toContain(code);
    expect((await get(t, '/dev/outbox')).status).toBe(404);
    const verified = await postForm(t, '/login/verify', { email: 'ayou@example.com', code });
    expect(verified.status).toBe(303);
  });

  it('发不出去：503 并说明原因，刚签发的验证码作废，仍计入限流', async () => {
    const logs: string[] = [];
    const outbox = createSmtpOutbox({ url: undefined, from: FROM, isProduction: false, transport: failingTransport('ECONNECTION'), log: (line) => logs.push(line) });
    t = createTestWeb({ mailOutbox: outbox });
    const response = await postForm(t, '/login', { email: 'ayou@example.com' });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('验证码邮件暂时发不出去');
    const rows = t.db.prepare('SELECT used_at FROM login_codes WHERE email = ?').all('ayou@example.com') as { used_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.used_at).not.toBeNull();
    for (let i = 0; i < 4; i += 1) expect((await postForm(t, '/login', { email: 'ayou@example.com' })).status).toBe(503);
    expect((await postForm(t, '/login', { email: 'ayou@example.com' })).status).toBe(429);
    expect(logs.join('\n')).not.toMatch(/\d{6}/);
  });

  it('本地发件箱照旧：验证码写在发件箱里，登录页给出开发入口', async () => {
    t = createTestWeb();
    const response = await postForm(t, '/login', { email: 'ayou@example.com' });
    expect(await response.text()).toContain('/dev/outbox');
    expect(latestCode(t, 'ayou@example.com')).toMatch(/^\d{6}$/);
    expect(t.outbox.messages[0]?.subject).toMatch(/^\d{6} 是你的 NOWMe 登录验证码$/);
    t.clock.advance(MINUTE);
    expect((await get(t, '/dev/outbox')).status).toBe(200);
  });
});
