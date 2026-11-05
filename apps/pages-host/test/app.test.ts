import { describe, expect, it } from 'vitest';
import { loadConfig, PAGE_SECURITY_HEADERS } from '@nowme/contracts';
import { createApp } from '../src/app.js';

describe('页面托管（占位）', () => {
  const app = createApp({ ...loadConfig({}), ticketSecret: 'x'.repeat(32) });

  it.each(['/', '/v/anything/', '/_nowme/kit/v1/nowme.css', '/api/agent/context'])('%s 返回 404', async (path) => {
    const response = await app.request(path);
    expect(response.status).toBe(404);
  });

  it('所有响应带安全头、不设 cookie', async () => {
    const response = await app.request('/', { headers: { cookie: 'nowme_session=abc' } });
    for (const [name, value] of Object.entries(PAGE_SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
