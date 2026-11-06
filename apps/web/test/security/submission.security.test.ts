/**
 * S5：本地路线的 brief / 画像从不上传。提交接口丢弃白名单外文件（brief.md、profile、context.json、nowme.json 等），
 * 它们不会落盘，也不会出现在任何版本目录里；组织者与其他成员看不到它们。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RevisionResponse } from '@nowme/contracts';
import { connectAgent, createUser, createTestWeb, exampleFiles, listFiles, postJson, seedMember, seedWall, b64, type TestWeb } from '../helpers.js';

let t: TestWeb;
beforeEach(() => {
  t = createTestWeb();
});
afterEach(async () => {
  await t.close();
});

describe('S5 提交接口丢弃白名单外文件', () => {
  it('brief.md、画像、context.json、nowme.json、隐藏文件、穿越路径都不落盘', async () => {
    const owner = createUser(t, 'owner@example.com', '主人');
    const { wall } = seedWall(t, owner);
    const memberId = createUser(t, 'm@example.com', '成员');
    const { page } = seedMember(t, wall, memberId);
    const credential = await connectAgent(t, wall, page);
    const secret = 'PRIVATE-BRIEF-CONTENT-12345';
    const files = {
      ...exampleFiles(),
      'brief.md': b64(secret),
      'profile.json': b64(secret),
      'context.json': b64(secret),
      'nowme.json': b64(secret),
      '.env': b64(secret),
      '../outside.txt': b64(secret),
      'notes/diary.md': b64(secret),
    };
    const response = await postJson(t, '/api/agent/revisions', { files }, credential);
    expect(response.status).toBe(201);
    const { revision } = (await response.json()) as RevisionResponse;
    const ignored = revision.report.stats.ignoredFiles.join();
    for (const name of ['brief.md', 'profile.json', 'context.json', 'nowme.json']) expect(ignored).toContain(name);

    const stored = listFiles(t.dataDir);
    expect(stored.filter((file) => /brief|profile|context\.json|nowme\.json|diary|outside|\.env/.test(file))).toEqual([]);
    // 任何落盘文件的内容里都没有私密内容
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const file of stored) {
      if (/\.(png|woff2|jpg|webp)$/.test(file)) continue;
      expect(readFileSync(join(t.dataDir, file), 'utf8'), file).not.toContain(secret);
    }
  });
});
