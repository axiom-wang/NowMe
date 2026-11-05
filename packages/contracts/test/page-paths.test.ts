import { describe, expect, it } from 'vitest';
import {
  assetExtensionOf,
  checkAssetPath,
  isPageUploadPath,
  isSafeRelativePath,
  PAGE_REQUIRED_FILES,
  PAGE_TOP_LEVEL_FILES,
} from '../src/index.js';

describe('页面白名单路径', () => {
  it('必需文件与顶层文件', () => {
    expect(PAGE_REQUIRED_FILES).toEqual(['index.html', 'card.json', 'manifest.json']);
    expect(PAGE_TOP_LEVEL_FILES).toEqual(['index.html', 'card.json', 'manifest.json', 'cover.png']);
  });

  it.each([
    'index.html',
    'card.json',
    'manifest.json',
    'cover.png',
    'assets/photo.png',
    'assets/sub/photo.jpg',
    // 结构上属于 assets/，提交后由校验器报错（ASSET_TYPE_FORBIDDEN / ASSET_NAME_INVALID），而不是静默忽略
    'assets/icon.svg',
    'assets/Photo.PNG',
    'assets/a/b/c.png',
  ])('白名单内：%s', (path) => {
    expect(isPageUploadPath(path)).toBe(true);
  });

  it.each([
    'brief.md',
    'profile.md',
    'credentials',
    'nowme.json',
    'context.json',
    'draft/index.html',
    'page/index.html',
    'Index.html',
    'index.htm',
    'assets',
    'assets/',
    '/index.html',
    './index.html',
    '../index.html',
    'assets/../index.html',
    'assets/../../etc/passwd',
    'assets/./a.png',
    'assets//a.png',
    'assets\\a.png',
    'C:/assets/a.png',
    'assets/a.png\u0000',
    'assets/a\n.png',
    '',
  ])('白名单外：%j', (path) => {
    expect(isPageUploadPath(path)).toBe(false);
  });

  it('isSafeRelativePath 拒绝穿越与异常字符', () => {
    expect(isSafeRelativePath('a/b.png')).toBe(true);
    for (const path of ['', '/a', 'a/', '..', 'a/..', 'a/./b', 'a\\b', 'a:b', `a${'/b'.repeat(300)}`]) {
      expect(isSafeRelativePath(path), path).toBe(false);
    }
  });
});

describe('checkAssetPath（contracts 1.4）', () => {
  it.each([
    ['assets/a.png', null],
    ['assets/photo-1.jpeg', null],
    ['assets/x.webp', null],
    ['assets/x.gif', null],
    ['assets/2024/x.jpg', null],
    [`assets/${'a'.repeat(60)}.png`, null], // 64 个字符
    [`assets/${'a'.repeat(61)}.png`, 'name-invalid'], // 65 个字符
    ['assets/a/b/c.png', 'too-deep'],
    ['assets/A.png', 'name-invalid'],
    ['assets/a.PNG', 'name-invalid'],
    ['assets/.hidden.png', 'name-invalid'],
    ['assets/_a.png', 'name-invalid'],
    ['assets/图片.png', 'name-invalid'],
    ['assets/Sub/a.png', 'name-invalid'],
    ['assets/a.svg', 'type-forbidden'],
    ['assets/a.woff2', 'type-forbidden'],
    ['assets/a.html', 'type-forbidden'],
    ['assets/a.js', 'type-forbidden'],
    ['assets/noext', 'type-forbidden'],
    ['assets/png', 'type-forbidden'],
    ['index.html', 'not-asset'],
    ['assets/../a.png', 'unsafe'],
  ] as const)('%s → %s', (path, expected) => {
    expect(checkAssetPath(path)).toBe(expected);
  });

  it('assetExtensionOf', () => {
    expect(assetExtensionOf('assets/a.png')).toBe('png');
    expect(assetExtensionOf('assets/a.tar.gif')).toBe('gif');
    expect(assetExtensionOf('assets/a.svg')).toBeNull();
    expect(assetExtensionOf('assets/png')).toBeNull();
    expect(assetExtensionOf('assets.png/a')).toBeNull();
  });
});
