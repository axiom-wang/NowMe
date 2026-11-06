/** 小单元：指令格式（contracts 4.3）、上传过滤、报告合并、串行队列、票据地址。 */
import { describe, expect, it } from 'vitest';
import { generateToken, issueTicket, verifyTicket } from '@nowme/contracts';
import { createReport } from '@nowme/validator';
import { formatCommand, formatPlainText } from '../src/services/instruction.js';
import { createSerialQueue } from '../src/services/queue.js';
import { prepareUploadedFiles, withIgnoredFiles } from '../src/services/submissions.js';
import { createTicketIssuer, pageViewUrl } from '../src/services/tickets.js';
import { b64, START, TEST_SECRET } from './helpers.js';

describe('Agent 指令（contracts 4.3）', () => {
  const wallId = 'wal_abcdefghijklmnopqrstuvwxyz';
  const token = generateToken('agentToken');

  it('一行指令：/nowme-page <wallId> <token> --server <主站源>', () => {
    expect(formatCommand(wallId, token, 'http://localhost:3000')).toBe(`/nowme-page ${wallId} ${token} --server http://localhost:3000`);
  });

  it('纯文本说明：包含等价的 nowme fetch 命令、隐私规则与“不能替我发布”', () => {
    const text = formatPlainText({ wallName: '周末黑客松', wallId, token, server: 'http://localhost:3000', expiresAt: START });
    expect(text).toContain('「周末黑客松」');
    expect(text).toContain(`nowme fetch ${wallId} ${token} --server http://localhost:3000`);
    expect(text).toContain('nowme validate page');
    expect(text).toContain('nowme preview page');
    expect(text).toContain('nowme submit page');
    expect(text).toContain('brief.md 只留在本地');
    expect(text).toContain('不要写进 page/');
    expect(text).toContain('你不能替我发布');
    expect(text).toContain('data-nm-href');
    expect(text).toContain(`http://localhost:3000/w/${wallId}/me`);
    expect(text).toContain('2026/11/06 16:00'); // 北京时间
  });
});

describe('上传过滤', () => {
  it('只保留白名单路径；系统文件静默丢弃；其余丢弃并列出', () => {
    const { files, ignored } = prepareUploadedFiles({
      'index.html': b64('<p>x</p>'),
      'card.json': b64('{}'),
      'manifest.json': b64('{}'),
      'cover.png': b64('png'),
      'assets/a.png': b64('a'),
      'assets/sub/b.png': b64('b'),
      'assets/.DS_Store': b64('x'),
      'Thumbs.db': b64('x'),
      'assets/desktop.ini': b64('x'),
      'brief.md': b64('私密'),
      '../x': b64('x'),
      'credentials': b64('x'),
      'index.html/': b64('x'),
      'a\u0000b': b64('x'),
    });
    expect([...files.keys()].sort()).toEqual(['assets/a.png', 'assets/sub/b.png', 'card.json', 'cover.png', 'index.html', 'manifest.json']);
    expect(Buffer.from(files.get('index.html') as Uint8Array).toString()).toBe('<p>x</p>');
    expect(ignored.sort()).toEqual(['../x', 'a\u0000b', 'brief.md', 'credentials', 'index.html/'].sort());
  });

  it('IGNORED_FILE 警告并入报告，不影响 ok；疑似凭证被遮住', () => {
    const report = createReport([], { indexHtmlBytes: 0, assetBytes: 0, assetCount: 0, blocks: [], fontsUsed: [], cjkFontCount: 0, scriptOnlyChars: '', ignoredFiles: [] });
    const credential = generateToken('pageCredential');
    const merged = withIgnoredFiles(report, ['brief.md', `leak-${credential}`, 'x'.repeat(200)]);
    expect(merged.ok).toBe(true);
    expect(merged.warnings.map((issue) => issue.code)).toEqual(['IGNORED_FILE', 'IGNORED_FILE', 'IGNORED_FILE']);
    expect(JSON.stringify(merged)).not.toContain(credential);
    expect(merged.warnings[1]?.file).toBe(`leak-${credential.slice(0, 8)}…`);
    expect(Array.from(merged.warnings[2]?.file ?? '').length).toBe(81);
    expect(withIgnoredFiles(report, [])).toBe(report);
  });
});

describe('串行队列', () => {
  it('同一时刻只执行一个任务，按顺序完成；失败不影响后续任务', async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    let active = 0;
    const task = (name: string, fail = false) =>
      queue.run(async () => {
        active += 1;
        expect(active).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(name);
        active -= 1;
        if (fail) throw new Error(name);
        return name;
      });
    const results = await Promise.allSettled([task('a'), task('b', true), task('c')]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(order).toEqual(['a', 'b', 'c']);
    await queue.idle();
    expect(queue.size).toBe(0);
  });
});

describe('票据签发', () => {
  it('src 为 <pagesOrigin>/v/<ticket>/，票据可被校验', () => {
    const issuer = createTicketIssuer({ secret: TEST_SECRET, pagesOrigin: 'http://127.0.0.1:4000', now: () => START });
    const issued = issuer.issue('rev_abcdefghijklmnopqrstuvwxyz');
    expect(issued.src).toBe(pageViewUrl('http://127.0.0.1:4000', issued.ticket));
    expect(issued.src).toMatch(/^http:\/\/127\.0\.0\.1:4000\/v\/rev_[a-z2-7]{26}\.\d+\.[A-Za-z0-9_-]{43}\/$/);
    expect(issued.ticket).toBe(issueTicket('rev_abcdefghijklmnopqrstuvwxyz', TEST_SECRET, START));
    expect(verifyTicket(issued.ticket, TEST_SECRET, START).ok).toBe(true);
  });
});
