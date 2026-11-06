/**
 * CREDENTIAL_LEAK（contracts 2.2、S4）：任何文件中出现 nmc_ / nmt_ 凭证，或名为 credentials 的文件。
 */
import { generateToken } from '@nowme/contracts';
import { describe, expect, it } from 'vitest';
import { codes, issuesOf, makePage, makeSkeletonPage, png, run, summary, text } from '../fixtures.js';

const credential = generateToken('pageCredential');
const agentToken = generateToken('agentToken');

describe('CREDENTIAL_LEAK', () => {
  it('index.html 注释里的页面凭证（带行号，报告里不出现凭证全文）', () => {
    const report = run(makeSkeletonPage({ body: `<!-- ${credential} -->` }));
    const issue = issuesOf(report, 'CREDENTIAL_LEAK')[0];
    expect(issue?.severity).toBe('error');
    expect(issue?.file).toBe('index.html');
    expect(issue?.line).toBeGreaterThan(1);
    expect(JSON.stringify(report)).not.toContain(credential);
    expect(JSON.stringify(report)).not.toContain(credential.slice(4, 24));
  });

  it('脚本字符串里的一次性 token', () => {
    expect(codes(run(makeSkeletonPage({ script: `const t = '${agentToken}';` })))).toContain('CREDENTIAL_LEAK');
  });

  it('card.json / manifest.json 里', () => {
    const card = makePage({ card: { schemaVersion: 1, displayName: '阿柚', tagline: credential.slice(0, 30), hooks: [] } });
    expect(issuesOf(run(card), 'CREDENTIAL_LEAK')[0]?.file).toBe('card.json');
    const manifest = makePage({ manifest: { schemaVersion: 1, generator: { token: agentToken } } });
    expect(issuesOf(run(manifest), 'CREDENTIAL_LEAK')[0]?.file).toBe('manifest.json');
  });

  it('二进制文件（按单字节扫描）', () => {
    const image = png(2, 2);
    const leaked = new Uint8Array(image.length + 60);
    leaked.set(image);
    leaked.set(text(credential), image.length);
    const report = run(makePage({ files: { 'assets/hero.png': leaked, 'cover.png': leaked.slice() } }));
    const files = issuesOf(report, 'CREDENTIAL_LEAK').map((issue) => issue.file);
    expect(files).toContain('assets/hero.png');
    expect(files).toContain('cover.png');
  });

  it('白名单外（不会上传）的文件里也报', () => {
    const report = run(makePage({ files: { 'notes/brief.md': `凭证：${credential}` } }));
    expect(issuesOf(report, 'CREDENTIAL_LEAK')[0]?.file).toBe('notes/brief.md');
  });

  it('名为 credentials 的文件', () => {
    for (const name of ['credentials', 'credentials.json', '.nowme/credentials', 'assets/credentials']) {
      const report = run(makePage({ files: { [name]: '{}' } }));
      expect(codes(report), name).toContain('CREDENTIAL_LEAK');
    }
  });

  it('不误报：只有前缀、太短、其他前缀的令牌', () => {
    const report = run(
      makeSkeletonPage({
        body: '<p>凭证格式是 nmc_ 开头，例如 nmc_abc；会话 nms_abcdefghijklmnopqrstuvwxyz0123456789；邀请 inv_abcdefghijklmnopqrstuvwxyz</p>',
      }),
    );
    expect(codes(report), summary(report)).not.toContain('CREDENTIAL_LEAK');
    expect(report.errors, summary(report)).toEqual([]);
  });
});
