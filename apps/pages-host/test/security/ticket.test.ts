import { describe, expect, it } from 'vitest';
import { signTicket } from '@nowme/contracts';
import { REV_A, REV_B, SECRET, makeFixture } from '../helpers.js';

describe('票据校验：一律 404 且不泄露原因', () => {
  const { app, ticket } = makeFixture();
  const good = ticket(REV_A);
  const [rev, exp, sig] = good.split('.') as [string, string, string];
  const flip = (s: string) => s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');

  const cases: Record<string, string> = {
    格式错: 'garbage',
    空段: '..',
    缺签名: `${rev}.${exp}`,
    签名错: `${rev}.${exp}.${flip(sig)}`,
    过期: signTicket({ revisionId: REV_A, expiresAt: new Date(Date.now() - 5000), secret: SECRET }),
    篡改过期时间: `${rev}.${Number(exp) + 9999}.${sig}`,
    篡改版本: `${REV_B}.${exp}.${sig}`,
    错误密钥: signTicket({
      revisionId: REV_A,
      expiresAt: new Date(Date.now() + 60000),
      secret: 'other-'.padEnd(40, 'y'),
    }),
    版本不存在: ticket('rev_cccccccccccccccccccccccccc'),
  };

  for (const [name, t] of Object.entries(cases)) {
    it(name, async () => {
      for (const suffix of ['/', '/index.html', '/assets/a.png', '/_fonts/test-400.woff2']) {
        const res = await app.request(`/v/${t}${suffix}`);
        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).toBe('Not Found');
        expect(body).not.toMatch(/expired|signature|malformed|revision|过期|签名/i);
      }
    });
  }

  it('A 版本票据只能访问 A 版本内容', async () => {
    expect(await (await app.request(`/v/${good}/`)).text()).toContain(REV_A);
    expect(await (await app.request(`/v/${ticket(REV_B)}/`)).text()).toContain(REV_B);
  });

  it('缺失票据', async () => {
    expect((await app.request('/v/')).status).toBe(404);
    expect((await app.request('/v')).status).toBe(404);
  });
});
