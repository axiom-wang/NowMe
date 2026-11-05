import { describe, expect, it } from 'vitest';
import {
  base32Lower,
  constantTimeEqual,
  containsCredentialLike,
  generateId,
  generateLoginCode,
  generateToken,
  hashToken,
  ID_PREFIXES,
  idPattern,
  isId,
  isTokenFormat,
  TOKEN_FORMATS,
  tokenPattern,
  type IdPrefix,
  type TokenKind,
} from '../src/index.js';

describe('base32Lower（RFC 4648 测试向量，小写无填充）', () => {
  it.each([
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ])('%j → %j', (input, expected) => {
    expect(base32Lower(Buffer.from(input))).toBe(expected);
  });
});

describe('generateId', () => {
  it.each(Object.values(ID_PREFIXES))('%s_ + 26 位 base32 小写', (prefix) => {
    const id = generateId(prefix);
    expect(id).toMatch(new RegExp(`^${prefix}_[a-z2-7]{26}$`));
    expect(isId(id, prefix)).toBe(true);
    expect(idPattern(prefix).test(id)).toBe(true);
  });

  it('contracts 3 给出的前缀', () => {
    expect(ID_PREFIXES).toMatchObject({
      user: 'usr',
      wall: 'wal',
      membership: 'mem',
      page: 'pg',
      revision: 'rev',
      publication: 'pbl',
      event: 'evt',
    });
  });

  it('ID 前缀与令牌前缀不冲突', () => {
    const tokenPrefixes = Object.values(TOKEN_FORMATS).map((format) => format.prefix);
    for (const prefix of Object.values(ID_PREFIXES)) expect(tokenPrefixes).not.toContain(`${prefix}_`);
  });

  it('随机且不重复', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generateId('rev')));
    expect(ids.size).toBe(2000);
  });

  it('未知前缀抛出；isId 拒绝其他前缀与格式', () => {
    expect(() => generateId('xxx' as IdPrefix)).toThrow();
    const id = generateId('wal');
    expect(isId(id, 'pg')).toBe(false);
    expect(isId(`${id}a`, 'wal')).toBe(false);
    expect(isId(id.toUpperCase(), 'wal')).toBe(false);
    expect(isId(id.replace(/.$/, '1'), 'wal')).toBe(false); // base32 不含 0/1/8/9
    expect(isId(123, 'wal')).toBe(false);
  });
});

describe('generateToken（contracts 3 令牌格式表）', () => {
  const cases: [TokenKind, string, number, RegExp][] = [
    ['agentToken', 'nmt_', 43, /^nmt_[A-Za-z0-9_-]{43}$/],
    ['pageCredential', 'nmc_', 43, /^nmc_[A-Za-z0-9_-]{43}$/],
    ['session', 'nms_', 43, /^nms_[A-Za-z0-9_-]{43}$/],
    ['invite', 'inv_', 26, /^inv_[a-z2-7]{26}$/],
    ['publicLink', 'pub_', 32, /^pub_[A-Za-z0-9_-]{32}$/],
  ];

  it.each(cases)('%s：%s + %i 个字符', (kind, prefix, bodyLength, pattern) => {
    const token = generateToken(kind);
    expect(token.startsWith(prefix)).toBe(true);
    expect(token.length - prefix.length).toBe(bodyLength);
    expect(token).toMatch(pattern);
    expect(isTokenFormat(token, kind)).toBe(true);
    expect(tokenPattern(kind).test(token)).toBe(true);
    // 解码后字节数与 contracts 一致
    const format = TOKEN_FORMATS[kind];
    if (format.encoding === 'base64url') {
      expect(Buffer.from(token.slice(prefix.length), 'base64url')).toHaveLength(format.bytes);
    }
  });

  it('只存哈希的令牌与明文保存的令牌', () => {
    expect(TOKEN_FORMATS.agentToken.storedAsHash).toBe(true);
    expect(TOKEN_FORMATS.pageCredential.storedAsHash).toBe(true);
    expect(TOKEN_FORMATS.session.storedAsHash).toBe(true);
    expect(TOKEN_FORMATS.invite.storedAsHash).toBe(false);
    expect(TOKEN_FORMATS.publicLink.storedAsHash).toBe(false);
  });

  it('随机且不重复；格式检查拒绝错误前缀、长度与字符', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken('pageCredential')));
    expect(tokens.size).toBe(1000);
    const credential = generateToken('pageCredential');
    expect(isTokenFormat(credential, 'agentToken')).toBe(false);
    expect(isTokenFormat(`${credential}A`, 'pageCredential')).toBe(false);
    expect(isTokenFormat(credential.slice(0, -1), 'pageCredential')).toBe(false);
    expect(isTokenFormat(`${credential.slice(0, -1)}=`, 'pageCredential')).toBe(false);
    expect(isTokenFormat(generateToken('invite').toUpperCase(), 'invite')).toBe(false);
    expect(isTokenFormat(generateId('pbl'), 'publicLink')).toBe(false);
    expect(isTokenFormat(null, 'session')).toBe(false);
  });
});

describe('hashToken / constantTimeEqual', () => {
  it('SHA-256 hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const token = generateToken('agentToken');
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(generateToken('agentToken')));
  });

  it('常量时间比较：相等、不等、长度不同', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('abc', '')).toBe(false);
    const hash = hashToken('x');
    expect(constantTimeEqual(hash, hashToken('x'))).toBe(true);
    expect(constantTimeEqual(hash, hashToken('y'))).toBe(false);
  });
});

describe('generateLoginCode', () => {
  it('6 位数字（含前导零）', () => {
    for (let i = 0; i < 200; i += 1) expect(generateLoginCode()).toMatch(/^\d{6}$/);
  });
});

describe('containsCredentialLike', () => {
  it('发现凭证与一次性 token，可重复调用', () => {
    const credential = generateToken('pageCredential');
    const token = generateToken('agentToken');
    expect(containsCredentialLike(`const k = "${credential}";`)).toBe(true);
    expect(containsCredentialLike(`/nowme-page wal_x ${token}`)).toBe(true);
    expect(containsCredentialLike(`x${credential}`)).toBe(true);
    expect(containsCredentialLike(`x${credential}`)).toBe(true);
    expect(containsCredentialLike('nmc_ 只是提到前缀')).toBe(false);
    expect(containsCredentialLike(generateToken('session'))).toBe(false);
  });
});
