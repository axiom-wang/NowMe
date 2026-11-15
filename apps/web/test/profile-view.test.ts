import { afterEach, describe, expect, it } from 'vitest';
import { generateId } from '@nowme/contracts';
import { createTestWeb, get, login, type TestWeb } from './helpers.js';

let t: TestWeb;
afterEach(async () => { await t?.close(); });

describe('资料页', () => {
  it('使用真实昵称、清晰的空状态和当前导航', async () => {
    t = createTestWeb();
    const session = await login(t, 'profile@example.com', '小江');
    const response = await get(t, '/account/data', { cookie: session.cookie });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('page--data');
    expect(html).toContain('/static/profile.css');
    expect(html).toContain('href="/account/data" aria-current="page"');
    expect(html).toContain('<h2>小江</h2>');
    expect(html).toContain('还没有长期画像');
    expect(html).not.toContain('profile-more__closed');
    expect(html).toContain('还没有保存的采访资料');
  });

  it('超过六条可展开，条目操作保留确认和 CSRF，文本安全转义', async () => {
    t = createTestWeb();
    const session = await login(t, 'profile@example.com');
    for (let i = 0; i < 8; i++) {
      t.repos.profileEntries.insert({ id: generateId('pfe'), userId: session.userId, category: 'fact', text: `画像 ${i} <script>`, source: 'interview', confirmation: 'owner-confirmed', createdAt: t.clock.now().toISOString(), updatedAt: t.clock.now().toISOString() });
    }
    const html = await (await get(t, '/account/data', { cookie: session.cookie })).text();
    const [initial, rest] = html.split('<details class="profile-more">');
    expect(initial?.match(/class="profile-row"/g)).toHaveLength(6);
    expect(rest?.match(/class="profile-row"/g)).toHaveLength(2);
    expect(html).toContain('展开全部 8 条');
    expect(html).toContain('画像 0 &lt;script&gt;');
    expect(html).toContain('data-confirm="删除这条画像？无法恢复。"');
    expect(html).toContain(session.csrf);
    expect(html).toContain('各面墙的采访资料（0 份）');
  });
});
