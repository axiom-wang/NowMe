import { describe, expect, it } from 'vitest';
import { buildWebCsp, loadConfig } from '@nowme/contracts';
import { createApp } from '../src/app.js';

describe('主站（占位）', () => {
  const config = loadConfig({});
  const app = createApp(config);

  it('首页返回占位页', async () => {
    const response = await app.request('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>NOWMe</title>');
    expect(html).toContain('lang="zh-CN"');
  });

  it('所有响应都带主站 CSP', async () => {
    for (const path of ['/', '/missing']) {
      const response = await app.request(path);
      expect(response.headers.get('content-security-policy')).toBe(buildWebCsp({ pagesOrigin: config.pagesOrigin }));
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('未知路径 404', async () => {
    expect((await app.request('/missing')).status).toBe(404);
  });
});
