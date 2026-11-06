import { describe, expect, it } from 'vitest';
import { PAGE_SECURITY_HEADERS, buildPageCsp, parseCsp } from '@nowme/contracts';
import { PAGES_ORIGIN, WEB_ORIGIN, makeFixture } from '../helpers.js';

describe('S2 页面托管响应头', () => {
  const { app, ticket } = makeFixture();
  const t = ticket();

  it('页面文档 CSP 与 buildPageCsp 完全一致，并逐项满足 S2', async () => {
    const res = await app.request(`/v/${t}/`, { headers: { cookie: 'nowme_session=abc' } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toBe(buildPageCsp({ pagesOrigin: PAGES_ORIGIN, ticket: t, frameAncestors: WEB_ORIGIN }));
    const d = parseCsp(csp);
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('connect-src')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('frame-ancestors')).toEqual([WEB_ORIGIN]);
    expect(d.get('sandbox')).toEqual(['allow-scripts']);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain("'self'");
    expect(csp.split(/[\s;]+/)).not.toContain('*');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  const urls = () => [
    '/',
    '/nope',
    `/v/${t}/`,
    `/v/${t}/index.html`,
    `/v/${t}/assets/a.png`,
    `/v/${t}/_fonts/test-400.woff2`,
    `/v/${t}`,
    '/_nowme/kit/v1/nowme.css',
    '/_nowme/kit/v1/nowme.js',
    '/v/bad/',
  ];

  it('所有响应都带安全头、不设 cookie', async () => {
    for (const url of urls()) {
      const res = await app.request(url, { headers: { cookie: 'nowme_session=abc' } });
      for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) {
        expect(res.headers.get(name), `${url} ${name}`).toBe(value);
      }
      expect(res.headers.get('set-cookie'), url).toBeNull();
      expect(res.headers.get('content-security-policy'), url).toBeTruthy();
    }
    const post = await app.request(`/v/${t}/`, { method: 'POST' });
    expect(post.headers.get('set-cookie')).toBeNull();
    expect(post.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('非 HTML 响应使用严格 CSP', async () => {
    for (const url of [`/v/${t}/assets/a.png`, `/v/${t}/_fonts/test-400.woff2`, '/_nowme/kit/v1/nowme.css', '/x']) {
      const res = await app.request(url);
      expect(res.headers.get('content-security-policy'), url).toBe("default-src 'none'");
    }
  });

  it('字体响应 ACAO *，其他响应没有', async () => {
    const font = await app.request(`/v/${t}/_fonts/test-400.woff2`);
    expect(font.headers.get('access-control-allow-origin')).toBe('*');
    const page = await app.request(`/v/${t}/`);
    expect(page.headers.get('access-control-allow-origin')).toBeNull();
  });
});
