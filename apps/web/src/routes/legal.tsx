/**
 * 用户协议与隐私政策（contracts 16.3）：`GET /terms`、`GET /privacy`，公开页面，不需要登录。
 * 页脚（views/layout.tsx）与欢迎 / 重新确认页都链接到这里。
 */
import type { AppDeps, AppHono } from '../context.js';
import { renderPage } from '../views/layout.js';
import { PrivacyView, TermsView } from '../views/legal.js';

export function registerLegalRoutes(app: AppHono, deps: AppDeps): void {
  const props = { contactEmail: deps.config.contactEmail, moderation: deps.config.moderation.url !== null };
  app.get('/terms', (c) => renderPage(c, { title: '用户协议', bodyClass: 'page--legal', body: <TermsView {...props} /> }));
  app.get('/privacy', (c) => renderPage(c, { title: '隐私政策', bodyClass: 'page--legal', body: <PrivacyView {...props} /> }));
}
