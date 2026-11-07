/**
 * Skill 分发（contracts 4.5）：主站托管 `@nowme/skill` 打出的 Skill 包（`skill/dist-package/`）。
 *
 * - 启动时读一次 `manifest.json` 与归档，核对 sha256 与大小；不一致或缺文件时返回 null（安装页提示先构建）。
 * - 所有对外地址都由 `NOWME_WEB_ORIGIN` 拼出：本地是 http://localhost:3000，上线后是正式域名，用户复制就能用。
 * - Skill 包与安装说明里没有任何 token 或凭证；这些路由公开，不需要登录。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SKILL_INSTALL_DOC_PATH,
  SKILL_MANIFEST_PATH,
  SKILL_ROUTE_PREFIX,
  skillArchiveFileName,
  skillPackageManifestSchema,
  type SkillPackageManifest,
} from '@nowme/contracts';

export interface SkillPackage {
  /** 打包时写的清单（不含 url）。 */
  manifest: SkillPackageManifest;
  archive: Uint8Array<ArrayBuffer>;
}

export function skillInstallPageUrl(webOrigin: string): string {
  return `${webOrigin}${SKILL_ROUTE_PREFIX}`;
}

export function skillInstallDocUrl(webOrigin: string): string {
  return `${webOrigin}${SKILL_INSTALL_DOC_PATH}`;
}

export function skillManifestUrl(webOrigin: string): string {
  return `${webOrigin}${SKILL_MANIFEST_PATH}`;
}

export function skillArchiveUrl(webOrigin: string, version: string): string {
  return `${webOrigin}${SKILL_ROUTE_PREFIX}/${skillArchiveFileName(version)}`;
}

export type SkillPackageLoadResult = { ok: true; skillPackage: SkillPackage } | { ok: false; reason: string };

/** 读取并核对 Skill 包目录（`manifest.json` + 归档）。 */
export function loadSkillPackage(dir: string): SkillPackageLoadResult {
  let manifest: SkillPackageManifest;
  try {
    const parsed = skillPackageManifestSchema.safeParse(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    if (!parsed.success) return { ok: false, reason: `${dir}/manifest.json 格式不对` };
    manifest = parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: `没有找到 ${dir}/manifest.json` };
    return { ok: false, reason: `读取 ${dir}/manifest.json 失败：${(error as Error).message}` };
  }
  if (manifest.file !== skillArchiveFileName(manifest.version)) {
    return { ok: false, reason: `manifest.json 的 file 与版本不一致：${manifest.file}` };
  }
  let archive: Uint8Array<ArrayBuffer>;
  try {
    archive = new Uint8Array(readFileSync(join(dir, manifest.file)));
  } catch {
    return { ok: false, reason: `没有找到 ${dir}/${manifest.file}` };
  }
  const sha256 = createHash('sha256').update(archive).digest('hex');
  if (sha256 !== manifest.sha256 || archive.byteLength !== manifest.bytes) {
    return { ok: false, reason: `${manifest.file} 的 sha256 或大小与 manifest.json 不一致，请重新打包` };
  }
  const { url: _ignored, ...rest } = manifest;
  return { ok: true, skillPackage: { manifest: rest, archive } };
}

/** 对外的清单（带绝对下载地址）。 */
export function publicSkillManifest(webOrigin: string, skillPackage: SkillPackage): SkillPackageManifest {
  return { ...skillPackage.manifest, url: skillArchiveUrl(webOrigin, skillPackage.manifest.version) };
}
