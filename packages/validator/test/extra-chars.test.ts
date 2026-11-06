/**
 * computeExtraChars 与 EXTRA_CHARS_MISSING / stats.scriptOnlyChars。
 */
import { describe, expect, it } from 'vitest';
import { VALID_MANIFEST, codes, issuesOf, makeSkeletonPage, run } from './fixtures.js';
import { computeExtraChars } from '../src/index.js';

/** 骨架页的静态文本是“你好 / 项目 / 队友 / 测试页（title）”。 */
const page = (parts: Parameters<typeof makeSkeletonPage>[0], extraChars = '') =>
  makeSkeletonPage(parts, { manifest: { ...VALID_MANIFEST, fonts: [], blocks: undefined, extraChars }, rawManifest: true });

describe('computeExtraChars', () => {
  it('只取脚本里出现、静态文本里没有的中文字符，去重并按码点排序', () => {
    const files = page({ script: "const a = '欢迎你好呀 hello 123 🎉'; const b = `欢迎${a}呀`;" });
    // “你”“好”在静态文本里；英文、数字、emoji 不算
    expect(computeExtraChars(files)).toBe([...'欢迎呀'].sort((x, y) => (x.codePointAt(0) ?? 0) - (y.codePointAt(0) ?? 0)).join(''));
  });

  it('与已有 extraChars 合并（保留已有字符、去掉空白）', () => {
    const files = page({ script: "const a = '欢迎';" }, '龙 迎\nABC');
    const result = computeExtraChars(files);
    expect(Array.from(result).sort()).toEqual(['A', 'B', 'C', '欢', '迎', '龙'].sort());
    expect(result).toBe([...new Set(Array.from(result))].join(''));
    const codesInOrder = Array.from(result).map((char) => char.codePointAt(0) ?? 0);
    expect(codesInOrder).toEqual([...codesInOrder].sort((x, y) => x - y));
  });

  it('包含中文标点与扩展区汉字，不含全角空格', () => {
    const files = page({ script: "const a = '“走吧”，　出发！𠀀';" });
    expect(Array.from(computeExtraChars(files)).sort()).toEqual(['“', '”', '，', '！', '走', '吧', '出', '发', '𠀀'].sort());
  });

  it('JSON 数据块里的字算脚本字符；正文、CSS content、alt / placeholder 算静态文本；注释不算', () => {
    const files = page({
      style: '.tag::before { content: "新"; }',
      body: '<script type="application/json">{"q": "新朋伙伴"}</script><img src="data:image/png;base64,AA==" alt="朋"><input placeholder="请"><!-- 注释里的字 -->',
      script: "// 注释里的字\nconst x = '请问';",
    });
    // “新”在 CSS content 里、“朋”在 alt 里、“请”在 placeholder 里
    expect(computeExtraChars(files)).toBe('伙伴问');
  });

  it('缺 index.html 或 manifest 时也能工作', () => {
    const files = page({ script: "const a = '欢';" });
    files.delete('manifest.json');
    expect(computeExtraChars(files)).toBe('欢');
    files.delete('index.html');
    expect(computeExtraChars(files)).toBe('');
  });
});

describe('EXTRA_CHARS_MISSING', () => {
  it('列出缺少的字；补全后不再报', () => {
    const files = page({ script: "document.title = '欢迎光临';" });
    const issue = issuesOf(run(files), 'EXTRA_CHARS_MISSING')[0];
    expect(issue?.severity).toBe('warning');
    expect(issue?.file).toBe('manifest.json');
    expect(issue?.message).toContain('4 个');
    const filled = page({ script: "document.title = '欢迎光临';" }, computeExtraChars(files));
    expect(codes(run(filled))).not.toContain('EXTRA_CHARS_MISSING');
    expect(run(filled).stats.scriptOnlyChars).toBe(computeExtraChars(files));
  });
});
