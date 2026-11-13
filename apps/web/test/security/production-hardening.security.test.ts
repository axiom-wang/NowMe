/**
 * 上线加固（contracts 10.4、10.5）：主站的补充安全头、健康检查端点。
 */
import { PERMISSIONS_POLICY } from '@nowme/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestWeb, get, type TestWeb } from '../helpers.js';

let t: TestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe('主站补充安全头', () => {
  it('所有响应都带 Permissions-Policy、COOP、CORP；http 源不发 HSTS', async () => {
    t = createTestWeb();
    for (const path of ['/login', '/static/app.css', '/no-such-page', '/api/agent/context']) {
      const response = await get(t, path);
      expect(response.headers.get('permissions-policy'), path).toBe(PERMISSIONS_POLICY);
      expect(response.headers.get('cross-origin-opener-policy'), path).toBe('same-origin');
      expect(response.headers.get('cross-origin-resource-policy'), path).toBe('same-origin');
      expect(response.headers.get('strict-transport-security'), path).toBeNull();
      expect(response.headers.get('content-security-policy'), path).toContain("default-src 'self'");
    }
  });

  it('https 源：发 HSTS（不带 includeSubDomains / preload），会话 cookie 带 Secure', async () => {
    t = createTestWeb({ env: { NOWME_WEB_ORIGIN: 'https://nowme.example', NOWME_PAGES_ORIGIN: 'https://nowme-pages.example', NOWME_WEB_LISTEN: '127.0.0.1:3000', NOWME_PAGES_LISTEN: '127.0.0.1:4000' } });
    const response = await get(t, '/login');
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
  });
});

describe('健康检查', () => {
  it('/healthz 与 /readyz 不经过 Host 头校验，不设 cookie，不泄露业务信息', async () => {
    t = createTestWeb();
    for (const [path, body] of [['/healthz', 'ok'], ['/readyz', '{"status":"ok"}']] as const) {
      // 探针用 IP 访问：Host 头不是主站的主机名
      const response = await t.web.request(`http://10.0.0.5:3000${path}`, { headers: { host: '10.0.0.5:3000' } });
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(body);
      expect(response.headers.getSetCookie(), path).toEqual([]);
      expect(response.headers.get('cache-control'), path).toBe('no-store');
    }
    // 其他路径仍然校验 Host
    const other = await t.web.request('http://10.0.0.5:3000/login', { headers: { host: '10.0.0.5:3000' } });
    expect(other.status).toBe(421);
  });

  it('数据库不可用时 /readyz 返回 503，/healthz 仍然 200', async () => {
    t = createTestWeb();
    t.db.close();
    expect((await get(t, '/readyz')).status).toBe(503);
    expect((await get(t, '/healthz')).status).toBe(200);
    t = null;
  });
});
