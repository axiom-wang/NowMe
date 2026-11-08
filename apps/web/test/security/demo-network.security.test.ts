import { describe, expect, it, vi } from 'vitest';
import { createDemoModelLookup } from '../../scripts/demo-network.js';
import { createModelFetch } from '../../src/security/model-network.js';

function resolver(v4 = ['93.184.216.34'], v6: string[] = []) {
  return { setServers: vi.fn(), resolve4: vi.fn(async () => v4), resolve6: vi.fn(async () => v6) };
}
describe('演示DNS显式覆盖仍受网络限制', () => {
  it('不配置时不覆盖系统DNS；仅接受IP格式的服务器列表', () => {
    expect(createDemoModelLookup({})).toBeUndefined();
    expect(() => createDemoModelLookup({ NOWME_DEMO_DNS_SERVERS: 'https://dns.example' })).toThrow('DNS');
  });
  it('每次读取A与AAAA全部结果；任一结果为保留地址就拒绝且不发送Key', async () => {
    const r = resolver(['93.184.216.34', '198.18.0.1']);
    const transport = vi.fn<typeof fetch>();
    const lookup = createDemoModelLookup({ NOWME_DEMO_DNS_SERVERS: '1.1.1.1' }, r)!;
    const fetchModel = createModelFetch({ lookup, transport });
    await expect(fetchModel('https://model.example/v1', { headers: { authorization: 'Bearer test-secret' } })).rejects.toThrow('MODEL_CONFIG');
    expect(transport).not.toHaveBeenCalled();
    expect(r.resolve4).toHaveBeenCalledWith('model.example');
    expect(r.resolve6).toHaveBeenCalledWith('model.example');
  });
  it('公网结果可以连接；每次请求重新查询且仍拒绝重定向', async () => {
    const r = resolver();
    const lookup = createDemoModelLookup({ NOWME_DEMO_DNS_SERVERS: '1.1.1.1' }, r)!;
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 302, headers: { location: 'http://localhost' } }));
    const fetchModel = createModelFetch({ lookup, transport });
    for (let i = 0; i < 2; i++) await expect(fetchModel('https://model.example/v1')).rejects.toThrow('MODEL_CONFIG');
    expect(r.resolve4).toHaveBeenCalledTimes(2);
    expect(r.resolve6).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });
  it('一种记录查询出错不忽略，只有无记录可继续', async () => {
    const r = resolver();
    r.resolve6.mockRejectedValueOnce({ code: 'ETIMEOUT' }).mockRejectedValueOnce({ code: 'ENODATA' });
    const lookup = createDemoModelLookup({ NOWME_DEMO_DNS_SERVERS: '1.1.1.1' }, r)!;
    await expect(lookup('model.example')).rejects.toThrow('DNS');
    await expect(lookup('model.example')).resolves.toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
