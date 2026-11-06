/**
 * @nowme/skill：Skill 内容的位置与读取函数（contracts 7）。
 *
 * 主站读取场景指南的 `id`、`label`、`defaults.contactPublic`、`hookKinds`；
 * CLI 与测试读取示例页清单。Skill 本身是给用户的 Agent 读的 Markdown 与 JSON，不需要运行代码。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENE_TYPES, sceneGuideSchema, type SceneGuide, type SceneType } from '@nowme/contracts';

/** `skill/` 目录。本文件位于 `src/` 或 `dist/`，向上一级即包根。 */
export const SKILL_DIR = fileURLToPath(new URL('../', import.meta.url));
export const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
export const SCENES_DIR = join(SKILL_DIR, 'scenes');
export const TEMPLATES_DIR = join(SKILL_DIR, 'templates');
export const REFERENCE_DIR = join(SKILL_DIR, 'reference');
export const EXAMPLES_DIR = join(SKILL_DIR, 'examples');
export const EXAMPLES_INDEX_FILE = join(EXAMPLES_DIR, 'index.json');
/** Skill 版本（写进示例与生成页面的 manifest.generator.skillVersion）。 */
export const SKILL_VERSION = '0.1.0';

/** 读取并校验一份场景指南（`scenes/<sceneType>.json`）。 */
export function loadSceneGuide(sceneType: SceneType): SceneGuide {
  const guide = sceneGuideSchema.parse(JSON.parse(readFileSync(join(SCENES_DIR, `${sceneType}.json`), 'utf8')));
  if (guide.id !== sceneType) throw new Error(`scenes/${sceneType}.json 的 id 是 ${guide.id}`);
  return guide;
}

/** 读取全部场景指南。 */
export function loadSceneGuides(): Record<SceneType, SceneGuide> {
  return Object.fromEntries(SCENE_TYPES.map((type) => [type, loadSceneGuide(type)])) as Record<SceneType, SceneGuide>;
}

export interface ExampleEntry {
  /** `examples/` 下的目录名。 */
  dir: string;
  sceneType: SceneType;
  /** 一句话风格描述（采访时的风格选择题选项）。 */
  style: string;
  /** 虚构人物与页面要点。 */
  persona: string;
  motionLevel: 'calm' | 'medium' | 'lively';
}

export interface ExamplesIndex {
  schemaVersion: 1;
  examples: ExampleEntry[];
}

/** 读取 `examples/index.json`。 */
export function loadExamplesIndex(): ExamplesIndex {
  return JSON.parse(readFileSync(EXAMPLES_INDEX_FILE, 'utf8')) as ExamplesIndex;
}

/** `examples/` 下的示例目录（不含 index.json 等文件）。 */
export function listExampleDirs(): string[] {
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
