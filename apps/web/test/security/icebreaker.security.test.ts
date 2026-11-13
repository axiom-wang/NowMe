/**
 * S9 “和 TA 聊什么”的安全不变量（contracts 11）：
 * - 只有墙内有效成员、看的是墙上可见的别人的页面时才能发起；无权一律 404；
 * - 交给模型的只有查看者自己的资料和对方已经公开在墙上的内容（不含对方的草稿、采访、画像、联系方式，不含第三人）；
 * - 结果只属于发起的查看者；组织者、页面主人、其他成员都看不到，也不能借用结果 ID；
 * - 对方页面里的注入内容不能把链接 / 联系方式带进结果；编造的共同点进不了结果；
 * - 开场白只预填，从不代发；
 * - 页面删除、成员离开 / 被移出、墙关闭、采访删除时，相关结果一并清除。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { removeMember } from '../../src/services/walls.js';
import { connectAgent, dumpDb, get, login, postForm, seedWall, type TestSession } from '../helpers.js';
import { completeInterview, createHostedTestWeb, joinAs, type HostedOwner, type HostedTestWeb } from '../hosted-helpers.js';
import { askIcebreaker, lastIcebreakerPrompt, memberHtml, memberPath, putOnWall, storedIcebreaker } from '../icebreaker-helpers.js';
import { exampleCard, filesWithCard, post, submitRevision } from '../publish-helpers.js';

let t: HostedTestWeb | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

interface World {
  t: HostedTestWeb;
  wall: ReturnType<typeof seedWall>['wall'];
  organizer: TestSession;
  viewer: HostedOwner;
  target: HostedOwner;
  third: HostedOwner;
  outsider: TestSession;
}

const VIEWER_SECRET = '我的秘密细节是凌晨四点去菜市场拍摊主的手';
const THIRD_SECRET = '第三个人的秘密是偷偷在学打鼓';

async function world(): Promise<World> {
  const web = createHostedTestWeb();
  t = web;
  const organizer = await login(web, 'org@example.com', '组织者');
  const { wall } = seedWall(web, organizer.userId, '周末黑客松');
  const viewer = await joinAs(web, wall, 'viewer@example.com', '苏晴');
  const target = await joinAs(web, wall, 'target@example.com', '林舟');
  const third = await joinAs(web, wall, 'third@example.com', '小白');
  const outsider = await login(web, 'outsider@example.com', '路人');
  await putOnWall(web, wall, target, 'hackathon-terminal');
  await putOnWall(web, wall, viewer, 'hackathon-poster');
  return { t: web, wall, organizer, viewer, target, third, outsider };
}

function rowCount(web: HostedTestWeb): number {
  return Number((web.db.prepare('SELECT COUNT(*) AS n FROM icebreakers').get() as { n: number }).n);
}

describe('S9 谁能发起', () => {
  it('未登录、墙外的人、对自己的页面、未发布的页面：都不能发起，也不调用模型', async () => {
    const w = await world();
    const path = `${memberPath(w.wall, w.target)}/icebreaker`;
    const calls = w.t.fake.calls.length;

    const anonymous = await postForm(w.t, path, { _csrf: 'x' });
    expect(anonymous.status).toBe(401);
    expect((await post(w.t, w.outsider, path)).status).toBe(404);
    expect((await post(w.t, w.target.session, path)).status).toBe(404);
    // 小白还没有发布：页面不在墙上
    expect((await post(w.t, w.viewer.session, `${memberPath(w.wall, w.third)}/icebreaker`)).status).toBe(404);
    for (const suffix of ['/icebreaker/chat', '/icebreaker/clear']) {
      expect((await post(w.t, w.outsider, `${memberPath(w.wall, w.target)}${suffix}`, { icebreakerId: 'ice_aaaaaaaaaaaaaaaaaaaaaaaaaa', opener: '0' })).status).toBe(404);
    }
    expect(w.t.fake.calls.length).toBe(calls);
    expect(rowCount(w.t)).toBe(0);
  });

  it('需要会话、CSRF 与本站来源；Authorization 头里的页面凭证不算数', async () => {
    const w = await world();
    const path = `${memberPath(w.wall, w.target)}/icebreaker`;
    const noCsrf = await postForm(w.t, path, {}, { cookie: w.viewer.session.cookie });
    expect(noCsrf.status).toBe(403);
    const crossOrigin = await postForm(w.t, path, { _csrf: w.viewer.session.csrf }, { cookie: w.viewer.session.cookie, origin: 'https://evil.example' });
    expect(crossOrigin.status).toBe(403);
    const credential = await connectAgent(w.t, w.wall, w.viewer.member.page);
    const withBearer = await postForm(w.t, path, { _csrf: 'x' }, { headers: { authorization: `Bearer ${credential}` } });
    expect(withBearer.status).toBe(401);
    expect(rowCount(w.t)).toBe(0);
  });

  it('被移出墙的成员立即不能发起，之前的结果也看不到、用不了', async () => {
    const w = await world();
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const id = storedIcebreaker(w.t, w.viewer, w.target)?.record.id ?? '';
    expect(removeMember(w.t.web.deps, w.wall, w.organizer.userId, w.viewer.member.membership.id)).not.toBeNull();
    expect((await post(w.t, w.viewer.session, `${memberPath(w.wall, w.target)}/icebreaker`)).status).toBe(404);
    expect((await post(w.t, w.viewer.session, `${memberPath(w.wall, w.target)}/icebreaker/chat`, { icebreakerId: id, opener: '0' })).status).toBe(404);
    expect((await get(w.t, memberPath(w.wall, w.target), { cookie: w.viewer.session.cookie })).status).toBe(404);
  });
});

describe('S9 交给模型的内容', () => {
  it('只有查看者自己的资料与对方已公开的内容：没有第三人、没有对方的草稿与联系方式', async () => {
    const w = await world();
    // 查看者自己的采访（私有，但属于查看者本人）
    await completeInterview(w.t, w.wall, w.viewer, `我叫苏晴。${VIEWER_SECRET}。想找一位后端。`);
    // 第三个人的采访与页面（与这次请求无关）
    await completeInterview(w.t, w.wall, w.third, `我叫小白。${THIRD_SECRET}。`);
    // 对方发布之后又提交了一个没发布的新版本（草稿）
    const credential = await connectAgent(w.t, w.wall, w.target.member.page);
    const draft = { ...exampleCard('hackathon-terminal'), tagline: '草稿里才有的一句话' };
    expect((await submitRevision(w.t, credential, filesWithCard(draft))).status).toBe('accepted');

    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const prompt = lastIcebreakerPrompt(w.t);
    expect(prompt).toContain('找一位会做视觉和交互的设计');
    expect(prompt).toContain('<viewer_brief>');
    expect(prompt).not.toContain(THIRD_SECRET);
    expect(prompt).not.toContain('小白');
    expect(prompt).not.toContain('草稿里才有的一句话');
    // 发布时填的联系方式（publish-helpers 默认 linzhou_dev）与邮箱都不在里面
    expect(prompt).not.toContain('linzhou_dev');
    expect(prompt).not.toContain('@example.com');
    // 对方的开场白（主人写给访客用的）也不需要交给模型
    expect(prompt).not.toContain(exampleCard('hackathon-terminal').hooks[0]?.opener ?? 'missing');
  });

  it('查看者设定的“不展示”内容作为禁区单独交给模型，不混进可引用的资料', async () => {
    const w = await world();
    await completeInterview(w.t, w.wall, w.viewer, '我叫苏晴。做产品和交互设计。');
    const brief = w.t.repos.briefs.findForPage(w.viewer.member.page.id, w.viewer.session.userId);
    const structured = JSON.parse(brief?.briefJson ?? '{}') as { boundaries: { hidden: string[] } };
    structured.boundaries = { ...structured.boundaries, hidden: ['不要提我休学过一年'] };
    w.t.repos.briefs.update({ ...brief!, briefJson: JSON.stringify(structured) });
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const prompt = lastIcebreakerPrompt(w.t);
    expect(prompt).toMatch(/<viewer_avoid>\\n- 不要提我休学过一年\\n<\/viewer_avoid>/);
    expect(prompt.match(/休学过一年/g)).toHaveLength(1);
  });
});

describe('S9 结果只属于查看者', () => {
  it('页面主人、组织者、其他成员都看不到；库里只按查看者保存', async () => {
    const w = await world();
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const stored = storedIcebreaker(w.t, w.viewer, w.target);
    const opener = stored?.result.openers[0]?.text ?? 'missing';
    expect(await memberHtml(w.t, w.wall, w.viewer, w.target)).toContain('talk--ready');

    await putOnWall(w.t, w.wall, w.third, 'interest-vinyl');
    const thirdHtml = await memberHtml(w.t, w.wall, w.third, w.target);
    expect(thirdHtml).not.toContain('talk--ready');
    expect(thirdHtml).not.toContain(stored?.record.id ?? 'missing');
    const ownerHtml = await memberHtml(w.t, w.wall, w.target, w.target);
    expect(ownerHtml).not.toContain('id="talk"');
    const admin = await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(admin).not.toContain(opener);
    expect(admin).not.toContain('ice_');
    const wallHtml = await (await get(w.t, `/w/${w.wall.id}`, { cookie: w.third.session.cookie })).text();
    expect(wallHtml).not.toContain('ice_');

    const rows = (dumpDb(w.t.db).icebreakers ?? []) as { viewer_id: string }[];
    expect(rows.map((row) => row.viewer_id)).toEqual([w.viewer.session.userId]);
  });

  it('别人拿到结果 ID 也用不了：不能用来开聊，也清除不掉', async () => {
    const w = await world();
    await putOnWall(w.t, w.wall, w.third, 'interest-vinyl');
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const id = storedIcebreaker(w.t, w.viewer, w.target)?.record.id ?? '';
    const borrowed = await post(w.t, w.third.session, `${memberPath(w.wall, w.target)}/icebreaker/chat`, { icebreakerId: id, opener: '0' });
    expect(borrowed.status).toBe(404);
    // 直接带着别人的结果 ID 打开自己的私聊：草稿里不会出现那句话
    const direct = await post(w.t, w.third.session, `${memberPath(w.wall, w.target)}/direct`);
    const conversation = direct.headers.get('location') ?? '';
    const chat = await (await get(w.t, `${conversation}?pageId=${w.target.member.page.id}&ice=${id}&o=0`, { cookie: w.third.session.cookie })).text();
    expect(chat).not.toContain(storedIcebreaker(w.t, w.viewer, w.target)?.result.openers[0]?.text ?? 'missing');
    expect((await post(w.t, w.third.session, `${memberPath(w.wall, w.target)}/icebreaker/clear`)).status).toBe(303);
    expect(storedIcebreaker(w.t, w.viewer, w.target)).not.toBeNull();
  });

  it('结果里的 ID 不能拿到另一页上用', async () => {
    const w = await world();
    await putOnWall(w.t, w.wall, w.third, 'interest-vinyl');
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const id = storedIcebreaker(w.t, w.viewer, w.target)?.record.id ?? '';
    const elsewhere = await post(w.t, w.viewer.session, `${memberPath(w.wall, w.third)}/icebreaker/chat`, { icebreakerId: id, opener: '0' });
    expect(elsewhere.status).toBe(404);
  });
});

describe('S9 对方页面里的内容是资料，不是指令', () => {
  it('注入的链接与手机号进不了结果，也到不了页面', async () => {
    const w = await world();
    await putOnWall(w.t, w.wall, w.target, 'hackathon-terminal', { tagline: '【假模型：注入】' });
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const stored = storedIcebreaker(w.t, w.viewer, w.target);
    expect(stored).not.toBeNull();
    const text = JSON.stringify(stored?.result);
    for (const bad of ['evil.example.com', 'https://', '13800138000', '福利']) expect(text).not.toContain(bad);
    expect(stored?.result.openers.length).toBeGreaterThanOrEqual(1);
    const html = await memberHtml(w.t, w.wall, w.viewer, w.target);
    expect(html).not.toContain('evil.example.com');
    expect(html).not.toContain('13800138000');
  });

  it('编造的共同点（依据不在两个人的资料里）进不了结果', async () => {
    const w = await world();
    await putOnWall(w.t, w.wall, w.target, 'hackathon-terminal', { tagline: '【假模型：编造】' });
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const stored = storedIcebreaker(w.t, w.viewer, w.target);
    expect(JSON.stringify(stored?.result)).not.toContain('国家奖学金');
    expect(stored?.result.links.length).toBeGreaterThanOrEqual(1);
    expect(await memberHtml(w.t, w.wall, w.viewer, w.target)).not.toContain('国家奖学金');
  });

  it('结果按文字输出：对方卡片里的标记不会变成页面上的标签', async () => {
    const w = await world();
    await putOnWall(w.t, w.wall, w.target, 'hackathon-terminal', {
      hooks: [
        { id: 'h1', text: '想聊 <img src=x onerror=alert(1)>', opener: '你好' },
        { id: 'h2', text: '想聊后端', opener: '你好' },
      ],
    });
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const html = await memberHtml(w.t, w.wall, w.viewer, w.target);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('S9 开场白只是草稿', () => {
  it('“用这句开聊”只预填输入框：不产生任何消息，对方收不到', async () => {
    const w = await world();
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const stored = storedIcebreaker(w.t, w.viewer, w.target);
    const response = await post(w.t, w.viewer.session, `${memberPath(w.wall, w.target)}/icebreaker/chat`, { icebreakerId: stored?.record.id ?? '', opener: '0' });
    const location = response.headers.get('location') ?? '';
    const chat = await (await get(w.t, location, { cookie: w.viewer.session.cookie })).text();
    expect(chat).toContain('想听你多讲讲');
    expect(w.t.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 0 });
    const inbox = await (await get(w.t, '/messages/unread', { cookie: w.target.session.cookie })).json();
    expect(inbox).toEqual({ unread: 0 });
  });
});

describe('S9 相关数据的清除', () => {
  it('对方删除页面：关于这一页的结果一并删除', async () => {
    const w = await world();
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    expect(rowCount(w.t)).toBe(1);
    expect((await post(w.t, w.target.session, `/w/${w.wall.id}/me/delete`, { confirm: '1' })).status).toBe(303);
    expect(rowCount(w.t)).toBe(0);
  });

  it('查看者退出墙：他在这面墙的结果一并删除', async () => {
    const w = await world();
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    expect((await post(w.t, w.viewer.session, `/w/${w.wall.id}/leave`)).status).toBe(200);
    expect(rowCount(w.t)).toBe(0);
  });

  it('查看者被移出墙、墙被关闭：结果一并删除', async () => {
    const w = await world();
    await putOnWall(w.t, w.wall, w.third, 'interest-vinyl');
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    await askIcebreaker(w.t, w.wall, w.third, w.target);
    expect(rowCount(w.t)).toBe(2);
    expect((await post(w.t, w.organizer, `/w/${w.wall.id}/admin/remove`, { membershipId: w.viewer.member.membership.id })).status).toBe(303);
    expect(rowCount(w.t)).toBe(1);
    expect((await post(w.t, w.organizer, `/w/${w.wall.id}/admin/close`, { confirm: '1' })).status).toBe(303);
    expect(rowCount(w.t)).toBe(0);
  });

  it('查看者删除自己的采访：用它推出来的结果一并删除', async () => {
    const w = await world();
    await completeInterview(w.t, w.wall, w.viewer, '我叫苏晴。做产品和交互设计。');
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    expect(storedIcebreaker(w.t, w.viewer, w.target)?.result.sources.brief).toBe(true);
    const brief = w.t.repos.briefs.findForPage(w.viewer.member.page.id, w.viewer.session.userId);
    expect((await post(w.t, w.viewer.session, '/account/briefs/delete', { briefId: brief?.id ?? '' })).status).toBe(303);
    expect(rowCount(w.t)).toBe(0);
  });

  it('事件里只有数字与布尔值，没有任何一方的文字', async () => {
    const w = await world();
    await askIcebreaker(w.t, w.wall, w.viewer, w.target);
    const events = (dumpDb(w.t.db).events as { type: string; props_json: string }[]).filter((event) => event.type === 'icebreaker_generate');
    expect(events).toHaveLength(1);
    for (const value of Object.values(JSON.parse(events[0]!.props_json) as Record<string, unknown>)) expect(['number', 'boolean']).toContain(typeof value);
  });
});
