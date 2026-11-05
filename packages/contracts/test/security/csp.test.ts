import { describe, expect, it } from 'vitest';
import {
  buildPageCsp,
  buildWebCsp,
  DEFAULT_PAGES_ORIGIN,
  DEFAULT_PREVIEW_PAGES_ORIGIN,
  DEFAULT_PREVIEW_SHELL_ORIGIN,
  DEFAULT_WEB_ORIGIN,
  PAGE_IFRAME_SANDBOX,
  PAGE_SECURITY_HEADERS,
  parseCsp,
  signTicket,
} from '../../src/index.js';

const PAGES = DEFAULT_PAGES_ORIGIN; // http://127.0.0.1:4000
const WEB = DEFAULT_WEB_ORIGIN; // http://localhost:3000
const TICKET = signTicket({
  revisionId: 'rev_abcdefghijklmnopqrstuvwxyz',
  expiresAt: new Date('2026-11-06T08:30:00Z'),
  secret: 'test-secret-0123456789abcdefghijklmnop',
});

/** contracts S2 的完整期望（指令名 → 源列表，顺序即期望顺序）。 */
function expectedPageDirectives(pages: string, ticket: string, ancestors: string[]): [string, string[]][] {
  const kit = `${pages}/_nowme/kit/`;
  const images = [`${pages}/v/${ticket}/assets/`, kit, 'data:', 'blob:'];
  return [
    ['default-src', ["'none'"]],
    ['script-src', ["'unsafe-inline'", kit]],
    ['style-src', ["'unsafe-inline'", kit]],
    ['img-src', images],
    ['media-src', images],
    ['font-src', [`${pages}/v/${ticket}/_fonts/`]],
    ['connect-src', ["'none'"]],
    ['form-action', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['frame-ancestors', ancestors],
    ['sandbox', ['allow-scripts']],
  ];
}

function tokensOf(csp: string): string[] {
  return csp
    .split(';')
    .flatMap((part) => part.trim().split(/\s+/))
    .filter(Boolean);
}

describe('buildPageCsp（S2）', () => {
  const csp = buildPageCsp({ pagesOrigin: PAGES, ticket: TICKET, frameAncestors: WEB });
  const directives = parseCsp(csp);

  it.each(expectedPageDirectives(PAGES, TICKET, [WEB]))('%s 精确匹配', (name, values) => {
    expect(directives.get(name)).toEqual(values);
  });

  it('只有 S2 列出的 11 条指令，每条只出现一次', () => {
    const names = csp.split(';').map((part) => part.trim().split(/\s+/)[0]);
    expect(names).toEqual(expectedPageDirectives(PAGES, TICKET, [WEB]).map(([name]) => name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('序列化形式稳定', () => {
    expect(csp).toBe(
      [
        "default-src 'none'",
        `script-src 'unsafe-inline' ${PAGES}/_nowme/kit/`,
        `style-src 'unsafe-inline' ${PAGES}/_nowme/kit/`,
        `img-src ${PAGES}/v/${TICKET}/assets/ ${PAGES}/_nowme/kit/ data: blob:`,
        `media-src ${PAGES}/v/${TICKET}/assets/ ${PAGES}/_nowme/kit/ data: blob:`,
        `font-src ${PAGES}/v/${TICKET}/_fonts/`,
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        `frame-ancestors ${WEB}`,
        'sandbox allow-scripts',
      ].join('; '),
    );
  });

  it("不含 'unsafe-eval'、'self'、通配符 *，也不放开同源等沙箱能力", () => {
    const tokens = tokensOf(csp);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('wasm-unsafe-eval');
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('strict-dynamic');
    expect(csp).not.toContain('unsafe-hashes');
    for (const flag of ['allow-same-origin', 'allow-top-navigation', 'allow-forms', 'allow-popups', 'allow-modals']) {
      expect(csp).not.toContain(flag);
    }
    // 没有裸的 scheme 源（例如 https: 会放开所有 https 站点）
    expect(tokens.filter((token) => /^[a-z]+:$/.test(token)).sort()).toEqual(['blob:', 'blob:', 'data:', 'data:']);
  });

  it('预览时 frame-ancestors 为预览外壳源，其余来源指向预览页面源', () => {
    const preview = parseCsp(
      buildPageCsp({ pagesOrigin: DEFAULT_PREVIEW_PAGES_ORIGIN, ticket: TICKET, frameAncestors: DEFAULT_PREVIEW_SHELL_ORIGIN }),
    );
    for (const [name, values] of expectedPageDirectives(DEFAULT_PREVIEW_PAGES_ORIGIN, TICKET, [DEFAULT_PREVIEW_SHELL_ORIGIN])) {
      expect(preview.get(name)).toEqual(values);
    }
  });

  it('frameAncestors 可以给多个源；源末尾的斜杠被规范化', () => {
    const multi = parseCsp(
      buildPageCsp({ pagesOrigin: `${PAGES}/`, ticket: TICKET, frameAncestors: [`${WEB}/`, 'https://nowme.example'] }),
    );
    expect(multi.get('frame-ancestors')).toEqual([WEB, 'https://nowme.example']);
    expect(multi.get('script-src')).toEqual(["'unsafe-inline'", `${PAGES}/_nowme/kit/`]);
  });

  it('拒绝可能注入 CSP 的源', () => {
    const bad = [
      '*',
      "'self'",
      'http://*.example.com',
      'http://127.0.0.1:4000; script-src *',
      'http://127.0.0.1:4000/path',
      'http://127.0.0.1:4000?x=1',
      'http://user:pass@127.0.0.1:4000',
      'javascript:alert(1)',
      'data:',
      'HTTP://127.0.0.1:4000',
      'http://LOCALHOST:3000',
      'http://localhost:80',
      '',
    ];
    for (const origin of bad) {
      expect(() => buildPageCsp({ pagesOrigin: origin, ticket: TICKET, frameAncestors: WEB }), origin).toThrow();
      expect(() => buildPageCsp({ pagesOrigin: PAGES, ticket: TICKET, frameAncestors: origin }), origin).toThrow();
    }
    expect(() => buildPageCsp({ pagesOrigin: PAGES, ticket: TICKET, frameAncestors: [] })).toThrow();
  });

  it('拒绝可能注入 CSP 或改变路径的票据', () => {
    for (const ticket of ['', '.', '..', 'a b', 'a;b', 'a,b', 'a/b', "a'b", 'a\nb', 'a*', 'x'.repeat(257)]) {
      expect(() => buildPageCsp({ pagesOrigin: PAGES, ticket, frameAncestors: WEB }), ticket).toThrow();
    }
    // 预览时可以用占位路径段
    expect(() => buildPageCsp({ pagesOrigin: PAGES, ticket: 'preview', frameAncestors: WEB })).not.toThrow();
  });
});

describe('PAGE_SECURITY_HEADERS（S2）', () => {
  it('nosniff、no-referrer', () => {
    expect(PAGE_SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(PAGE_SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });

  it('Permissions-Policy 禁用摄像头、麦克风、定位等', () => {
    const policy = PAGE_SECURITY_HEADERS['Permissions-Policy'] ?? '';
    const entries = policy.split(',').map((entry) => entry.trim());
    for (const feature of ['camera', 'microphone', 'geolocation', 'display-capture', 'usb', 'payment']) {
      expect(entries).toContain(`${feature}=()`);
    }
    // 每一项都是“全部禁用”
    for (const entry of entries) expect(entry).toMatch(/^[a-z-]+=\(\)$/);
  });

  it('不设任何 cookie、不可修改', () => {
    const names = Object.keys(PAGE_SECURITY_HEADERS).map((name) => name.toLowerCase());
    expect(names).not.toContain('set-cookie');
    expect(Object.isFrozen(PAGE_SECURITY_HEADERS)).toBe(true);
  });
});

describe('buildWebCsp（主站 CSP）', () => {
  it('精确等于 contracts 第 5 节末尾的五条指令', () => {
    const csp = buildWebCsp({ pagesOrigin: PAGES });
    expect(csp).toBe(`frame-src ${PAGES}; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    const directives = parseCsp(csp);
    expect([...directives.keys()]).toEqual(['frame-src', 'script-src', 'object-src', 'base-uri', 'frame-ancestors']);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('*');
  });

  it('拒绝非法的页面托管源', () => {
    expect(() => buildWebCsp({ pagesOrigin: '*' })).toThrow();
    expect(() => buildWebCsp({ pagesOrigin: 'http://127.0.0.1:4000 https:' })).toThrow();
  });
});

describe('PAGE_IFRAME_SANDBOX（S1）', () => {
  it('只有 allow-scripts', () => {
    expect(PAGE_IFRAME_SANDBOX).toBe('allow-scripts');
  });
});
