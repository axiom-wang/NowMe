import { afterEach, expect, it } from 'vitest';
import { choiceLabel, isDefaultChecked } from '../src/hosted/brief.js';
import { createUser, get, login, postForm, seedWall, type TestWeb } from './helpers.js';
import { completeInterview, createHostedTestWeb, generate, interviewFields, joinAs, postMultipart } from './hosted-helpers.js';
import { post } from './publish-helpers.js';

let web: TestWeb | undefined;
afterEach(async () => { await web?.close(); });

it('默认勾选标注支持附加说明，显示和保存的选项文字一致', () => {
  for (const label of ['显示学校（默认勾选，组队时有用）', '显示学校（默认勾选）']) {
    expect(isDefaultChecked(label)).toBe(true);
    expect(choiceLabel(label)).toBe('显示学校');
  }
  expect(isDefaultChecked('可以放本人的照片')).toBe(false);
});

it('采访被拦截保留本次文字、选择与风格，不保存被拦内容；取消默认选项仍保持取消', async () => {
  const t = createHostedTestWeb(); web = t;
  const { wall } = seedWall(t, createUser(t, 'org@example.com'));
  const owner = await joinAs(t, wall, 'member@example.com', '成员');
  const path = `/w/${wall.id}/me/create`;
  const initial = await (await get(t, path, { cookie: owner.session.cookie })).text();
  expect(initial).toMatch(/name="q_boundaries_0"[^>]*checked/);
  expect(initial).not.toContain('默认勾选');
  const material = '我的素材'.repeat(100) + '稳赚不赔';
  const response = await postMultipart(t, path + '/start', { ...interviewFields(owner.session, material), q_skills_1: '1', q_role_text: '补充说明' }, [], { cookie: owner.session.cookie });
  expect(response.status).toBe(422);
  const html = await response.text();
  expect(html).toContain(material);
  expect(html).toMatch(/name="q_skills_1"[^>]*checked/);
  expect(html).toMatch(/name="q_role" value="0"[^>]*checked/);
  expect(html).toContain('value="补充说明"');
  expect(html).toMatch(/name="style_hackathon-terminal"[^>]*checked/);
  expect(html).toMatch(/name="motion" value="calm"[^>]*checked/);
  expect(html).not.toMatch(/name="q_boundaries_0"[^>]*checked/);
  expect(t.repos.briefs.findForPage(owner.member.page.id, owner.session.userId)).toBeNull();
  expect(t.fake.calls).toHaveLength(0);
});

it('AI 设置失败保留两套地址、模型、开关，但不回显 Key', async () => {
  web = createHostedTestWeb({ env: { NOWME_AI_ENCRYPTION_KEY: 'ab'.repeat(32) } });
  const session = await login(web, 'ai@example.com');
  const response = await postForm(web, '/account/ai', {
    _csrf: session.csrf, interview_provider: 'deepseek', interview_baseUrl: 'http://localhost/v1', interview_model: 'my-model', interview_vision: '1', interview_apiKey: 'secret-never-echo',
    generate_provider: 'deepseek', generate_baseUrl: 'https://example.com/v1', generate_model: 'other-model',
  }, { cookie: session.cookie });
  expect(response.status).toBe(422);
  const html = await response.text();
  for (const value of ['http://localhost/v1', 'my-model', 'https://example.com/v1', 'other-model']) expect(html).toContain(`value="${value}"`);
  expect(html).toMatch(/name="interview_vision"[^>]*checked/);
  expect(html).not.toMatch(/name="shared"[^>]*checked/);
  expect(html).not.toContain('secret-never-echo');
});

it('修改遇到忙碌和内容检查时回显要求、目标区块与版本，不跳到缺失锚点', async () => {
  const t = createHostedTestWeb(); web = t;
  const { wall } = seedWall(t, createUser(t, 'org@example.com'));
  const owner = await joinAs(t, wall, 'member@example.com', '成员');
  await completeInterview(t, wall, owner);
  const generated = await generate(t, wall, owner);
  const revisionId = generated.job!.revisionId!;
  t.repos.jobs.create({ id: 'gen_aaaaaaaaaaaaaaaaaaaaaaaaaa', pageId: owner.member.page.id, ownerId: owner.session.userId, kind: 'generate', baseRevisionId: null, targetBlock: null, requestText: null, createdAt: t.clock.now().toISOString() });
  for (const request of ['标题再大一点', '标题写稳赚不赔']) {
    const response = await post(t, owner.session, `/w/${wall.id}/me/edit`, { revisionId, block: 'hero', request });
    expect(response.status).toBe(422);
    expect(response.headers.get('location')).toBeNull();
    const html = await response.text();
    expect(html).toContain(request);
    expect(html).toContain(`name="revisionId" value="${revisionId}"`);
    expect(html).toContain('value="hero" selected');
  }
});
