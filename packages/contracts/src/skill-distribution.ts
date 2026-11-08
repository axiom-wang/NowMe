/** Skill 成品的公开分发地址；源码仍在 NOWMe 主仓库维护（contracts 4.5）。 */
export const SKILL_GITHUB_REPOSITORY = 'axiom-wang/nowme-skill';
export const SKILL_GITHUB_URL = `https://github.com/${SKILL_GITHUB_REPOSITORY}`;
export const SKILL_PUBLIC_INSTALL_DOC = `https://raw.githubusercontent.com/${SKILL_GITHUB_REPOSITORY}/main/install.md`;
export const SKILL_PUBLIC_MANIFEST = `${SKILL_GITHUB_URL}/releases/latest/download/manifest.json`;
export const SKILL_INSTALL_COMMAND = `npx skills add ${SKILL_GITHUB_REPOSITORY} --skill nowme-page -g`;

export function skillReleaseArchiveUrl(version: string): string {
  return `${SKILL_GITHUB_URL}/releases/download/v${version}/nowme-page-${version}.tar.gz`;
}
