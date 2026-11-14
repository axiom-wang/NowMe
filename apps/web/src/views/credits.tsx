/**
 * “点数”页（contracts 12）：自己的余额、价目、兑换码、最近的流水。只给本人看。
 */
import type { FC } from 'hono/jsx';
import type { CreditEntry, CreditReason } from '../db/credits.js';
import { formatDateTime } from '../format.js';
import { CsrfField, Notice } from './forms.js';

export type CreditsNotice = { kind: 'redeemed'; credits: number };

export interface CreditsViewProps {
  csrf: string;
  balance: number;
  entries: CreditEntry[];
  prices: { generate: number; edit: number };
  /** 平台 AI 是否可用（不可用时点数暂时用不上，如实说明）。 */
  platformAvailable: boolean;
  /** 这个用户配置了自己的模型 Key（不消耗点数）。 */
  ownModel: boolean;
  wallName(wallId: string): string | null;
  notice: CreditsNotice | null;
  error: string | null;
  /** 输错时回填的兑换码。 */
  code: string;
}

const REASON_TEXT: Record<CreditReason, string> = {
  redeem: '兑换码',
  grant: '平台发放',
  signup: '注册赠送',
  adjust: '平台调整',
  sponsor_out: '转给墙的额度',
  sponsor_in: '组织者充入',
  sponsor_return: '墙关闭，额度退回',
  job: '生成 / 修改页面',
  job_refund: '没做出新版本，退回',
};

function describe(entry: CreditEntry, wallName: CreditsViewProps['wallName']): string {
  const text = REASON_TEXT[entry.reason];
  if ((entry.reason === 'sponsor_out' || entry.reason === 'sponsor_return') && entry.refId) {
    const name = wallName(entry.refId);
    return name ? `${text}「${name}」` : text;
  }
  return text;
}

export const CreditsView: FC<CreditsViewProps> = ({ csrf, balance, entries, prices, platformAvailable, ownModel, wallName, notice, error, code }) => (
  <div class="container container--form stack credits">
    <h1 class="display form-title">点数</h1>
    {notice ? <Notice tone="success">兑换成功，{notice.credits} 点已到账。</Notice> : null}

    <section class="card credits-balance" aria-labelledby="balance-heading">
      <h2 id="balance-heading" class="visually-hidden">
        我的余额
      </h2>
      <p class="credits-balance__number">
        <strong>{balance}</strong>
        <span>点</span>
      </p>
      <p class="muted">
        用 NOWMe 的 AI 做页面时消耗：生成一版页面 {prices.generate} 点，修改一次 {prices.edit} 点。采访、“和 TA 聊什么”不收点数；没做出新版本的那次也不收。
      </p>
      {ownModel ? <Notice tone="info">你在 AI 设置里填了自己的模型 Key：现在用的是你自己的 Key，不消耗点数。</Notice> : null}
      {!platformAvailable && !ownModel ? <Notice tone="warning">平台的 AI 暂时没有开放，点数现在用不上。你可以先在 AI 设置里填自己的模型 Key。</Notice> : null}
    </section>

    <section class="card stack" aria-labelledby="redeem-heading">
      <h2 id="redeem-heading">用兑换码补充</h2>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <form method="post" action="/account/credits/redeem" class="stack">
        <CsrfField token={csrf} />
        <label class="field" for="redeem-code">
          兑换码
          <input id="redeem-code" type="text" name="code" value={code} required maxlength={40} autocomplete="off" autocapitalize="characters" spellcheck={false} placeholder="NM-XXXX-XXXX-XXXX-XXXX" class="credits-code" />
        </label>
        <button type="submit" class="btn btn--primary">
          兑换
        </button>
      </form>
      <p class="muted">
        还有两种不花自己点数的办法：请组织者给这面墙充额度（成员做页面时先用墙的），或者在 <a href="/account/ai">AI 设置</a> 里填自己的模型 Key。
      </p>
    </section>

    <section class="card" aria-labelledby="history-heading">
      <h2 id="history-heading">最近的记录</h2>
      {entries.length === 0 ? (
        <p class="muted">还没有记录。</p>
      ) : (
        <ol class="credits-history">
          {entries.map((entry) => (
            <li class="credits-history__row">
              <span class="credits-history__what">
                {describe(entry, wallName)}
                <span class="muted credits-history__when">{formatDateTime(entry.createdAt)}</span>
              </span>
              <span class={`credits-history__delta${entry.delta > 0 ? ' credits-history__delta--in' : ''}`}>
                {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
              </span>
              <span class="muted credits-history__after">余 {entry.balanceAfter}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
    <p>
      <a href="/">返回我的墙</a>
    </p>
  </div>
);
