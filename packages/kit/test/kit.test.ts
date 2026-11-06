import { existsSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KIT_BASE_PATH, KIT_CSS_PATH, KIT_JS_PATH, KIT_VERSION } from '@nowme/contracts';
import {
  isKitStaticFile,
  KIT_COMPONENTS,
  KIT_STATIC_DIR,
  KIT_STATIC_FILES,
  KIT_THEMES,
  kitFileFromUrl,
  kitFileUrl,
  kitStaticContentType,
  kitStaticFilePath,
  readKitStaticFile,
} from '../src/index.js';

describe('@nowme/kit 静态文件', () => {
  it('Kit 版本与路径来自 contracts', () => {
    expect(KIT_VERSION).toBe('1');
    expect(KIT_BASE_PATH).toBe('/_nowme/kit/v1/');
  });

  it('static/ 里正好是清单中的文件', () => {
    const onDisk = readdirSync(KIT_STATIC_DIR).filter((name) => !name.startsWith('.')).sort();
    expect(onDisk).toEqual(KIT_STATIC_FILES.map((file) => file.path).sort());
    for (const file of KIT_STATIC_FILES) {
      expect(existsSync(kitStaticFilePath(file.path))).toBe(true);
      expect(readKitStaticFile(file.path).length).toBeGreaterThan(1000);
    }
  });

  it('引用路径与 contracts 常量一致', () => {
    expect(kitFileUrl('nowme.css')).toBe(KIT_CSS_PATH);
    expect(kitFileUrl('nowme.js')).toBe(KIT_JS_PATH);
  });

  it('kitFileFromUrl 只认 Kit 路径下真实存在的文件', () => {
    expect(kitFileFromUrl('/_nowme/kit/v1/nowme.css')).toBe('nowme.css');
    expect(kitFileFromUrl('/_nowme/kit/v1/nowme.js?v=1#x')).toBe('nowme.js');
    expect(kitFileFromUrl('/_nowme/kit/v1/missing.css')).toBeNull();
    expect(kitFileFromUrl('/_nowme/kit/v1/../secret')).toBeNull();
    expect(kitFileFromUrl('/_nowme/kit/v2/nowme.css')).toBeNull();
    expect(kitFileFromUrl('https://evil.example/_nowme/kit/v1/nowme.css')).toBeNull();
    expect(isKitStaticFile('nowme.css')).toBe(true);
    expect(isKitStaticFile('../fonts.json')).toBe(false);
  });

  it('Content-Type', () => {
    expect(kitStaticContentType('nowme.css')).toBe('text/css; charset=utf-8');
    expect(kitStaticContentType('nowme.js')).toBe('text/javascript; charset=utf-8');
  });
});

describe('@nowme/kit 清单', () => {
  it('组件 id 与类名唯一', () => {
    const ids = KIT_COMPONENTS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const classes = KIT_COMPONENTS.map((item) => item.className).filter((name) => name !== null);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it('需要 JS 的组件都写明了 data 属性或类名', () => {
    for (const component of KIT_COMPONENTS.filter((item) => item.js)) {
      expect(component.className !== null || (component.attributes?.length ?? 0) > 0, component.id).toBe(true);
    }
  });

  it('主题既有浅色也有深色', () => {
    expect(KIT_THEMES.some((theme) => theme.dark)).toBe(true);
    expect(KIT_THEMES.some((theme) => !theme.dark)).toBe(true);
  });
});
