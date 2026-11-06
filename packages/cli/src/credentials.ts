/**
 * 页面凭证存储（contracts 1.5）：`$NOWME_HOME/credentials`，目录 0700、文件 0600，原子写入。
 * 凭证只存在这个文件里；任何输出只能用 maskCredential() 的结果。
 */
import { chmod, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { NOWME_HOME_CREDENTIALS_FILE, NOWME_HOME_DIR_MODE } from '@nowme/contracts';
import { writeFileAtomic } from './fs-util.js';
import { nowmeHome } from './workdir.js';

export const CREDENTIAL_FILE_MODE = 0o600;

export interface StoredCredential {
  server: string;
  wallId: string;
  credential: string;
  createdAt: string;
}

export interface CredentialStore {
  version: 1;
  pages: Record<string, StoredCredential>;
}

/** 输出里最多显示 `nmc_` + 前 4 位。 */
export function maskCredential(credential: string): string {
  return `${credential.slice(0, 8)}…`;
}

const CREDENTIAL_PATTERN = /nmc_[A-Za-z0-9_-]{8,}/g;

/** 把文本里任何完整凭证替换为掩码（输出层的兜底）。 */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIAL_PATTERN, (match) => maskCredential(match));
}

const isWindows = process.platform === 'win32';

/** 目录与文件权限过宽时收紧；返回给用户的提示。 */
async function tighten(path: string, mode: number, label: string): Promise<string | null> {
  if (isWindows) return null;
  try {
    const current = (await stat(path)).mode & 0o777;
    if ((current & 0o077) === 0) return null;
    await chmod(path, mode);
    return `已把${label}的权限从 ${current.toString(8)} 收紧为 ${mode.toString(8)}（凭证不应被其他用户读取）`;
  } catch {
    return null;
  }
}

function isStore(value: unknown): value is CredentialStore {
  if (typeof value !== 'object' || value === null) return false;
  const { version, pages } = value as Record<string, unknown>;
  return version === 1 && typeof pages === 'object' && pages !== null && !Array.isArray(pages);
}

export function credentialsPath(env: NodeJS.ProcessEnv): string {
  return join(nowmeHome(env), NOWME_HOME_CREDENTIALS_FILE);
}

const CORRUPT_NOTE = '格式不正确';

/** 读取凭证文件（不存在或损坏时返回空仓库）；发现权限过宽时收紧并返回提示。 */
export async function loadCredentialStore(env: NodeJS.ProcessEnv): Promise<{ store: CredentialStore; notes: string[] }> {
  const notes: string[] = [];
  const home = nowmeHome(env);
  const file = credentialsPath(env);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { store: { version: 1, pages: {} }, notes };
  }
  const dirNote = await tighten(home, NOWME_HOME_DIR_MODE, `目录 ${home}`);
  const fileNote = await tighten(file, CREDENTIAL_FILE_MODE, `凭证文件 ${file}`);
  for (const note of [dirNote, fileNote]) if (note) notes.push(note);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isStore(parsed)) return { store: parsed, notes };
  } catch {
    // 落到下面
  }
  notes.push(`凭证文件 ${file} ${CORRUPT_NOTE}，已忽略；重新 nowme fetch 会重建`);
  return { store: { version: 1, pages: {} }, notes };
}

/** 写入（合并）某页面的凭证。 */
export async function saveCredential(env: NodeJS.ProcessEnv, pageId: string, entry: StoredCredential): Promise<string[]> {
  const home = nowmeHome(env);
  await mkdir(home, { recursive: true, mode: NOWME_HOME_DIR_MODE });
  if (!isWindows) await chmod(home, NOWME_HOME_DIR_MODE);
  const { store, notes } = await loadCredentialStore(env);
  const file = credentialsPath(env);
  // 损坏的文件先留一份备份，避免丢掉其他页面的凭证
  if (notes.some((note) => note.includes(CORRUPT_NOTE))) {
    await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => undefined);
  }
  store.pages[pageId] = entry;
  await writeFileAtomic(file, `${JSON.stringify(store, null, 2)}\n`, CREDENTIAL_FILE_MODE);
  return notes;
}

export async function readStoredCredential(env: NodeJS.ProcessEnv, pageId: string): Promise<StoredCredential | null> {
  const { store } = await loadCredentialStore(env);
  const entry = store.pages[pageId];
  return entry && typeof entry.credential === 'string' && entry.credential ? entry : null;
}
