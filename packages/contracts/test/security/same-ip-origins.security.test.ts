/**
 * 主站与页面托管必须是不同主机（cookie 不按端口隔离）。唯一的例外是没有域名、只能用同一个公网 IP 直连时
 * 显式设置 `NOWME_ALLOW_SAME_IP_ORIGINS=1`（contracts 10.1）：只对 IP 字面量生效，端口必须不同，生产检查会提醒。
 */
import { describe, expect, it } from 'vitest';
import { checkProductionConfig, ConfigError, loadConfig } from '../../src/index.js';

const SAME_IP = { NOWME_WEB_ORIGIN: 'https://203.0.113.7', NOWME_PAGES_ORIGIN: 'https://203.0.113.7:8443' };

describe('同一个 IP 上的主站与页面托管（NOWME_ALLOW_SAME_IP_ORIGINS）', () => {
  it('默认拒绝同主机名，包括同一个 IP 的不同端口', () => {
    expect(() => loadConfig(SAME_IP)).toThrow(ConfigError);
    expect(() => loadConfig({ ...SAME_IP, NOWME_ALLOW_SAME_IP_ORIGINS: '0' })).toThrow(/主机名不能相同/);
    expect(() => loadConfig({ ...SAME_IP, NOWME_ALLOW_SAME_IP_ORIGINS: '' })).toThrow(/主机名不能相同/);
  });

  it('只接受 1 或 0', () => {
    expect(() => loadConfig({ ...SAME_IP, NOWME_ALLOW_SAME_IP_ORIGINS: 'true' })).toThrow(/只能是 1 或 0/);
  });

  it('开关打开后，同一个 IP 的不同端口可以启动', () => {
    const config = loadConfig({ ...SAME_IP, NOWME_ALLOW_SAME_IP_ORIGINS: '1' });
    expect(config.webOrigin).toBe('https://203.0.113.7');
    expect(config.pagesOrigin).toBe('https://203.0.113.7:8443');
  });

  it('开关不放行域名：同一个域名的不同端口仍然拒绝', () => {
    for (const host of ['nowme.example', 'localhost']) {
      expect(() =>
        loadConfig({ NOWME_WEB_ORIGIN: `https://${host}`, NOWME_PAGES_ORIGIN: `https://${host}:8443`, NOWME_ALLOW_SAME_IP_ORIGINS: '1' }),
      ).toThrow(/主机名不能相同/);
    }
  });

  it('开关打开后两个源仍然必须不同（端口不能相同）', () => {
    expect(() =>
      loadConfig({ NOWME_WEB_ORIGIN: 'http://203.0.113.7', NOWME_PAGES_ORIGIN: 'https://203.0.113.7:80', NOWME_ALLOW_SAME_IP_ORIGINS: '1' }),
    ).toThrow(/端口必须不同/);
  });

  it('生产环境启动检查会提醒这是临时做法', () => {
    const env = { ...SAME_IP, NOWME_ALLOW_SAME_IP_ORIGINS: '1', NODE_ENV: 'production' };
    const { warnings } = checkProductionConfig(loadConfig(env), env, 'pages');
    expect(warnings.some((line) => line.includes('NOWME_ALLOW_SAME_IP_ORIGINS'))).toBe(true);
  });
});
