/** 只为已知虚构演示账号补齐头像，不覆盖用户自行更换的图片。启动时不联网。 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppDeps } from '../src/context.js';

interface DemoAvatar { email: string; nickname: string; file: string; source: string; }
export function seedDemoAvatars(deps: Pick<AppDeps, 'repos'>): number {
  const entries = JSON.parse(readFileSync(new URL('./demo-avatars/manifest.json', import.meta.url), 'utf8')) as DemoAvatar[];
  let count = 0;
  for (const entry of entries) {
    const user = deps.repos.users.findByEmail(entry.email);
    if (!user || user.avatarVersion || !user.nickname) continue;
    const bytes = readFileSync(new URL(`./demo-avatars/${entry.file}`, import.meta.url));
    deps.repos.users.saveProfile(user.id, user.nickname, { bytes, version: createHash('sha256').update(bytes).digest('hex').slice(0, 24) });
    count++;
  }
  return count;
}
