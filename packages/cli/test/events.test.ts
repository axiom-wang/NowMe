/**
 * 事件上报钩子：没有关联信息或凭证时静默跳过；有凭证时只交给发送函数（不打印）；props 只留数字与布尔值；
 * 发送失败不影响命令。参数解析的小用例也放在这里。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventReporter, parseArgs, run, sanitizeEventProps, type EventDelivery } from '../src/index.js';
import { capture, makeWorkdir, type TempWorkdir } from './helpers.js';

let home: string;
let workdir: TempWorkdir;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'nowme-home-'));
  workdir = await makeWorkdir();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await workdir.cleanup();
});

const CREDENTIAL = `nmc_${'A'.repeat(43)}`;

async function link(): Promise<void> {
  await writeFile(join(workdir.root, 'nowme.json'), JSON.stringify({ server: 'http://localhost:3000', wallId: 'wal_x', pageId: 'pg_x' }));
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'credentials'), JSON.stringify({ version: 1, pages: { pg_x: { server: 'http://localhost:3000', wallId: 'wal_x', credential: CREDENTIAL, createdAt: '2026-01-01T00:00:00Z' } } }));
}

describe('事件上报钩子', () => {
  it('sanitizeEventProps 只保留数字（有限值）与布尔值、合法键名，最多 16 个', () => {
    const props = sanitizeEventProps({ ok: true, durationMs: 12, text: '内容', nan: Number.NaN, 'bad key': 1, nested: { a: 1 } });
    expect(props).toEqual({ ok: true, durationMs: 12 });
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, index]));
    expect(Object.keys(sanitizeEventProps(many))).toHaveLength(16);
  });

  it('没有 nowme.json 或没有凭证时不调用发送函数', async () => {
    const sent: EventDelivery[] = [];
    const send = async (delivery: EventDelivery) => {
      sent.push(delivery);
    };
    await createEventReporter({ workDir: workdir.root, env: { NOWME_HOME: home }, send })('validate', { ok: true });
    await writeFile(join(workdir.root, 'nowme.json'), JSON.stringify({ server: 'http://localhost:3000', wallId: 'wal_x', pageId: 'pg_x' }));
    await createEventReporter({ workDir: workdir.root, env: { NOWME_HOME: home }, send })('validate', { ok: true });
    expect(sent).toEqual([]);
  });

  it('validate 结束时上报 validate 事件：只带数字 / 布尔属性；凭证不出现在输出里；发送失败不影响退出码', async () => {
    await link();
    const sent: EventDelivery[] = [];
    const io = capture();
    const code = await run(['validate'], io.io, {
      env: { INIT_CWD: workdir.root, NOWME_HOME: home },
      sendEvent: async (delivery) => {
        sent.push(delivery);
      },
    });
    expect(code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('validate');
    expect(sent[0]?.credential).toBe(CREDENTIAL);
    expect(sent[0]?.link.pageId).toBe('pg_x');
    for (const value of Object.values(sent[0]?.props ?? {})) expect(['number', 'boolean']).toContain(typeof value);
    expect(sent[0]?.props).toMatchObject({ ok: true, errorCount: 0 });
    expect(io.stdout() + io.stderr()).not.toContain('nmc_');

    const failing = capture();
    const failingCode = await run(['validate'], failing.io, {
      env: { INIT_CWD: workdir.root, NOWME_HOME: home },
      sendEvent: async () => {
        throw new Error('network down');
      },
    });
    expect(failingCode).toBe(0);
    expect(failing.stderr()).toBe('');
  });
});

describe('parseArgs', () => {
  const specs = [
    { name: 'json', type: 'boolean' },
    { name: 'port', type: 'number' },
    { name: 'server', type: 'string' },
  ] as const;

  it('位置参数、布尔、--key value、--key=value、--', () => {
    const result = parseArgs(['page', '--json', '--port', '4100', '--server=http://x', '--', '--json'], specs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args.positionals).toEqual(['page', '--json']);
    expect(Object.fromEntries(result.args.flags)).toEqual({ json: true, port: 4100, server: 'http://x' });
  });

  it('未知选项、缺少取值、类型不对、布尔带值、短选项', () => {
    expect(parseArgs(['--nope'], specs)).toEqual({ ok: false, error: '未知选项：--nope' });
    expect(parseArgs(['--port'], specs)).toEqual({ ok: false, error: '--port 需要一个取值' });
    expect(parseArgs(['--port', 'x'], specs)).toEqual({ ok: false, error: '--port 应为整数：x' });
    expect(parseArgs(['--json=1'], specs)).toEqual({ ok: false, error: '--json 不接受取值' });
    expect(parseArgs(['-x'], specs)).toEqual({ ok: false, error: '未知选项：-x' });
  });
});
