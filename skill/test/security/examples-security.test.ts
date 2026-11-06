/**
 * 示例页必须满足 contracts 2.2 的安全相关规则（Agent 会照着示例写页面，示例本身不能带坏习惯）。
 * 另外检查整个 skill/ 里没有混进真实格式的凭证。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kitFileFromUrl } from '@nowme/kit';
import { loadExamplesIndex, SKILL_DIR } from '../../src/index.js';
import { attribute, FORBIDDEN_API, hasAttribute, inlineScripts, readExample, startTags, styles } from '../helpers/pages.js';

const dirs = loadExamplesIndex().examples.map((item) => item.dir);
const RESOURCE_ATTRIBUTES = ['src', 'href', 'srcset', 'poster', 'background', 'xlink:href', 'data', 'action', 'formaction'];
const FORBIDDEN_ELEMENTS = ['form', 'iframe', 'frame', 'object', 'embed', 'base', 'portal'];

describe.each(dirs)('示例 %s 的安全规则', (dir) => {
  const page = readExample(dir);
  const tags = startTags(page.html);
  const scripts = inlineScripts(page.html).join('\n');

  it.each(FORBIDDEN_API)('脚本不使用 %s', (_label, pattern) => {
    expect(scripts).not.toMatch(pattern);
  });

  it('没有 on* 事件属性（脚本用 addEventListener）', () => {
    for (const tag of tags) expect(tag.raw, tag.raw).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('没有禁止的元素；<link> 只有 Kit 样式表，<script src> 只指向 Kit；没有 meta refresh', () => {
    for (const tag of tags) {
      expect(FORBIDDEN_ELEMENTS.includes(tag.name), tag.raw).toBe(false);
      if (tag.name === 'link') {
        expect(attribute(tag.raw, 'rel')).toBe('stylesheet');
        expect(kitFileFromUrl(attribute(tag.raw, 'href') ?? '')).not.toBeNull();
      }
      if (tag.name === 'script' && hasAttribute(tag.raw, 'src')) {
        expect(kitFileFromUrl(attribute(tag.raw, 'src') ?? '')).not.toBeNull();
      }
      if (tag.name === 'meta') expect(attribute(tag.raw, 'http-equiv')).toBeNull();
    }
  });

  it('<a href> 只用页内锚点；data-nm-href 都是 https', () => {
    for (const tag of tags) {
      if (tag.name === 'a' && hasAttribute(tag.raw, 'href')) expect(attribute(tag.raw, 'href')?.startsWith('#'), tag.raw).toBe(true);
      const external = attribute(tag.raw, 'data-nm-href');
      if (external !== null) expect(new URL(external).protocol).toBe('https:');
    }
    for (const match of scripts.matchAll(/openLink\(\s*['"]([^'"]+)['"]/g)) {
      expect(new URL(match[1] ?? '').protocol).toBe('https:');
    }
  });

  it('资源属性只引用 Kit、assets/、data:image、页内锚点', () => {
    for (const tag of tags) {
      for (const name of RESOURCE_ATTRIBUTES) {
        if (tag.name === 'a' && name === 'href') continue;
        const value = attribute(tag.raw, name);
        if (value === null) continue;
        const ok = kitFileFromUrl(value) !== null || value.startsWith('assets/') || value.startsWith('data:image/') || value.startsWith('#');
        expect(ok, `${tag.name} ${name}=${value}`).toBe(true);
      }
    }
  });

  it('CSS 不引用外部资源：没有 @import，url() 只用 assets/ 或 data:image', () => {
    const css = styles(page.html);
    expect(css).not.toMatch(/@import/i);
    for (const match of css.matchAll(/url\(\s*['"]?([^'")]*)/g)) {
      const value = match[1] ?? '';
      expect(value.startsWith('assets/') || value.startsWith('data:image/') || value.startsWith('#'), value).toBe(true);
    }
  });

  it('页面任何地方都不出现 http(s) 地址（data-nm-href 的 https 外链除外），也没有 xmlns 网址', () => {
    const withoutAllowedLinks = page.html.replace(/data-nm-href="https:\/\/[^"]*"/g, '');
    expect(withoutAllowedLinks).not.toMatch(/https?:\/\//);
  });

  it('不含凭证或一次性 token，不含联系方式字样', () => {
    for (const file of ['index.html', 'card.json', 'manifest.json']) {
      const text = readFileSync(join(page.path, file), 'utf8');
      expect(text).not.toMatch(/nm[ct]_[A-Za-z0-9_-]{8,}/);
      expect(text).not.toMatch(/微信号|手机号|wechat\s*id|@[a-z0-9-]+\.(com|cn)\b/i);
    }
  });
});

describe('skill/ 目录不含凭证', () => {
  function walk(root: string): string[] {
    return readdirSync(root).flatMap((name) => {
      if (name === 'node_modules' || name === 'dist') return [];
      const path = join(root, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  }

  it('没有形如真实凭证的字符串（nmc_ / nmt_ 后接 43 位 base64url），也没有名为 credentials 的文件', () => {
    for (const file of walk(SKILL_DIR)) {
      expect(file.endsWith('/credentials'), file).toBe(false);
      if (/\.(md|json|html|ts)$/.test(file)) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(/nm[ct]_[A-Za-z0-9_-]{43}/);
      }
    }
  });
});
