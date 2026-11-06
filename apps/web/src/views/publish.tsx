/**
 * 工作区里的发布相关组件（T3.2，W10、W11、W12、W15、W16）：
 * - `WallStatusSection`：墙上的页面（当前发布的版本、主人确认的缩略卡、联系方式是否公开、撤下）+ 公开链接；
 * - `PublishForm`：选中版本的发布确认（缩略卡、联系方式、公开范围、必勾的确认），也用于恢复旧版本；
 * - `MoreActionsSection`：删除这一页、退出这面墙的入口（各自先进确认页）。
 *
 * 样式在 `static/workspace.css`（主站 CSP 不允许内联样式）。所有表单都是带 `_csrf` 的 POST。
 */
import type { Card } from '@nowme/contracts';
import { CARD_LIMITS } from '@nowme/contracts';
import type { FC } from 'hono/jsx';
import { CONTACT_CHANNEL_LABELS, CONTACT_CHANNELS } from '../db/publications.js';
import { formatDateTime } from '../format.js';
import { CONTACT_VALUE_MAX, type PublishFormModel, type PublishMode } from '../services/publish.js';
import type { WorkspaceModel } from '../services/workspace.js';
import { CsrfField, PostButton } from './forms.js';

function basePath(model: WorkspaceModel): string {
  return `/w/${model.wall.id}/me`;
}

/** 主人确认后的缩略卡（墙上看到的样子）。 */
export const MiniCard: FC<{ card: Card }> = ({ card }) => (
  <div class="mini-card">
    <p class="mini-card__name">{card.displayName}</p>
    <p class="mini-card__tagline">{card.tagline}</p>
    <ul class="mini-card__hooks">
      {card.hooks.map((hook) => (
        <li>
          <span class="mini-card__hook">{hook.text}</span>
          <span class="mini-card__opener muted">开场白：{hook.opener}</span>
        </li>
      ))}
    </ul>
  </div>
);

const PublicLinkBlock: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const { publish } = model;
  const action = `${basePath(model)}/public-link`;
  return (
    <div class="public-link" id="public-link">
      <h3>公开链接</h3>
      {publish.publicLinkUrl ? (
        <>
          <p>
            <span class="badge badge--ok">已开启</span> 任何拿到链接的人不用登录就能看到你的页面本身，但看不到联系方式与接话点。
          </p>
          <pre class="code code--wrap public-link__url" id="nm-public-link">
            {publish.publicLinkUrl}
          </pre>
          {publish.state !== 'published' ? (
            <p class="notice notice--warning">现在墙上没有你的页面，打开这个链接会显示“找不到”；重新发布后链接就能看到页面。</p>
          ) : null}
          <div class="actions">
            <button type="button" class="btn btn--primary" data-copy="nm-public-link">
              复制链接
            </button>
            <PostButton
              action={action}
              csrf={model.csrf}
              fields={{ enabled: '1' }}
              label="换一个新链接"
              confirm="换新链接后，旧链接立即失效。继续吗？"
            />
            <PostButton
              action={action}
              csrf={model.csrf}
              fields={{ enabled: '0' }}
              label="关闭公开链接"
              variant="danger"
              confirm="关闭后这个链接立即失效；以后重新开启会生成一个新的链接。继续吗？"
            />
          </div>
        </>
      ) : (
        <>
          <p class="muted">
            <span class="badge">未开启</span> 默认只有这面墙的成员能看到你的页面。开启后会生成一个链接，墙外的人不用登录也能看到页面本身（不含联系方式与接话点）；随时可以关闭，关闭后旧链接立即失效。
          </p>
          <div class="actions">
            <PostButton action={action} csrf={model.csrf} fields={{ enabled: '1' }} label="开启公开链接" />
          </div>
        </>
      )}
    </div>
  );
};

export const WallStatusSection: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const { publish } = model;
  const active = publish.active;
  return (
    <section class="card wall-status" id="wall-status" aria-labelledby="wall-status-heading">
      <h2 id="wall-status-heading">墙上的页面</h2>
      {active ? (
        <>
          <p class="wall-status__line">
            <span class="badge badge--ok">已发布</span>
            <span>
              墙上展示的是{active.revisionNumber !== null ? `第 ${active.revisionNumber} 版` : '你发布的版本'} ·{' '}
              {formatDateTime(active.publication.publishedAt)} 发布
            </span>
          </p>
          {active.card ? <MiniCard card={active.card} /> : null}
          <dl class="facts">
            <div>
              <dt>联系方式</dt>
              <dd>
                {active.contact
                  ? `公开（${CONTACT_CHANNEL_LABELS[active.contact.channel]}：${active.contact.value}）：墙内成员点“想聊这个”时可以看到`
                  : '不公开：墙上不显示“想聊这个”'}
              </dd>
            </div>
          </dl>
          <div class="actions">
            {model.selected?.id !== active.publication.revisionId ? (
              <a class="btn btn--ghost" href={`${basePath(model)}?rev=${active.publication.revisionId}#publish`}>
                查看或修改这一版
              </a>
            ) : null}
            <PostButton
              action={`${basePath(model)}/withdraw`}
              csrf={model.csrf}
              label="从墙上撤下"
              variant="danger"
              confirm="撤下后，墙上的成员立即看不到你的页面（公开链接也会显示“找不到”）。版本都会保留，之后可以重新发布。继续吗？"
            />
          </div>
        </>
      ) : publish.state === 'withdrawn' ? (
        <p class="wall-status__line">
          <span class="badge">已撤下</span>
          <span>
            {publish.lastEndedAt ? `${formatDateTime(publish.lastEndedAt)} 从墙上撤下。` : ''}
            墙上的成员现在看不到你的页面；在下面选一个版本、确认后即可重新发布。
          </span>
        </p>
      ) : (
        <p class="wall-status__line">
          <span class="badge">未发布</span>
          <span>墙上的成员还看不到你的页面。选一个通过校验的版本，确认缩略卡与联系方式后发布。</span>
        </p>
      )}
      <PublicLinkBlock model={model} />
    </section>
  );
};

const MODE_TEXT: Record<PublishMode, { heading: (n: number) => string; button: (n: number) => string }> = {
  first: { heading: (n) => `发布第 ${n} 版到墙上`, button: () => '确认发布' },
  relaunch: { heading: (n) => `重新发布：第 ${n} 版`, button: () => '确认发布' },
  update: { heading: (n) => `用第 ${n} 版更新墙上的页面`, button: (n) => `更新为第 ${n} 版` },
  restore: { heading: (n) => `恢复为第 ${n} 版`, button: (n) => `恢复为第 ${n} 版` },
  republish: { heading: () => '修改缩略卡或联系方式', button: () => '保存并重新发布' },
};

function modeIntro(form: PublishFormModel, activeNumber: number | null): string {
  switch (form.mode) {
    case 'first':
      return '确认下面的缩略卡与联系方式后发布。没有发布之前，墙上的其他人看不到这一页。';
    case 'relaunch':
      return '你的页面已从墙上撤下。确认下面的内容后重新发布。';
    case 'update':
      return `墙上现在是第 ${activeNumber ?? '?'} 版。确认后墙上会换成这一版；没有确认成功时，墙上的页面保持不变。`;
    case 'restore':
      return `墙上现在是第 ${activeNumber ?? '?'} 版。恢复会把墙上换回这一版，不会改变公开链接的开关，联系方式按你下面的选择。`;
    case 'republish':
      return '墙上展示的就是这一版。改好后重新发布，墙上的缩略卡与联系方式会随之更新。';
  }
}

const ERROR_ORDER = (form: PublishFormModel): string[] => [
  'form',
  'displayName',
  'tagline',
  'hooks',
  ...form.values.hooks.flatMap((_, index) => [`hooks.${index}.text`, `hooks.${index}.opener`]),
  'contactChannel',
  'contactValue',
  'confirm',
];

const FieldError: FC<{ id: string; message: string | undefined }> = ({ id, message }) =>
  message ? (
    <p class="field__error" id={id}>
      {message}
    </p>
  ) : null;

interface TextFieldProps {
  id: string;
  name: string;
  label: string;
  hint: string;
  value: string;
  error: string | undefined;
  multiline?: boolean;
}

const TextField: FC<TextFieldProps> = ({ id, name, label, hint, value, error, multiline }) => {
  const describedBy = error ? `${id}-hint ${id}-error` : `${id}-hint`;
  return (
    <div class={error ? 'field field--invalid' : 'field'}>
      <label class="field__label" for={id}>
        {label}
      </label>
      {multiline ? (
        <textarea id={id} name={name} rows={3} aria-describedby={describedBy} aria-invalid={error ? 'true' : undefined}>
          {value}
        </textarea>
      ) : (
        <input
          type="text"
          id={id}
          name={name}
          value={value}
          autocomplete="off"
          aria-describedby={describedBy}
          aria-invalid={error ? 'true' : undefined}
        />
      )}
      <p class="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
};

const PublishFormBody: FC<{ model: WorkspaceModel; form: PublishFormModel }> = ({ model, form }) => {
  const { values, errors } = form;
  const text = MODE_TEXT[form.mode];
  const messages = ERROR_ORDER(form)
    .map((key) => errors[key])
    .filter((message): message is string => Boolean(message));
  return (
    <>
      {messages.length > 0 ? (
        <div class="notice notice--error" role="alert">
          <p>还有 {messages.length} 处需要修改，改好后再点“{text.button(form.revisionNumber)}”。墙上的页面没有变化。</p>
          <ul class="error-list">
            {messages.map((message) => (
              <li>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <form method="post" action={`${basePath(model)}/publish`} class="publish-form">
        <CsrfField token={model.csrf} />
        <input type="hidden" name="revisionId" value={form.revisionId} />

        <fieldset class="publish-form__group">
          <legend>缩略卡</legend>
          <p class="field__hint">
            墙上显示的入口：名字、一行介绍和 {CARD_LIMITS.hooks.min}–{CARD_LIMITS.hooks.max} 个接话点。
            {form.prefill === 'publication'
              ? '预填的是你上次发布这一版时确认的内容。'
              : form.prefill === 'card'
                ? '预填的是 Agent 写在这一版 card.json 里的草稿，你可以改写；只有你在这里确认的内容会出现在墙上。'
                : ''}
          </p>
          <TextField
            id="pf-display-name"
            name="displayName"
            label="名字"
            hint={`${CARD_LIMITS.displayName.min}–${CARD_LIMITS.displayName.max} 个字，可以用昵称`}
            value={values.displayName}
            error={errors.displayName}
          />
          <TextField
            id="pf-tagline"
            name="tagline"
            label="一行介绍"
            hint={`${CARD_LIMITS.tagline.min}–${CARD_LIMITS.tagline.max} 个字`}
            value={values.tagline}
            error={errors.tagline}
          />
          <div class="hooks">
            <p class="field__label">
              接话点（保留 {CARD_LIMITS.hooks.min}–{CARD_LIMITS.hooks.max} 个）
            </p>
            <p class="field__hint">别人点某个接话点上的“想聊这个”时，会复制对应的开场白来找你。写得越具体越好接话。</p>
            <FieldError id="pf-hooks-error" message={errors.hooks} />
            {values.hooks.map((hook, index) => (
              <fieldset class={hook.remove ? 'hook hook--removed' : 'hook'}>
                <legend>接话点 {index + 1}</legend>
                <input type="hidden" name={`hooks[${index}][id]`} value={hook.id} />
                <TextField
                  id={`pf-hook-${index}-text`}
                  name={`hooks[${index}][text]`}
                  label="接话点"
                  hint={`${CARD_LIMITS.hookText.min}–${CARD_LIMITS.hookText.max} 个字`}
                  value={hook.text}
                  error={errors[`hooks.${index}.text`]}
                />
                <TextField
                  id={`pf-hook-${index}-opener`}
                  name={`hooks[${index}][opener]`}
                  label="开场白（别人复制它来找你）"
                  hint={`${CARD_LIMITS.hookOpener.min}–${CARD_LIMITS.hookOpener.max} 个字，站在来找你的人的角度写`}
                  value={hook.opener}
                  error={errors[`hooks.${index}.opener`]}
                  multiline
                />
                <label class="check">
                  <input type="checkbox" name={`hooks[${index}][remove]`} value="1" checked={hook.remove} />
                  <span>不用这个接话点</span>
                </label>
              </fieldset>
            ))}
          </div>
        </fieldset>

        <fieldset class="publish-form__group">
          <legend>联系方式</legend>
          <div class="contact-row">
            <div class={errors.contactChannel ? 'field field--invalid' : 'field'}>
              <label class="field__label" for="pf-contact-channel">
                渠道
              </label>
              <select id="pf-contact-channel" name="contactChannel">
                {CONTACT_CHANNELS.map((channel) => (
                  <option value={channel} selected={values.contactChannel === channel}>
                    {CONTACT_CHANNEL_LABELS[channel]}
                  </option>
                ))}
              </select>
              <FieldError id="pf-contact-channel-error" message={errors.contactChannel} />
            </div>
            <TextField
              id="pf-contact-value"
              name="contactValue"
              label="账号或号码"
              hint={`最多 ${CONTACT_VALUE_MAX} 个字`}
              value={values.contactValue}
              error={errors.contactValue}
            />
          </div>
          <label class="check">
            <input type="checkbox" name="contactPublic" value="1" checked={values.contactPublic} />
            <span>公开联系方式：墙内成员点“想聊这个”时可以看到</span>
          </label>
          <p class="field__hint">
            {form.sceneDefault ? '按这面墙的场景习惯预选。' : '预选的是你上次的选择。'}
            不公开时，墙上不显示“想聊这个”，联系方式不会写进发布内容；组织者和公开链接都看不到你的联系方式。
          </p>
        </fieldset>

        <fieldset class="publish-form__group publish-form__confirm">
          <legend>确认</legend>
          <label class={errors.confirm ? 'check check--strong check--invalid' : 'check check--strong'}>
            <input type="checkbox" name="confirm" value="1" required checked={values.confirm} />
            <span>发布后，以上内容对这面墙的成员可见</span>
          </label>
          <FieldError id="pf-confirm-error" message={errors.confirm} />
          {model.publish.publicLinkUrl ? (
            <p class="field__hint">你的公开链接已开启：墙外拿到链接的人也能看到页面本身（不含联系方式与接话点）。</p>
          ) : null}
          <button type="submit" class="btn btn--primary btn--block">
            {text.button(form.revisionNumber)}
          </button>
        </fieldset>
      </form>
    </>
  );
};

/** 选中版本的发布确认（PublishSlot）。 */
export const PublishForm: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const form = model.publish.form;
  if (!form) return null;
  const text = MODE_TEXT[form.mode];
  const activeNumber = model.publish.active?.revisionNumber ?? null;
  if (form.unavailable) {
    return (
      <div class="publish" id="publish">
        <h3>{text.heading(form.revisionNumber)}</h3>
        <p class="notice notice--warning">这一版的缩略卡（card.json）读不出来，不能发布。请让 Agent 检查 card.json 后重新提交一版。</p>
      </div>
    );
  }
  const hasErrors = Object.keys(form.errors).length > 0;
  return (
    <div class="publish" id="publish">
      {form.mode === 'republish' && !hasErrors ? (
        <details class="publish__details">
          <summary>{text.heading(form.revisionNumber)}</summary>
          <p class="muted">{modeIntro(form, activeNumber)}</p>
          <PublishFormBody model={model} form={form} />
        </details>
      ) : (
        <>
          <h3>{text.heading(form.revisionNumber)}</h3>
          <p class="muted">{modeIntro(form, activeNumber)}</p>
          <PublishFormBody model={model} form={form} />
        </>
      )}
    </div>
  );
};

export const MoreActionsSection: FC<{ model: WorkspaceModel }> = ({ model }) => (
  <section class="card more-actions" aria-labelledby="more-heading">
    <h2 id="more-heading">删除与退出</h2>
    <ul class="link-list">
      <li>
        <a href={`${basePath(model)}/delete`}>删除这一页…</a>
        <span class="muted">删除全部版本的文件、撤下页面、关闭公开链接、断开本地 Agent；你仍是这面墙的成员，可以重新开始。删除前会先说明影响范围。</span>
      </li>
      <li>
        {model.publish.isOrganizer ? (
          <span class="muted">你是这面墙的组织者，不能退出；活动结束后可以在组织者后台关闭这面墙。</span>
        ) : (
          <>
            <a href={`/w/${model.wall.id}/leave`}>退出这面墙…</a>
            <span class="muted">撤下页面并断开本地 Agent；版本会保留，用邀请重新加入后需要重新确认发布。</span>
          </>
        )}
      </li>
    </ul>
  </section>
);
