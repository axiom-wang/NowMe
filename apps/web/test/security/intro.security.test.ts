/**
 * S14 “AI 介绍值得认识的人”的安全不变量（contracts 20）：
 * - 只有这面墙的有效成员能发起，只介绍这面墙上对他可见的人；无权一律 404，且不调用模型；
 * - 交给模型的只有查看者自己的资料和候选已经公开在墙上的内容（不含名字、草稿、采访、联系方式，
 *   不含没上墙的人、互相拉黑的人）；
 * - 结果只属于查看者；被介绍的人、组织者、其他成员都看不到，也不产生通知或消息；
 * - 页面里的注入内容不能把链接 / 联系方式带进结果；编造的理由进不了结果；
 * - 对方更新 / 撤下 / 拉黑后那一位立即消失；退出、移除、关闭墙、删除页面与采访、注销时结果一并删除。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { removeMember } from '../../src/services/walls.js';
import { confirmDeletion, downloadExport, requestDeletionCode } from '../account-helpers.js';
import { connectAgent, dumpDb, get, postForm } from '../helpers.js';
import { completeInterview } from '../hosted-helpers.js';
import { putOnWall } from '../icebreaker-helpers.js';
import { askIntro, introCalls, introPath, introRows, introWorld, lastIntroPrompt, storedIntro, wallHtml, type IntroWorld } from '../intro-helpers.js';
import { exampleCard, filesWithCard, post, submitRevision } from '../publish-helpers.js';

let w: IntroWorld | null = null;
afterEach(async () => {
  await w?.t.close();
  w = null;
});

const PENDING_SECRET = '还没上墙的人偷偷在学打鼓';
const VIEWER_SECRET = '我的秘密细节是凌晨四点去菜市场拍摊主的手';

describe('S14 谁能发起', () => {
  it('未登录、墙外的人：不能发起、不能清除，也不调用模型', async () => {
    w = await introWorld();
    const anonymous = await postForm(w.t, introPath(w.wall), { _csrf: 'x' });
    expect(anonymous.status).toBe(401);
    expect((await post(w.t, w.outsider, introPath(w.wall))).status).toBe(404);
    expect((await post(w.t, w.outsider, introPath(w.wall), { fragment: '1' })).status).toBe(404);
    expect((await post(w.t, w.outsider, `${introPath(w.wall)}/clear`)).status).toBe(404);
    expect(introCalls(w.t)).toBe(0);
    expect(introRows(w.t)).toBe(0);
  });

  it('需要会话、CSRF 与本站来源；Authorization 头里的页面凭证不算数', async () => {
    w = await introWorld();
    const path = introPath(w.wall);
    expect((await postForm(w.t, path, {}, { cookie: w.viewer.session.cookie })).status).toBe(403);
    expect((await postForm(w.t, path, { _csrf: w.viewer.session.csrf }, { cookie: w.viewer.session.cookie, origin: 'https://evil.example' })).status).toBe(403);
    const credential = await connectAgent(w.t, w.wall, w.viewer.member.page);
    expect((await postForm(w.t, path, { _csrf: 'x' }, { headers: { authorization: `Bearer ${credential}` } })).status).toBe(401);
    expect(introCalls(w.t)).toBe(0);
  });

  it('被移出墙的成员立即不能发起，之前的结果一并删除', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    expect(introRows(w.t)).toBe(1);
    expect(removeMember(w.t.web.deps, w.wall, w.organizer.userId, w.viewer.member.membership.id)).not.toBeNull();
    expect(introRows(w.t)).toBe(0);
    const calls = introCalls(w.t);
    expect((await post(w.t, w.viewer.session, introPath(w.wall))).status).toBe(404);
    expect(introCalls(w.t)).toBe(calls);
  });
});

describe('S14 交给模型的内容', () => {
  it('只有查看者自己的资料与候选公开在墙上的内容：没有名字、草稿、联系方式、没上墙的人', async () => {
    w = await introWorld();
    await completeInterview(w.t, w.wall, w.viewer, `我叫苏晴。${VIEWER_SECRET}。想找一位后端。`);
    // 还没上墙的人做完了采访：与这次请求无关
    await completeInterview(w.t, w.wall, w.pending, `我叫小白。${PENDING_SECRET}。`);
    // 林舟发布之后又提交了一个没发布的新版本（草稿）
    const credential = await connectAgent(w.t, w.wall, w.targets[0]!.member.page);
    expect((await submitRevision(w.t, credential, filesWithCard({ ...exampleCard('hackathon-terminal'), tagline: '草稿里才有的一句话' }))).status).toBe('accepted');

    await askIntro(w.t, w.wall, w.viewer);
    const prompt = lastIntroPrompt(w.t);
    expect(prompt).toContain('我能帮你把接口和数据库搭起来');
    expect(prompt).toContain('<viewer_brief>');
    expect(prompt).toContain(VIEWER_SECRET); // 查看者本人的采访：属于他自己
    expect(prompt).not.toContain(PENDING_SECRET);
    expect(prompt).not.toContain('草稿里才有的一句话');
    for (const name of ['林舟', '阿岚', '栗子', '小白']) expect(prompt).not.toContain(name);
    // 发布时填的联系方式（publish-helpers 默认 linzhou_dev）、邮箱、别人写给访客的开场白都不在里面
    expect(prompt).not.toContain('linzhou_dev');
    expect(prompt).not.toContain('@example.com');
    expect(prompt).not.toContain(exampleCard('hackathon-terminal').hooks[0]?.opener ?? 'missing');
  });

  it('互相拉黑的人不在候选里，之前的介绍里也立即消失', async () => {
    w = await introWorld();
    // 墙上 4 位别人：拉黑一位之后还剩 3 位，仍然可以介绍
    await putOnWall(w.t, w.wall, w.pending, 'club-newbie-sticker');
    await askIntro(w.t, w.wall, w.viewer);
    // 候选顺序是随机的：拉黑被介绍的第一位
    const firstPick = storedIntro(w.t, w.viewer, w.wall)!.picks[0]!.pageId;
    const blocked = [...w.targets, w.pending].find((item) => item.member.page.id === firstPick)!;
    const blockedHook = (await import('../../src/services/wall-view.js')).parsePublishedCard(
      w.t.db.prepare('SELECT card_json FROM publications WHERE page_id = ? AND ended_at IS NULL').get(blocked.member.page.id)!.card_json as string,
      '',
    ).hooks[1]!.text;
    // 被介绍的人拉黑了查看者（查看者不会知道）
    w.t.repos.moderation.block(blocked.session.userId, w.viewer.session.userId, w.t.clock.now().toISOString());
    const html = await wallHtml(w.t, w.wall, w.viewer.session);
    expect(html).not.toContain(`/p/${blocked.member.page.id}`);
    const calls = introCalls(w.t);
    await askIntro(w.t, w.wall, w.viewer);
    expect(introCalls(w.t)).toBeGreaterThan(calls);
    expect(lastIntroPrompt(w.t)).not.toContain(blockedHook);
    expect(storedIntro(w.t, w.viewer, w.wall)?.picks.some((pick) => pick.pageId === blocked.member.page.id)).toBe(false);
  });
});

describe('S14 结果只属于查看者', () => {
  it('被介绍的人、组织者、其他成员都看不到，也没有消息或通知', async () => {
    w = await introWorld();
    const mails = w.t.outbox.messages.length;
    await askIntro(w.t, w.wall, w.viewer);
    const record = storedIntro(w.t, w.viewer, w.wall)!;
    const target = w.targets.find((item) => item.member.page.id === record.picks[0]!.pageId)!;
    const reason = record.picks[0]!.reason;
    expect(await wallHtml(w.t, w.wall, w.viewer.session)).toContain(reason);

    for (const session of [target.session, w.organizer, w.targets[1]!.session]) {
      const html = await wallHtml(w.t, w.wall, session);
      expect(html).not.toContain(reason);
      expect(html).not.toContain('✦ AI 介绍');
      expect(html).not.toContain(record.id);
    }
    const ownPage = await (await get(w.t, `/w/${w.wall.id}/p/${target.member.page.id}`, { cookie: target.session.cookie })).text();
    expect(ownPage).not.toContain('AI 介绍你们认识');
    const admin = await (await get(w.t, `/w/${w.wall.id}/admin`, { cookie: w.organizer.cookie })).text();
    expect(admin).not.toContain(reason);
    expect(admin).not.toContain('itr_');
    // 被介绍的人看别人的页面时也看不到这条（只有查看者 → 对方这个方向）
    const reverse = await (await get(w.t, `/w/${w.wall.id}/p/${w.viewer.member.page.id}`, { cookie: target.session.cookie })).text();
    expect(reverse).not.toContain('AI 介绍你们认识');

    expect(w.t.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 0 });
    expect(w.t.outbox.messages).toHaveLength(mails);
    const rows = (dumpDb(w.t.db).intros ?? []) as { viewer_id: string }[];
    expect(rows.map((row) => row.viewer_id)).toEqual([w.viewer.session.userId]);
  });

  it('清除只清自己的：别人发起清除不影响查看者的结果', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    expect((await post(w.t, w.targets[1]!.session, `${introPath(w.wall)}/clear`)).status).toBe(303);
    expect(storedIntro(w.t, w.viewer, w.wall)).not.toBeNull();
  });
});

describe('S14 别人页面里的内容是资料，不是指令', () => {
  it('注入的链接与手机号进不了结果，也到不了页面', async () => {
    w = await introWorld();
    await putOnWall(w.t, w.wall, w.targets[0]!, 'hackathon-terminal', { tagline: '【假模型：注入】' });
    await askIntro(w.t, w.wall, w.viewer);
    const record = storedIntro(w.t, w.viewer, w.wall);
    expect(record?.picks.length).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(record);
    for (const bad of ['evil.example.com', 'https://', '13800138000', '福利']) expect(text).not.toContain(bad);
    const html = await wallHtml(w.t, w.wall, w.viewer.session);
    expect(html).not.toContain('evil.example.com');
    expect(html).not.toContain('13800138000');
  });

  it('编造的理由（依据不在资料里）与越界的编号进不了结果', async () => {
    w = await introWorld();
    await putOnWall(w.t, w.wall, w.targets[0]!, 'hackathon-terminal', { tagline: '【假模型：编造】' });
    await askIntro(w.t, w.wall, w.viewer);
    const record = storedIntro(w.t, w.viewer, w.wall);
    expect(JSON.stringify(record)).not.toContain('国家奖学金');
    expect(JSON.stringify(record)).not.toContain('不存在的人');
    expect(record?.picks).toHaveLength(3);
  });

  it('结果按文字输出：卡片里的标记不会变成墙上的标签', async () => {
    w = await introWorld();
    await putOnWall(w.t, w.wall, w.targets[0]!, 'hackathon-terminal', {
      hooks: [
        { id: 'h1', text: '想聊 <img src=x onerror=alert(1)>', opener: '你好' },
        { id: 'h2', text: '想聊后端', opener: '你好' },
      ],
    });
    await askIntro(w.t, w.wall, w.viewer);
    expect(JSON.stringify(storedIntro(w.t, w.viewer, w.wall))).toContain('<img src=x');
    const html = await wallHtml(w.t, w.wall, w.viewer.session);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('S14 相关数据的清除', () => {
  it('被介绍的人撤下页面：那一位立即消失；删除页面：引用它的结果一并删除', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    const target = w.targets[0]!;
    expect((await post(w.t, target.session, `/w/${w.wall.id}/me/withdraw`)).status).toBe(303);
    expect(await wallHtml(w.t, w.wall, w.viewer.session)).not.toContain(`/p/${target.member.page.id}"`);
    expect((await post(w.t, target.session, `/w/${w.wall.id}/me/delete`, { confirm: '1' })).status).toBe(303);
    expect(introRows(w.t)).toBe(0);
  });

  it('查看者删除自己的页面、退出墙：他在这面墙的结果一并删除', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    expect((await post(w.t, w.viewer.session, `/w/${w.wall.id}/me/delete`, { confirm: '1' })).status).toBe(303);
    expect(introRows(w.t)).toBe(0);
    await putOnWall(w.t, w.wall, w.viewer, 'hackathon-poster');
    await askIntro(w.t, w.wall, w.viewer);
    expect(introRows(w.t)).toBe(1);
    expect((await post(w.t, w.viewer.session, `/w/${w.wall.id}/leave`)).status).toBe(200);
    expect(introRows(w.t)).toBe(0);
  });

  it('墙被关闭：整面墙的结果一并删除', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    await askIntro(w.t, w.wall, w.targets[0]!);
    expect(introRows(w.t)).toBe(2);
    expect((await post(w.t, w.organizer, `/w/${w.wall.id}/admin/close`, { confirm: '1' })).status).toBe(303);
    expect(introRows(w.t)).toBe(0);
  });

  it('查看者删除自己的采访：用它推出来的结果一并删除', async () => {
    w = await introWorld();
    await completeInterview(w.t, w.wall, w.viewer, '我叫苏晴。做产品和交互设计。');
    await askIntro(w.t, w.wall, w.viewer);
    expect(storedIntro(w.t, w.viewer, w.wall)?.sources.brief).toBe(true);
    const brief = w.t.repos.briefs.findForPage(w.viewer.member.page.id, w.viewer.session.userId);
    expect((await post(w.t, w.viewer.session, '/account/briefs/delete', { briefId: brief?.id ?? '' })).status).toBe(303);
    expect(introRows(w.t)).toBe(0);
  });

  it('数据导出只有自己的、仍然有效的介绍；注销账号时一并删除', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    await askIntro(w.t, w.wall, w.targets[0]!);
    const mine = (await downloadExport(w.t, w.viewer.session)).data.intros as { wallName: string; picks: { about: string }[] }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]?.wallName).toBe('周末黑客松');
    expect(mine[0]?.picks.length).toBe(3);
    expect(mine[0]?.picks.map((pick) => pick.about)).not.toContain('苏晴');

    const { code } = await requestDeletionCode(w.t, w.viewer.session);
    expect((await confirmDeletion(w.t, w.viewer.session, code!)).status).toBe(200);
    const rows = (dumpDb(w.t.db).intros ?? []) as { viewer_id: string }[];
    expect(rows.map((row) => row.viewer_id)).not.toContain(w.viewer.session.userId);
    // 注销的人的页面被删除：别人得到的、引用了他页面文字的介绍也一并删掉
    const picks = (dumpDb(w.t.db).intro_picks ?? []) as { page_id: string }[];
    expect(picks.some((pick) => pick.page_id === w!.viewer.member.page.id)).toBe(false);
    expect(storedIntro(w.t, w.targets[0]!, w.wall)).toBeNull();
  });

  it('事件里只有数字与布尔值，没有任何一方的文字', async () => {
    w = await introWorld();
    await askIntro(w.t, w.wall, w.viewer);
    const events = (dumpDb(w.t.db).events as { type: string; props_json: string }[]).filter((event) => event.type === 'intro_generate');
    expect(events).toHaveLength(1);
    const props = JSON.parse(events[0]!.props_json) as Record<string, unknown>;
    expect(props.first).toBe(true);
    for (const value of Object.values(props)) expect(['number', 'boolean']).toContain(typeof value);
  });
});
