/**
 * 点数（contracts 12）。
 *
 * | 路径 | 谁能访问 | 说明 |
 * | --- | --- | --- |
 * | GET /account/credits | 登录用户 | 自己的余额、价目、最近的流水、兑换码输入框 |
 * | POST /account/credits/redeem | 登录用户（会话 + CSRF + Origin） | 兑换一个兑换码；按用户限流，防止撞码 |
 * | POST /w/:wallId/admin/credits | 这面墙的组织者 | 把自己的点数转给墙、设置每位成员上限 |
 *
 * 每个人只能看到自己的余额与流水。组织者在后台只看到墙额度的聚合数字，看不到任何成员用了多少（S5、S10）。
 * 演示模式没有这些页面（演示账号用维护者预置的模型，不涉及点数）。
 */
import { CREDIT_HISTORY_LIMIT } from '@nowme/contracts';
import type { AppDeps, AppHono } from '../context.js';
import { RATE_RULES } from '../constants.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findOrganizerWall } from '../services/access.js';
import { redeemCode, sponsorWall, userAccount } from '../services/billing.js';
import { CreditsView, type CreditsNotice } from '../views/credits.js';
import { renderNotFound } from '../views/errors.js';
import { renderPage } from '../views/layout.js';

const REDEEM_ERROR_TEXT = {
  invalid: '这个兑换码不对。核对一下再输入（不分大小写，横线可以省略）。',
  used: '这个兑换码已经被用过了。一个码只能用一次；如果不是你用的，请联系发码的人。',
  expired: '这个兑换码已经过期了。可以向发码的人再要一个。',
  limited: '试得有点多了，大约 10 分钟后再试。',
} as const;

function wholeNumber(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (value === '') return 0;
  return /^\d{1,6}$/.test(value) ? Number(value) : null;
}

export function registerCreditsRoutes(app: AppHono, deps: AppDeps): void {
  if (deps.demo) return;
  const user = requireUser(deps);
  const form = requireForm(deps);

  const render = (c: Parameters<typeof authOf>[0], options: { notice?: CreditsNotice | null; error?: string | null; code?: string; status?: number } = {}) => {
    const auth = authOf(c);
    const account = userAccount(auth.user.id);
    return renderPage(c, {
      title: '点数',
      bodyClass: 'page--credits',
      status: options.status,
      body: (
        <CreditsView
          csrf={auth.session.csrfToken}
          balance={deps.repos.credits.balanceOf(account)}
          entries={deps.repos.credits.listEntries(account, CREDIT_HISTORY_LIMIT)}
          prices={deps.config.billing.prices}
          platformAvailable={deps.platformModel.available}
          ownModel={deps.userModels.ready(auth.user.id)}
          wallName={(wallId) => deps.repos.walls.findById(wallId)?.name ?? null}
          notice={options.notice ?? null}
          error={options.error ?? null}
          code={options.code ?? ''}
        />
      ),
    });
  };

  app.get('/account/credits', user, (c) => {
    const redeemed = /^[1-9]\d{0,5}$/.test(c.req.query('redeemed') ?? '') ? Number(c.req.query('redeemed')) : null;
    return render(c, { notice: redeemed ? { kind: 'redeemed', credits: redeemed } : null });
  });

  app.post('/account/credits/redeem', form, (c) => {
    const auth = authOf(c);
    const raw = c.get('form').code ?? '';
    // 按用户限流：兑换码有 80 bit 随机，撞不出来，但也不该让人一直试
    if (!deps.rateLimiter.hit('redeem', auth.user.id, RATE_RULES.redeem).ok) return render(c, { error: REDEEM_ERROR_TEXT.limited, code: raw.slice(0, 40), status: 429 });
    const result = redeemCode(deps, auth.user.id, raw);
    if (!result.ok) return render(c, { error: REDEEM_ERROR_TEXT[result.error], code: raw.slice(0, 40), status: 400 });
    return c.redirect(`/account/credits?redeemed=${result.credits}`, 303);
  });

  app.post('/w/:wallId/admin/credits', form, (c) => {
    const auth = authOf(c);
    const organizer = findOrganizerWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!organizer) return renderNotFound(c);
    const fields = c.get('form');
    const credits = wholeNumber(fields.credits);
    const memberCap = wholeNumber(fields.memberCap);
    const back = `/w/${organizer.wall.id}/admin`;
    if (credits === null) return c.redirect(`${back}?credits=bad-amount#credits`, 303);
    if (memberCap === null) return c.redirect(`${back}?credits=bad-cap#credits`, 303);
    const result = sponsorWall(deps, organizer.wall, auth.user.id, { credits, memberCap });
    return c.redirect(result.ok ? `${back}?notice=credits-saved#credits` : `${back}?credits=${result.error}#credits`, 303);
  });
}
