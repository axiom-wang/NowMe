import { afterEach, describe, expect, it } from 'vitest';
import { createTestWeb, get, login, type TestWeb } from '../helpers.js';

let t: TestWeb;
afterEach(async () => { await t?.close(); });

describe('顶栏 Demo 外链的安全性', () => {
  it('只是不带用户信息的普通 https 链接：无表单、无 target、rel 含 noopener，不影响 404 与 CSP', async () => {
    t = createTestWeb({ env: { NOWME_DEMO_URL: 'https://demo.example.com:8444' } });
    const { cookie } = await login(t, 'sec@example.com', '小江');
    for (const opts of [{}, { cookie }]) {
      const response = await get(t, '/missing-page', opts);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-security-policy')).toBeTruthy();
      const html = await response.text();
      const tags = html.match(/<a\b[^>]*href="https:\/\/demo\.example\.com:8444\/"[^>]*>/g) ?? [];
      expect(tags.length).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag).toContain('rel="noopener"');
        expect(tag).not.toContain('target=');
      }
      expect(html).not.toMatch(/https:\/\/demo\.example\.com:8444\/\?/);
    }
  });

  it('未配置时 404 页面与以前一致：不出现任何外部地址', async () => {
    t = createTestWeb();
    const html = await (await get(t, '/missing-page')).text();
    expect(html).not.toContain('demo.example.com');
  });
});
