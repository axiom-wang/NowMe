/**
 * Skill 分发（contracts 4.5）：公开路由，不需要登录，内容里没有任何 token 或凭证。
 *
 * | 路径 | 内容 |
 * | --- | --- |
 * | GET /skill | 给人看的安装页 |
 * | GET /skill/install.md | 给 Agent 读的安装说明（text/markdown） |
 * | GET /skill/manifest.json | 版本、下载地址、sha256 |
 * | GET /skill/nowme-page-<版本>.tar.gz | Skill 包（内容不可变，长缓存） |
 */
import { SKILL_INSTALL_DOC_PATH, SKILL_MANIFEST_PATH, SKILL_ROUTE_PREFIX, skillArchiveFileName } from '@nowme/contracts';
import type { AppDeps, AppHono } from '../context.js';
import { renderInstallDoc } from '../services/skill-install.js';
import { publicSkillManifest } from '../services/skill-package.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';
import { SkillPage } from '../views/skill.js';

/** 清单与说明会随部署更新：短缓存。 */
const SHORT_CACHE = 'public, max-age=300';

export function registerSkillRoutes(app: AppHono, deps: AppDeps): void {
  const { config } = deps;

  app.get(SKILL_ROUTE_PREFIX, (c) =>
    renderPage(c, {
      title: '安装 NOWMe Skill',
      body: <SkillPage webOrigin={config.webOrigin} skillPackage={deps.skillPackage} market={config.skillMarket} isProduction={config.isProduction} />,
    }),
  );

  app.get(SKILL_INSTALL_DOC_PATH, (c) => {
    const doc = renderInstallDoc({ webOrigin: config.webOrigin, skillPackage: deps.skillPackage, market: config.skillMarket });
    return c.body(doc, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': SHORT_CACHE });
  });

  app.get(SKILL_MANIFEST_PATH, (c) => {
    if (!deps.skillPackage) return renderNotFound(c);
    return c.json(publicSkillManifest(config.webOrigin, deps.skillPackage), 200, { 'Cache-Control': SHORT_CACHE });
  });

  app.get(`${SKILL_ROUTE_PREFIX}/:file`, (c) => {
    const skillPackage = deps.skillPackage;
    if (!skillPackage || c.req.param('file') !== skillArchiveFileName(skillPackage.manifest.version)) return renderNotFound(c);
    return c.body(skillPackage.archive, 200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${skillPackage.manifest.file}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });
}
