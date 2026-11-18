import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';

const release = fileURLToPath(new URL('../../../deploy/server-release.sh', import.meta.url));
const receive = fileURLToPath(new URL('../../../deploy/github-receive.sh', import.meta.url));
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture(fail = '') {
  const root = mkdtempSync(join(tmpdir(), 'nowme-deploy-'));
  temporary.push(root);
  const sha = 'a'.repeat(40);
  const stage = join(root, 'releases', `${sha}.test`);
  const bin = join(root, 'bin');
  for (const path of [bin, join(root, 'deploy'), join(root, 'packages/kit/fonts'), join(stage, 'deploy'), join(stage, 'packages/kit/fonts')]) mkdirSync(path, { recursive: true });
  const secret = 'NOWME_SMTP_URL=private-smtp-value\n';
  writeFileSync(join(root, '.env'), secret);
  writeFileSync(join(root, 'deploy/demo.env'), 'PRIVATE_DEMO_KEY=value\n');
  writeFileSync(join(root, 'deploy/Caddyfile'), 'old config');
  writeFileSync(join(root, 'docker-compose.yml'), 'old compose');
  writeFileSync(join(root, 'deploy/compose.ip.yml'), 'old compose');
  writeFileSync(join(stage, '.dockerignore'), 'deploy\npackages/kit/fonts/*.ttf\n');
  for (const file of ['docker-compose.yml', 'deploy/compose.ip.yml', 'deploy/Caddyfile']) writeFileSync(join(stage, file), 'new config');
  const log = join(root, 'calls');
  const executable = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  executable('sudo', 'exec "$@"');
  executable('sleep', 'exit 0');
  executable('docker', `
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$*" in
  build*) [ "$FAIL_AT" != build ] || exit 1 ;;
  *' run --rm --no-deps -T backup') [ "$FAIL_AT" != backup ] || exit 1 ;;
  *' up -d --no-build --wait --wait-timeout 120 web pages worker') [ "$FAIL_AT" != production ] || exit 1 ;;
  'inspect nowme-web-1'*) printf 'sha256:old\\n' ;;
  *' ps -q worker') printf 'worker-id\\n' ;;
  'inspect worker-id'*) printf 'true 0\\n' ;;
esac
exit 0`);
  executable('curl', `printf '以成员身份体验\\n'`);
  const run = () => spawnSync('bash', [release, sha, stage, root], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAIL_AT: fail, CALL_LOG: log } });
  return { root, sha, secret, run, calls: () => readFileSync(log, 'utf8') };
}

test.each(['build', 'backup'])('%s 失败保留正在运行的配置，不更新容器或成功记录', (failure) => {
  const f = fixture(failure);
  const result = f.run();
  expect(result.status, result.stdout + result.stderr + f.calls()).not.toBe(0);
  expect(readFileSync(join(f.root, '.env'), 'utf8')).toBe(f.secret);
  expect(readFileSync(join(f.root, 'docker-compose.yml'), 'utf8')).toBe('old compose');
  expect(f.calls()).not.toContain(' up -d');
  expect(existsSync(join(f.root, 'deployed-sha'))).toBe(false);
});

test('成功发布先备份和检查 Demo，保留密钥并记录准确版本', () => {
  const f = fixture();
  const result = f.run();
  expect(result.status, result.stderr).toBe(0);
  const calls = f.calls();
  expect(calls.indexOf(' run --rm --no-deps -T backup'), calls).toBeLessThan(calls.indexOf(' up -d'));
  expect(calls.indexOf('660 demo')).toBeLessThan(calls.indexOf('120 web pages worker'));
  expect(readFileSync(join(f.root, '.env'), 'utf8')).toContain(f.secret);
  expect(readFileSync(join(f.root, '.env'), 'utf8')).toContain(`NOWME_IMAGE=nowme:${f.sha}`);
  expect(readFileSync(join(f.root, 'deployed-sha'), 'utf8').trim()).toBe(f.sha);
  expect(result.stdout + result.stderr).not.toContain('private-smtp-value');
});

test('更新正式容器失败不能写入发布成功记录', () => {
  const f = fixture('production');
  expect(f.run().status).not.toBe(0);
  expect(existsSync(join(f.root, 'deployed-sha'))).toBe(false);
});

test.each(['bash', 'deploy main', `deploy ${'a'.repeat(40)}; whoami`])('专用连接拒绝非发布指令 %s', (command) => {
  const result = spawnSync('bash', [receive], { encoding: 'utf8', env: { ...process.env, SSH_ORIGINAL_COMMAND: command } });
  expect(result.status).toBe(2);
});
