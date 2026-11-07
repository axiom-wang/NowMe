/**
 * 打 Skill 包（contracts 4.5）：`<outDir>/nowme-page-<version>.tar.gz` + `<outDir>/manifest.json`，由主站在 `/skill` 托管。
 *
 * - 只收白名单内容：`SKILL.md`、`reference/`、`scenes/`、`templates/`、`examples/`，加上打包好的单文件 CLI
 *   `scripts/nowme.mjs`（@nowme/cli 的 bundleCli）。不收 `src/`、`test/`、`node_modules/`、点文件；
 * - 归档根目录是 `nowme-page/`（Skill 名称，也是安装目录名）；
 * - **可复现**：文件按路径排序、时间戳固定、uid/gid 为 0，同样的内容两次打包得到同样的 sha256；
 * - 归档里不能出现任何形如 token / 凭证的字符串（打包时检查，发现就报错）。
 *
 * 归档格式：POSIX ustar + gzip（macOS、Linux 与 Windows 10+ 自带的 tar 都能解压），不引入新依赖。
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  containsCredentialLike,
  SKILL_BUNDLED_CLI_PATH,
  SKILL_MIN_NODE_VERSION,
  SKILL_NAME,
  skillArchiveFileName,
  type SkillPackageManifest,
} from '@nowme/contracts';
import { bundleCli } from '@nowme/cli/bundle';
import { SKILL_DIR, SKILL_VERSION } from './index.js';

/** 收进 Skill 包的顶层条目（相对 `skill/`）。 */
export const SKILL_PACKAGE_ENTRIES = ['SKILL.md', 'reference', 'scenes', 'templates', 'examples'] as const;

/** 归档里文件的固定时间戳（2026-01-01T00:00:00Z）：不用 0，避免部分 tar 警告“时间戳过早”。 */
const FIXED_MTIME = 1_767_225_600;

export interface PackedFile {
  /** 归档里的路径（不含根目录 `nowme-page/`），例如 `scenes/hackathon.json`。 */
  path: string;
  bytes: Uint8Array;
  executable: boolean;
}

export interface PackSkillResult {
  manifest: SkillPackageManifest;
  archivePath: string;
  manifestPath: string;
  /** 归档里的文件（排序后）。 */
  files: string[];
}

async function collectDir(root: string, dir: string, out: PackedFile[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await collectDir(root, full, out);
    else if (entry.isFile()) out.push({ path: relative(root, full).split(sep).join('/'), bytes: new Uint8Array(await readFile(full)), executable: false });
  }
}

/** 白名单内容（不含 CLI）。 */
export async function collectSkillFiles(skillDir: string = SKILL_DIR): Promise<PackedFile[]> {
  const files: PackedFile[] = [];
  for (const entry of SKILL_PACKAGE_ENTRIES) {
    const full = join(skillDir, entry);
    const info = await stat(full);
    if (info.isDirectory()) await collectDir(skillDir, full, files);
    else files.push({ path: entry, bytes: new Uint8Array(await readFile(full)), executable: false });
  }
  return files;
}

// ---------------------------------------------------------------------------
// 最小的 ustar 写入器
// ---------------------------------------------------------------------------

const BLOCK = 512;

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength > length) throw new Error(`tar 字段太长：${value}`);
  bytes.copy(header, offset);
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

/** 路径超过 100 字节时拆成 prefix（≤155）+ name（≤100）。 */
function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/');
    const name = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`路径太长，无法写进 tar：${path}`);
}

function tarHeader(path: string, size: number, type: 'file' | 'dir', mode: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, FIXED_MTIME);
  header.fill(0x20, 148, 156); // 计算校验和时按空格算
  writeString(header, 156, 1, type === 'dir' ? '5' : '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'root');
  writeString(header, 297, 32, 'root');
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  writeString(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** 文件 → tar 字节（含目录条目，按路径排序，结尾两个空块）。 */
export function createTar(root: string, files: readonly PackedFile[]): Buffer {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const dirs = new Set<string>([root]);
  for (const file of sorted) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(`${root}/${parts.slice(0, i).join('/')}`);
  }
  const chunks: Buffer[] = [];
  for (const dir of [...dirs].sort()) chunks.push(tarHeader(`${dir}/`, 0, 'dir', 0o755));
  for (const file of sorted) {
    chunks.push(tarHeader(`${root}/${file.path}`, file.bytes.byteLength, 'file', file.executable ? 0o755 : 0o644));
    chunks.push(Buffer.from(file.bytes));
    const pad = (BLOCK - (file.bytes.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------

/** 打包：写 `<outDir>/nowme-page-<version>.tar.gz` 与 `manifest.json`，删除旧版本的归档。 */
export async function packSkill(options: { outDir: string; skillDir?: string; version?: string }): Promise<PackSkillResult> {
  const version = options.version ?? SKILL_VERSION;
  const files = await collectSkillFiles(options.skillDir);

  // 单文件 CLI：先打到临时目录再读进来
  const temp = await mkdtemp(join(tmpdir(), 'nowme-skill-pack-'));
  try {
    const cliFile = join(temp, 'nowme.mjs');
    await bundleCli(cliFile, { skillVersion: version });
    files.push({ path: SKILL_BUNDLED_CLI_PATH, bytes: new Uint8Array(await readFile(cliFile)), executable: true });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  for (const file of files) {
    if (containsCredentialLike(Buffer.from(file.bytes).toString('latin1'))) {
      throw new Error(`Skill 包里不能有 token 或凭证样式的字符串：${file.path}`);
    }
  }

  const archive = gzipSync(createTar(SKILL_NAME, files), { level: 9 });
  const fileName = skillArchiveFileName(version);
  const manifest: SkillPackageManifest = {
    name: SKILL_NAME,
    version,
    file: fileName,
    sha256: createHash('sha256').update(archive).digest('hex'),
    bytes: archive.byteLength,
    minNode: SKILL_MIN_NODE_VERSION,
  };

  await mkdir(options.outDir, { recursive: true });
  for (const entry of await readdir(options.outDir)) {
    if (/^nowme-page-.*\.tar\.gz$/.test(entry) && entry !== fileName) await rm(join(options.outDir, entry), { force: true });
  }
  const archivePath = join(options.outDir, fileName);
  const manifestPath = join(options.outDir, 'manifest.json');
  await writeFile(archivePath, archive);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, archivePath, manifestPath, files: files.map((file) => file.path).sort() };
}
