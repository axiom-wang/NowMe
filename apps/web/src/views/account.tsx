/**
 * 注销账号的确认页与结果页（contracts 14）。沿用删除页面的确认页样式（confirm / impact）。
 */
import type { FC } from 'hono/jsx';
import { CsrfField, Notice } from './forms.js';

const Intro: FC<{ title: string }> = ({ title }) => (
  <section class="page-intro">
    <p class="crumbs">
      <a href="/account/data">我的资料</a>
    </p>
    <h1 class="hero__title">{title}</h1>
  </section>
);

const Consequences: FC = () => (
  <>
    <h2 id="account-delete-heading">注销后会发生什么</h2>
    <p>注销后不能恢复，也没有冷静期。确认之前，先看看会删掉什么：</p>
    <ul class="impact">
      <li>你在所有墙上的页面立刻下墙，所有版本的页面、图片、封面和截图都会删除；公开链接马上失效。</li>
      <li>你在应用里的采访内容、brief、上传的图片、长期画像、头像，以及“和 TA 聊什么”的结果都会删除。</li>
      <li>你会退出所有墙。你发过的聊天消息会变成“该用户已注销”，别人看到的名字是“已注销用户”。</li>
      <li>本地 Agent 立刻断开；AI 设置和你保存的模型 Key 一并删除。</li>
      <li>没用完的点数作废，不能退回，也不能转给别人。</li>
      <li>所有设备上的登录马上失效。以后用同一个邮箱登录，会是一个全新的账号，找不回现在的内容，也不会再送注册点数。</li>
      <li>如果有人举报过你、平台还没处理完，被举报的那部分内容会单独保留一份，只给平台处理举报用，处理完或最多 180 天后删除。</li>
    </ul>
    <h3 class="impact__keep-title">不受影响</h3>
    <ul class="impact impact--keep">
      <li>你电脑上的 brief.md、长期画像（~/.nowme/profile.md）和 page/ 目录——它们从来没有上传过，想清理请自己在本地删除。</li>
      <li>别人在墙上发的内容和他们自己的聊天消息。</li>
    </ul>
    <p>
      想留一份备份？先 <a href="/account/export">导出我的数据</a>（一个 zip 文件，里面有你的页面文件和资料）。
    </p>
  </>
);

export interface AccountDeleteViewProps {
  csrf: string;
  email: string;
  /** 他还是组织者、仍开放的墙：必须先关闭。 */
  blocking: { id: string; name: string }[];
  /** `code`：确认码已发出，显示输入框。 */
  stage: 'intro' | 'code';
  error?: string | null;
  notice?: string | null;
}

export const AccountDeleteView: FC<AccountDeleteViewProps> = ({ csrf, email, blocking, stage, error, notice }) => (
  <div class="container container--narrow">
    <Intro title="注销账号" />
    {blocking.length > 0 ? (
      <section class="card confirm" aria-labelledby="account-delete-blocked">
        <h2 id="account-delete-blocked">先关闭你组织的墙</h2>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <p>你还是下面这些墙的组织者，墙上还有其他成员在用。注销前请先在组织者后台关闭它们（关闭后墙对所有人不可见，所有页面一并下墙）：</p>
        <ul class="impact">
          {blocking.map((wall) => (
            <li>
              「{wall.name}」 <a href={`/w/${wall.id}/admin`}>去组织者后台</a>
            </li>
          ))}
        </ul>
        <div class="actions">
          <a class="btn btn--ghost" href="/account/data">
            回到我的资料
          </a>
        </div>
      </section>
    ) : (
      <section class="card confirm confirm--danger" aria-labelledby="account-delete-heading">
        <Consequences />
        {notice ? <Notice tone="success">{notice}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {stage === 'intro' ? (
          <form method="post" action="/account/delete/code" class="confirm__form">
            <CsrfField token={csrf} />
            <p class="muted">为了确认是你本人，我们会给 {email} 发一个确认码。</p>
            <div class="actions">
              <button type="submit" class="btn btn--danger-solid">
                给我的邮箱发确认码
              </button>
              <a class="btn btn--ghost" href="/account/data">
                取消
              </a>
            </div>
          </form>
        ) : (
          <>
            <form method="post" action="/account/delete" class="confirm__form stack">
              <CsrfField token={csrf} />
              <label>
                邮箱里收到的 6 位确认码
                <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength={6} pattern="[0-9]{6}" required />
              </label>
              <label class="check check--strong">
                <input type="checkbox" name="confirm" value="1" required />
                <span>我明白注销后所有内容都会删除，不能恢复</span>
              </label>
              <div class="actions">
                <button type="submit" class="btn btn--danger-solid">
                  注销账号
                </button>
                <a class="btn btn--ghost" href="/account/data">
                  取消
                </a>
              </div>
            </form>
            <form method="post" action="/account/delete/code" class="inline-form">
              <CsrfField token={csrf} />
              <button type="submit" class="btn btn--ghost">
                没收到？重新发一个
              </button>
            </form>
          </>
        )}
      </section>
    )}
  </div>
);

export const AccountDeletedView: FC = () => (
  <div class="container container--narrow">
    <section class="card status-card">
      <p class="status-card__mark" aria-hidden="true">
        ↗
      </p>
      <h1 class="hero__title">账号已注销</h1>
      <p>你的页面、资料和聊天内容都已删除，所有设备上的登录也已退出。谢谢你来过。</p>
      <p>
        <a class="btn btn--primary" href="/login">
          回到登录页
        </a>
      </p>
    </section>
  </div>
);
