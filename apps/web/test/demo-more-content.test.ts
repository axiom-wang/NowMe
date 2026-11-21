/** demo-more/ 里第二批演示人物页：目录与名单一一对应，通过页面契约，卡片、场景与页面内容对得上人，彼此结构不同。 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { cardSchema, manifestSchema } from '@nowme/contracts';
import { loadKitFonts } from '@nowme/kit';
import { validatePage } from '@nowme/validator';
import { DEMO_ADDITIONS, DEMO_MORE_DIR, type DemoAdditionWall } from '../scripts/demo-more.js';

const WALL: Record<DemoAdditionWall, { scene: 'hackathon' | 'club'; name: RegExp; kinds: string[] }> = {
  hackathon: { scene: 'hackathon', name: /NOWMe演示黑客松|演示黑客松/, kinds: ['can-help', 'looking-for', 'want-to-build'] },
  club: { scene: 'club', name: /山海摄影社/, kinds: ['ask-me', 'want-to-try', 'obsessed'] },
  ai: { scene: 'hackathon', name: /AI共创实验室|AI共创/, kinds: ['can-help', 'looking-for', 'want-to-build'] },
  trail: { scene: 'club', name: /山野轻徒步/, kinds: ['ask-me', 'want-to-try', 'obsessed'] },
};

type Node = { nodeName: string; value?: string; childNodes?: Node[]; attrs?: { name: string; value: string }[] };
const textOf = (node: Node): string => node.nodeName === '#text' ? node.value ?? ''
  : ['style', 'script'].includes(node.nodeName) ? '' : (node.childNodes ?? []).map(textOf).join('');
const find = (node: Node, name: string): Node[] => [
  ...(node.nodeName === name ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => find(child, name)),
];
const shape = (node: Node): string => ['#text', '#comment', 'style', 'head'].includes(node.nodeName) ? ''
  : `${node.nodeName}(${(node.childNodes ?? []).map(shape).join('')})`;
const read = (dir: string) => new Map(readdirSync(join(DEMO_MORE_DIR, dir)).map((name) => [name, readFileSync(join(DEMO_MORE_DIR, dir, name))]));

describe('第二批演示人物页（demo-more）', () => {
  it('目录与名单一一对应，名字与邮箱不重复', () => {
    const dirs = readdirSync(DEMO_MORE_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    expect(dirs).toEqual(DEMO_ADDITIONS.map((person) => person.dir).sort());
    expect(new Set(DEMO_ADDITIONS.map((person) => person.email)).size).toBe(DEMO_ADDITIONS.length);
    expect(new Set(DEMO_ADDITIONS.map((person) => person.name)).size).toBe(DEMO_ADDITIONS.length);
  });

  it.each(DEMO_ADDITIONS.map((person) => [person.dir, person] as const))('%s 通过校验，卡片与页面对得上人，不含联系方式', (dir, person) => {
    const files = read(dir);
    expect([...files.keys()].sort()).toEqual(['card.json', 'index.html', 'manifest.json']);
    const report = validatePage(files, { kitFonts: loadKitFonts() });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    const wall = WALL[person.wall];
    const card = cardSchema.parse(JSON.parse(files.get('card.json')!.toString()));
    const manifest = manifestSchema.parse(JSON.parse(files.get('manifest.json')!.toString()));
    expect(card.displayName).toBe(person.name);
    expect(manifest.sceneType).toBe(wall.scene);
    expect(manifest.blocks).toEqual(report.stats.blocks);
    expect(report.stats.blocks.length).toBeGreaterThanOrEqual(4);
    for (const hook of card.hooks) expect(wall.kinds).toContain(hook.kind);

    const html = files.get('index.html')!.toString();
    expect(html.length).toBeLessThan(60 * 1024);
    const document = parse(html) as unknown as Node;
    // 比较时去掉空白：页面可以用换行与空格排版，不影响读到的文字。
    const text = textOf(document).replace(/\s+/g, '');
    const h1 = find(document, 'h1');
    expect(h1).toHaveLength(1);
    expect(textOf(h1[0]!).replace(/\s+/g, '')).toContain(person.name);
    expect(text).toMatch(wall.name);
    for (const hook of card.hooks) expect(text).toContain(hook.text.replace(/\s+/g, ''));
    expect(text).toContain('想聊这个');
    expect(html).not.toMatch(/@demo\.nowme|微信号|手机号|https?:\/\/(?!www\.w3\.org)/);
  });

  it('34 页的 DOM 结构互不相同', () => {
    const shapes = DEMO_ADDITIONS.map((person) => shape(parse(read(person.dir).get('index.html')!.toString()) as unknown as Node));
    expect(new Set(shapes).size).toBe(DEMO_ADDITIONS.length);
  });
});
