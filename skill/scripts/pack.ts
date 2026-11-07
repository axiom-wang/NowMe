/**
 * `pnpm --filter @nowme/skill pack:skill`：打 Skill 包到 `skill/dist-package/`（contracts 4.5），主站在 /skill 托管下载。
 */
import { SKILL_PACKAGE_DIR } from '../src/index.js';
import { packSkill } from '../src/pack.js';

const started = Date.now();
const result = await packSkill({ outDir: SKILL_PACKAGE_DIR });
const kb = (result.manifest.bytes / 1024).toFixed(0);
console.log(
  `[skill] 已打包 ${result.manifest.file}（${kb} KB，${result.files.length} 个文件，sha256 ${result.manifest.sha256.slice(0, 12)}…，${Date.now() - started} ms）→ ${SKILL_PACKAGE_DIR}`,
);
