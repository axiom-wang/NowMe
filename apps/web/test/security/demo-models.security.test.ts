import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionDemoModels } from '../../scripts/demo-models.js';
import { DEMO_ACCOUNTS, DEMO_WALL_NAME } from '../../src/demo-access.js';
import { postMultipart } from '../hosted-helpers.js';
import { createTestWeb, createUser, seedWall, seedMember, postForm, sessionTokenFrom, csrfOf, dumpDb, type TestWeb } from '../helpers.js';

const KEY = 'demo-secret-test-only';
const ENV = { NOWME_DEMO_PROVIDER: 'deepseek', NOWME_DEMO_MODEL: 'deepseek-chat', NOWME_DEMO_API_KEY: KEY };
const ENCRYPTION = { NOWME_AI_ENCRYPTION_KEY: 'ab'.repeat(32) };

describe('演示模型预置与管理保护', () => {
  let t: TestWeb;
  let memberId: string;
  let organizerId: string;
  let wallId: string;
  let transport: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive-provider-body', { status: 401 }));
    t = createTestWeb({ demo: true, secretEnv: ENCRYPTION, modelFetch: transport, modelLookup: async () => [{ address: '93.184.216.34', family: 4 }] });
    organizerId = createUser(t, DEMO_ACCOUNTS[1].email, '体验组织者');
    memberId = createUser(t, DEMO_ACCOUNTS[0].email, '体验成员');
    const { wall } = seedWall(t, organizerId, DEMO_WALL_NAME);
    seedMember(t, wall, memberId);
    wallId = wall.id;
  });
  afterEach(async () => { await t.close(); });

  it('复用save原子加密两个角色，只写成员账号，不发请求、不泄漏Key', async () => {
    const save = vi.spyOn(t.web.deps.userModels, 'save');
    expect(provisionDemoModels(t.web, ENV)).toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(t.web.deps.userModels.ready(memberId)).toBe(true);
    expect(t.web.deps.userModels.ready(organizerId)).toBe(false);
    const rows = t.db.prepare('SELECT * FROM user_model_settings').all();
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(JSON.stringify(rows)).not.toContain(ENCRYPTION.NOWME_AI_ENCRYPTION_KEY);
    const firstCiphertext = (rows[0] as { encrypted_key: string }).encrypted_key;
    provisionDemoModels(t.web, ENV);
    expect((t.db.prepare('SELECT * FROM user_model_settings').get() as { encrypted_key: string }).encrypted_key).not.toBe(firstCiphertext);
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    const cookie = `nowme_session=${sessionTokenFrom(response)}`;
    for (const path of ['/account/ai', `/w/${wallId}/me`, `/w/${wallId}/me/create`]) {
      const html = await (await t.request(path, { headers: { cookie } })).text();
      expect(html).toContain('演示模型已配置');
      expect(html).not.toContain(KEY);
      expect(html).not.toContain(firstCiphertext);
      expect(html).not.toContain('name="interview_apiKey"');
      expect(html).not.toContain('填写你自己的');
    }
  });

  it('支持两角色独立服务和Key，配置不完整不部分写入', () => {
    expect(provisionDemoModels(t.web, { ...ENV, NOWME_DEMO_GENERATE_PROVIDER: 'anthropic', NOWME_DEMO_GENERATE_MODEL: 'claude-test', NOWME_DEMO_GENERATE_API_KEY: 'other-test-key', NOWME_DEMO_GENERATE_BASE_URL: 'https://api.anthropic.com', NOWME_DEMO_GENERATE_VISION: '1' })).toBe(true);
    expect(t.web.deps.userModels.summary(memberId, 'interview')?.endpoint.provider).toBe('deepseek');
    expect(t.web.deps.userModels.summary(memberId, 'generate')?.endpoint.provider).toBe('anthropic');
    expect(t.web.deps.userModels.summary(memberId, 'generate')?.endpoint.vision).toBe(true);
    const before = dumpDb(t.db);
    expect(() => provisionDemoModels(t.web, { ...ENV, NOWME_DEMO_GENERATE_MODEL: '' })).toThrow('演示模型预置失败');
    expect(dumpDb(t.db)).toEqual(before);
  });

  it('两个体验身份均不能通过表单、目标ID或接口改写、删除任何模型配置', async () => {
    provisionDemoModels(t.web, ENV);
    for (const identity of ['member', 'organizer']) {
      const response = await postForm(t, '/login/demo', { identity });
      const token = sessionTokenFrom(response)!;
      const before = dumpDb(t.db);
      for (const path of ['/account/ai', '/account/ai/delete']) {
        expect((await postForm(t, path, { _csrf: csrfOf(t, token), userId: memberId, interview_apiKey: 'replacement' }, { cookie: `nowme_session=${token}` })).status).toBe(403);
      }
      expect(dumpDb(t.db)).toEqual(before);
    }
  });

  it('未配置时明确让维护者补齐，不伪装ready或调用假模型', async () => {
    expect(provisionDemoModels(t.web, {})).toBe(false);
    expect(provisionDemoModels(t.web, { NOWME_DEMO_DNS_SERVERS: '1.1.1.1' })).toBe(false);
    const response = await postForm(t, '/login/demo', { identity: 'member' });
    const html = await (await t.request(`/w/${wallId}/me/create`, { headers: { cookie: `nowme_session=${sessionTokenFrom(response)}` } })).text();
    expect(html).toContain('请维护者补齐');
    expect(html).not.toContain('演示模型已配置');
    expect(() => provisionDemoModels(t.web, { ...ENV, NOWME_DEMO_BASE_URL: 'http://127.0.0.1:11434' })).toThrow('演示模型预置失败');
    expect(t.web.deps.userModels.ready(memberId)).toBe(false);
  });

  it('模型拒绝凭证时显示维护者重试指引，保留素材且不回退假结果', async () => {
    provisionDemoModels(t.web, ENV);
    const loginResponse = await postForm(t, '/login/demo', { identity: 'member' });
    const token = sessionTokenFrom(loginResponse)!;
    const cookie = `nowme_session=${token}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await postMultipart(t, `/w/${wallId}/me/create/start`, { _csrf: csrfOf(t, token), material: '我叫阿柚，我想找设计搭档。', q_role: '0', motion: 'calm' }, [], { cookie });
      expect(response.status).toBe(422);
      const html = await response.text();
      expect(html).toContain('请维护者检查配置后重试');
      expect(html).toContain('我叫阿柚');
      expect(html).not.toContain('sensitive-provider-body');
      expect(html).not.toContain(KEY);
      expect(html).not.toContain('AI 设置');
      expect(html).toContain('下一步');
    }
    expect(transport).toHaveBeenCalledTimes(2);
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM revisions').get()).toEqual({ n: 0 });
    expect(t.db.prepare('SELECT status FROM briefs').get()).toEqual({ status: 'collecting' });
  });

  it('普通模式不能执行预置流程，缺少加密密钥不能保存', async () => {
    const normal = createTestWeb({ secretEnv: ENCRYPTION });
    const missing = createTestWeb({ demo: true });
    try {
      expect(() => provisionDemoModels(normal.web, ENV)).toThrow('只能由演示');
      expect(() => provisionDemoModels(missing.web, ENV)).toThrow('NOWME_AI_ENCRYPTION_KEY');
    } finally { await normal.close(); await missing.close(); }
  });
});
