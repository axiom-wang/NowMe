/** 内容安全与协议版本的共享定义（contracts 16）：词表解析、配置校验、版本常量。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BlocklistError,
  ConfigError,
  LEGAL_VERSION,
  loadBlocklistFile,
  loadConfig,
  loadContactEmail,
  loadModerationConfig,
  matchBlocklist,
  MIN_USER_AGE,
  parseBlocklist,
  squashForMatching,
} from '../src/index.js';

describe('词表解析', () => {
  it('普通词、/正则/、注释与空行；规则编号是行号', () => {
    const entries = parseBlocklist('# 注释\n\n加群领红包\n/vx\\s*[:：]\\s*\\w{5,}/\n');
    expect(entries.map((entry) => entry.rule)).toEqual(['F3', 'F4']);
    expect(matchBlocklist(entries, '来 加 群 领 红 包 吧')).toBe('F3');
    expect(matchBlocklist(entries, '加我 VX：abc12345')).toBe('F4');
    expect(matchBlocklist(entries, '今天天气不错')).toBeNull();
  });

  it('普通词里的正则符号按字面匹配', () => {
    const entries = parseBlocklist('a.b(c)\n');
    expect(matchBlocklist(entries, 'xa.b(c)y')).toBe('F1');
    expect(matchBlocklist(entries, 'aXbc')).toBeNull();
  });

  it('不合法的行抛错，信息里只有行号，没有词本身', () => {
    expect(() => parseBlocklist('好词\n/(/\n')).toThrow(BlocklistError);
    try {
      parseBlocklist('好词\n/(秘密词/\n');
    } catch (error) {
      expect((error as Error).message).toContain('第 2 行');
      expect((error as Error).message).not.toContain('秘密词');
    }
    expect(() => parseBlocklist('/abc/g')).toThrow(/标志/);
    expect(() => parseBlocklist('长'.repeat(201))).toThrow(/太长/);
  });

  it('读取词表文件：不存在时抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nowme-blocklist-'));
    try {
      const file = join(dir, 'words.txt');
      writeFileSync(file, '词一\n词二\n');
      expect(loadBlocklistFile(file)).toHaveLength(2);
      expect(() => loadBlocklistFile(join(dir, 'missing.txt'))).toThrow(BlocklistError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('squashForMatching：全角转半角、去空白与分隔符', () => {
    expect(squashForMatching('ＶＸ： a b-c')).toBe('vx:abc');
  });
});

describe('内容安全配置', () => {
  it('默认全部关闭、遇到失败时放行', () => {
    expect(loadModerationConfig({})).toEqual({ blocklistFile: null, url: null, onFailure: 'allow' });
  });

  it('词表路径按仓库根解析，绝对路径原样使用', () => {
    expect(loadModerationConfig({ NOWME_BLOCKLIST_FILE: '/etc/nowme/words.txt' }).blocklistFile).toBe('/etc/nowme/words.txt');
    expect(loadModerationConfig({ NOWME_BLOCKLIST_FILE: 'config/words.txt' }).blocklistFile).toMatch(/config\/words\.txt$/);
  });

  it('审核接口只允许 https，不带账号密码；失败策略只有 allow / block', () => {
    expect(loadModerationConfig({ NOWME_MODERATION_URL: 'https://mod.example.com/check', NOWME_MODERATION_ON_FAILURE: 'block' })).toMatchObject({ url: 'https://mod.example.com/check', onFailure: 'block' });
    for (const url of ['http://mod.example.com/x', 'ftp://x.example.com', 'https://user:pw@mod.example.com/x', 'not a url']) {
      expect(() => loadModerationConfig({ NOWME_MODERATION_URL: url }), url).toThrow(ConfigError);
    }
    expect(() => loadModerationConfig({ NOWME_MODERATION_ON_FAILURE: 'maybe' })).toThrow(ConfigError);
  });

  it('错误信息里不出现接口地址（可能带令牌参数）', () => {
    try {
      loadModerationConfig({ NOWME_MODERATION_URL: 'http://mod.example.com/?token=secret-token' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-token');
    }
  });

  it('联系邮箱：可选，必须像邮箱', () => {
    expect(loadContactEmail({})).toBeNull();
    expect(loadContactEmail({ NOWME_CONTACT_EMAIL: 'help@nowme.example' })).toBe('help@nowme.example');
    expect(() => loadContactEmail({ NOWME_CONTACT_EMAIL: 'nope' })).toThrow(ConfigError);
  });

  it('loadConfig 带上这两项', () => {
    const config = loadConfig({ NOWME_CONTACT_EMAIL: 'help@nowme.example' });
    expect(config.contactEmail).toBe('help@nowme.example');
    expect(config.moderation.url).toBeNull();
  });
});

describe('协议版本', () => {
  it('版本是日期格式，年龄门槛是 18', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MIN_USER_AGE).toBe(18);
  });
});
