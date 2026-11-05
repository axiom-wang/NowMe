import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateId, issueTicket, signTicket, TICKET_TTL_SECONDS, verifyTicket } from '../../src/index.js';

const SECRET = 'test-secret-0123456789abcdefghijklmnop';
const NOW = new Date('2026-11-06T08:00:00.000Z');
const EXPIRES = new Date(NOW.getTime() + TICKET_TTL_SECONDS * 1000);
const REV = 'rev_abcdefghijklmnopqrstuvwxyz';

function sign(revisionId = REV, expiresAt = EXPIRES, secret = SECRET): string {
  return signTicket({ revisionId, expiresAt, secret });
}

function split(ticket: string): [string, string, string] {
  const parts = ticket.split('.');
  expect(parts).toHaveLength(3);
  return parts as [string, string, string];
}

describe('signTicket', () => {
  it('输出 <revisionId>.<expUnix>.<sig> 格式', () => {
    const ticket = sign();
    expect(ticket).toMatch(/^rev_[a-z2-7]{26}\.[1-9][0-9]*\.[A-Za-z0-9_-]{43}$/);
    const [rev, exp] = split(ticket);
    expect(rev).toBe(REV);
    expect(Number(exp)).toBe(Math.floor(EXPIRES.getTime() / 1000));
  });

  it('sig = base64url(HMAC-SHA256(secret, "<revisionId>.<expUnix>"))', () => {
    const [rev, exp, sig] = split(sign());
    const expected = createHmac('sha256', SECRET).update(`${rev}.${exp}`).digest('base64url');
    expect(sig).toBe(expected);
    expect(sig).not.toContain('=');
  });

  it('过期时刻向下取整到秒，结果是确定的', () => {
    const a = sign(REV, new Date(EXPIRES.getTime() + 999));
    expect(a).toBe(sign());
  });

  it('拒绝不合法的 revisionId（防止路径穿越进存储目录）', () => {
    for (const bad of ['', 'rev_', 'rev_ABC', '../../etc/passwd', `${REV}/..`, 'pg_abcdefghijklmnopqrstuvwxyz', `${REV}.1`]) {
      expect(() => sign(bad)).toThrow();
    }
  });

  it('拒绝空密钥与无效时间', () => {
    expect(() => sign(REV, EXPIRES, '')).toThrow();
    expect(() => sign(REV, new Date(Number.NaN))).toThrow();
    expect(() => sign(REV, new Date(0))).toThrow();
  });

  it('issueTicket 默认有效期 30 分钟', () => {
    const ticket = issueTicket(REV, SECRET, NOW);
    expect(ticket).toBe(sign());
    expect(TICKET_TTL_SECONDS).toBe(30 * 60);
  });
});

describe('verifyTicket', () => {
  it('正确的票据：返回 revisionId 与过期时间', () => {
    const revisionId = generateId('rev');
    const result = verifyTicket(sign(revisionId), SECRET, NOW);
    expect(result).toEqual({ ok: true, revisionId, expiresAt: new Date(Math.floor(EXPIRES.getTime() / 1000) * 1000) });
  });

  it('过期：到达过期时刻及之后无效，之前有效', () => {
    const ticket = sign();
    const expMs = Math.floor(EXPIRES.getTime() / 1000) * 1000;
    expect(verifyTicket(ticket, SECRET, new Date(expMs - 1)).ok).toBe(true);
    expect(verifyTicket(ticket, SECRET, new Date(expMs))).toEqual({ ok: false, reason: 'expired' });
    expect(verifyTicket(ticket, SECRET, new Date(expMs + 60 * 60 * 1000))).toEqual({ ok: false, reason: 'expired' });
  });

  it('篡改签名：改任意一个字符都无效', () => {
    const [rev, exp, sig] = split(sign());
    for (let i = 0; i < sig.length; i += 7) {
      const replacement = sig[i] === 'A' ? 'B' : 'A';
      const tampered = `${rev}.${exp}.${sig.slice(0, i)}${replacement}${sig.slice(i + 1)}`;
      expect(verifyTicket(tampered, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    }
  });

  it('篡改签名：解码后字节相同的非规范 base64url 写法也无效', () => {
    const [rev, exp, sig] = split(sign());
    // 43 个字符编码 32 字节，最后一个字符的低 2 位不参与解码：翻转最低位得到“解码相同”的另一种写法
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.at(-1) ?? '');
    const variant = `${sig.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(Buffer.from(variant, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    expect(verifyTicket(`${rev}.${exp}.${variant}`, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('篡改 revisionId：换成另一个合法版本 ID，签名不再匹配', () => {
    const [, exp, sig] = split(sign());
    const other = generateId('rev');
    expect(verifyTicket(`${other}.${exp}.${sig}`, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('篡改过期时间：延长有效期，签名不再匹配', () => {
    const [rev, exp, sig] = split(sign());
    expect(verifyTicket(`${rev}.${Number(exp) + 3600}.${sig}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('签名先于过期检查：过期票据被篡改时报 bad_signature', () => {
    const [rev, exp, sig] = split(sign());
    const late = new Date(EXPIRES.getTime() + 60_000);
    expect(verifyTicket(`${rev}.${Number(exp) - 1}.${sig}`, SECRET, late)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('错误密钥：无效', () => {
    expect(verifyTicket(sign(), `${SECRET}x`, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyTicket(sign(REV, EXPIRES, 'another-secret-another-secret-xx'), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('格式错误：一律 malformed', () => {
    const [rev, exp, sig] = split(sign());
    const malformed = [
      '',
      'abc',
      `${rev}.${exp}`,
      `${rev}.${exp}.${sig}.extra`,
      `${rev}..${sig}`,
      `${rev}.0${exp}.${sig}`, // 前导零
      `${rev}.-${exp}.${sig}`,
      `${rev}.${exp}x.${sig}`,
      `${rev}.${exp}.${sig.slice(0, -1)}`, // 42 字符
      `${rev}.${exp}.${sig}A`, // 44 字符
      `${rev}.${exp}.${sig.slice(0, -1)}=`, // 填充
      `${rev}.${exp}.${sig.slice(0, -1)}+`, // 非 base64url 字符
      `${rev.toUpperCase()}.${exp}.${sig}`,
      `../${rev}.${exp}.${sig}`,
      ` ${rev}.${exp}.${sig}`,
      `${rev}.${exp}.${sig}\n`,
      `pg_abcdefghijklmnopqrstuvwxyz.${exp}.${sig}`,
      `${'a'.repeat(300)}`,
    ];
    for (const ticket of malformed) {
      expect(verifyTicket(ticket, SECRET, NOW), JSON.stringify(ticket)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(verifyTicket(undefined as unknown as string, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('空密钥是配置错误，直接抛出', () => {
    expect(() => verifyTicket(sign(), '', NOW)).toThrow();
  });
});
