/**
 * 未登录首页（`GET /`）：先讲给组织者听（建墙 → 发邀请 → 新人上墙 → 找到话题），
 * 再告诉被邀请来的成员怎么开始，最后是隐私承诺和登录入口；演示模式的登录按钮显示为“体验”。
 * 墙面示意是纯 HTML + CSS（不放真人资料），样式在 `static/landing.css`。
 */
import type { FC } from 'hono/jsx';
import { LOGIN_CODE_DIGITS } from '@nowme/contracts';

/** 建墙需要先登录；登录后回到建墙页。 */
export const LANDING_CREATE_HREF = `/login?next=${encodeURIComponent('/walls/new')}`;
export const LANDING_LOGIN_HREF = '/login';

interface SampleNote {
  name: string;
  line: string;
  hooks: string[];
  tone: 'lime' | 'paper' | 'orange' | 'ink' | 'blue';
}

const SAMPLE_NOTES: readonly SampleNote[] = [
  { name: '阿栗', line: '大二，拍胶片，周末常在城郊扫街', hooks: ['想找人一起冲洗', '富士 400'], tone: 'paper' },
  { name: '周一一', line: '前端，想做点好玩的小工具', hooks: ['缺一位会画画的队友'], tone: 'lime' },
  { name: 'Momo', line: '刚转来的交换生，会做饭', hooks: ['求推荐学校附近的面馆'], tone: 'orange' },
  { name: '陈默', line: '吉他手，乐队还差个鼓手', hooks: ['后摇', '周三晚排练'], tone: 'blue' },
];

/** 示意便签的颜色：用 app.css 的共享便签（.note）。 */
const NOTE_CLASS = { paper: 'note', lime: 'note note--lime', orange: 'note note--orange', ink: 'note note--ink', blue: 'note note--blue' } as const;

const WallPreview: FC = () => (
  <figure class="landing-board" aria-label="墙的样子：每个人一张自己做的页面，AI 帮你找到能聊的点">
    <div class="landing-board__bar" aria-hidden="true">
      <span class="landing-board__title">摄影社 · 秋季新人墙</span>
      <span class="landing-board__count">23 人已上墙</span>
    </div>
    <ul class="landing-board__notes" aria-hidden="true">
      {SAMPLE_NOTES.map((note) => (
        <li class={`${NOTE_CLASS[note.tone]} landing-note landing-note--${note.tone}`}>
          <span class="landing-note__avatar">{[...note.name][0]}</span>
          <strong class="landing-note__name">{note.name}</strong>
          <span class="landing-note__line">{note.line}</span>
          <span class="landing-note__hooks">{note.hooks.map((hook) => <span class="landing-note__hook">{hook}</span>)}</span>
        </li>
      ))}
    </ul>
    <figcaption class="landing-board__ai">
      <span class="landing-board__ai-label">和 TA 聊什么</span>
      你们都爱拍胶片。可以这样开头：“你的富士 400 在哪冲的？我一直没找到靠谱的店。”
    </figcaption>
  </figure>
);

const STEPS = [
  {
    n: '01',
    title: '建一面墙',
    text: '起个名字，选一下是黑客松、兴趣社群还是社团招新。一分钟搞定，拿到邀请链接和二维码。',
  },
  {
    n: '02',
    title: '把邀请发到群里',
    text: '新人点开链接加入，和 AI 聊几句，几分钟就有一页像自己的介绍。自己点发布，才会挂上墙。',
  },
  {
    n: '03',
    title: '大家在墙上互相认识',
    text: '翻翻墙就知道谁和谁合得来。看到想认识的人，AI 帮你找到共同点，起草第一句话。',
  },
] as const;

const PROMISES = [
  { title: '只有圈子里的人看得到', text: '墙只对加入的成员开放。想给圈外的人看，得你自己单独打开分享链接。' },
  { title: '你点发布，才会上墙', text: 'AI 做好的页面先给你看，改到满意再发。之后随时可以撤下来。' },
  { title: 'AI 只帮你起头', text: '它会帮你找话题、写好开场白放进输入框，发不发、怎么改，都由你决定。它不会替你发消息。' },
  { title: '组织者看不到你的草稿', text: '组织者只看得到昵称、加入时间和有没有发布，看不到你和 AI 的聊天，也看不到没公开的联系方式。' },
] as const;

export const LandingView: FC<{ demo?: boolean }> = ({ demo = false }) => (
  <div class="landing">
    <section class="landing-hero" aria-labelledby="landing-heading">
      <div class="landing-hero__copy">
        <p class="eyebrow">给刚组起来的圈子</p>
        <h1 id="landing-heading" class="landing-hero__title display">
          给你的圈子
          <br />
          建<mark>一面墙</mark>
        </h1>
        <p class="landing-hero__lead">
          新人进群，不用再挨个做自我介绍。每个人和 AI 聊几句，做一页有个性的自己，挂在大家共同的墙上；看到对的人，AI 帮你找到话题、起个头。
        </p>
        <div class="landing-hero__actions">
          <a class="btn btn--primary btn--lg" href={LANDING_CREATE_HREF}>建一面墙</a>
          <a class="btn btn--ghost btn--lg" href="#invited">我收到了邀请</a>
        </div>
        <p class="landing-hero__fine">用邮箱登录，收一个 {LOGIN_CODE_DIGITS} 位验证码就行，不用设密码。</p>
      </div>
      <WallPreview />
    </section>

    <section class="landing-section" aria-labelledby="landing-steps-heading">
      <h2 id="landing-steps-heading" class="landing-section__title display">组织者只要做三件事</h2>
      <ol class="landing-steps">
        {STEPS.map((step) => (
          <li class="landing-step">
            <span class="landing-step__n">{step.n}</span>
            <h3 class="landing-step__title">{step.title}</h3>
            <p class="landing-step__text">{step.text}</p>
          </li>
        ))}
      </ol>
      <p class="landing-section__note">适合 10 到 100 人的圈子：黑客松、创业营、兴趣社群、社团招新、新成员入群。</p>
    </section>

    <section id="invited" class="landing-invited" aria-labelledby="landing-invited-heading">
      <div class="landing-invited__head">
        <span class="sticker sticker--orange landing-invited__sticker" aria-hidden="true">嘿，新人</span>
        <h2 id="landing-invited-heading" class="landing-section__title display">收到邀请了？</h2>
        <p class="landing-invited__lead">组织者会在群里发一个链接或二维码，从那里进来就对了。</p>
      </div>
      <ol class="landing-invited__steps">
        <li><strong>打开邀请链接</strong>扫码或点链接都行，会先看到是哪面墙。</li>
        <li><strong>用邮箱登录</strong>第一次登录会自动建好账号，起个昵称就能加入。</li>
        <li><strong>做你的那一页</strong>可以在网页里和 AI 聊，也可以用你自己电脑上的 AI 助手来做。</li>
      </ol>
      <p class="landing-invited__alt">
        已经加入过？<a href={LANDING_LOGIN_HREF}>直接登录</a>，就能回到你的墙。
      </p>
    </section>

    <section class="landing-section" aria-labelledby="landing-promise-heading">
      <h2 id="landing-promise-heading" class="landing-section__title display">我们答应你的</h2>
      <ul class="landing-promises">
        {PROMISES.map((promise) => (
          <li class="landing-promise">
            <h3 class="landing-promise__title">{promise.title}</h3>
            <p class="landing-promise__text">{promise.text}</p>
          </li>
        ))}
      </ul>
    </section>

    <section class="landing-final" aria-labelledby="landing-final-heading">
      <h2 id="landing-final-heading" class="landing-final__title display">
        下一批新人进群之前，
        <br />
        先给他们留一面墙。
      </h2>
      <div class="landing-final__actions">
        <a class="btn btn--accent btn--lg" href={LANDING_CREATE_HREF}>建一面墙</a>
        <a class="btn btn--on-dark btn--lg" href={LANDING_LOGIN_HREF}>{demo ? '体验' : '登录'}</a>
      </div>
    </section>
  </div>
);
