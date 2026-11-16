/** 账号 AI 设置：当前登录用户自己的加密凭证，会话 + Origin + CSRF。 */
import { defaultModelEndpoint, MODEL_PROVIDERS, MODEL_PROVIDER_PRESETS } from '@nowme/contracts';
import type { FC } from 'hono/jsx';
import type { AppDeps, AppHono, FormFields } from '../context.js';
import { authOf, requireUser } from '../security/session.js';
import { requireForm } from '../security/forms.js';
import type { ModelRole, UserModelSummary } from '../hosted/user-models.js';
import { CsrfField, Notice, PostButton } from '../views/forms.js';
import { renderPage } from '../views/layout.js';

const EndpointFields: FC<{ role: ModelRole; value: UserModelSummary | null; draft?: FormFields | undefined }> = ({ role, value, draft }) => {
  const item = value?.endpoint ?? defaultModelEndpoint();
  const interview = role === 'interview';
  return (
    <fieldset class="ai-endpoint">
      <legend>
        <span class="ai-endpoint__number" aria-hidden="true">{interview ? '01' : '02'}</span>
        <span class="ai-endpoint__legend-copy">
          <strong>{interview ? '采访与整理资料' : '生成与修改页面'}</strong>
          <small>{interview ? '理解你的想法，整理成页面素材' : '把资料变成页面，并按你的意见调整'}</small>
        </span>
      </legend>
      <div class="ai-endpoint__grid">
        <label class="field" for={`${role}-provider`}>
          模型服务
          <select id={`${role}-provider`} name={`${role}_provider`} data-model-provider={role}>
            {MODEL_PROVIDERS.map((provider) => <option value={provider} data-base-url={MODEL_PROVIDER_PRESETS[provider].baseUrl ?? ''} data-model={(interview ? MODEL_PROVIDER_PRESETS[provider].interviewModel : MODEL_PROVIDER_PRESETS[provider].generateModel) ?? ''} data-vision={MODEL_PROVIDER_PRESETS[provider].vision ? '1' : '0'} selected={(draft ? draft[`${role}_provider`] : item.provider) === provider}>{MODEL_PROVIDER_PRESETS[provider].label}</option>)}
          </select>
        </label>
        <label class="field" for={`${role}-model`}>
          模型名称或接入点 ID
          <input id={`${role}-model`} type="text" name={`${role}_model`} value={draft ? draft[`${role}_model`] ?? '' : value?.endpoint.model ?? ''} placeholder="留空使用默认模型" maxlength={200} />
          <span class="field__hint">留空使用所选服务默认模型；无默认值时必填</span>
        </label>
        <label class="field ai-endpoint__wide" for={`${role}-url`}>
          API Base URL <span class="field__optional">选填</span>
          <input id={`${role}-url`} type="url" name={`${role}_baseUrl`} value={draft ? draft[`${role}_baseUrl`] ?? '' : value?.endpoint.baseUrl ?? ''} placeholder="留空使用所选服务的预设地址" maxlength={2048} />
        </label>
        <label class="field ai-endpoint__wide" for={`${role}-key`}>
          <span>API Key{value?.hasKey ? <span class="ai-endpoint__saved">已加密保存，留空沿用</span> : null}</span>
          <input id={`${role}-key`} type="password" name={`${role}_apiKey`} autocomplete="new-password" maxlength={4096} spellcheck={false} placeholder={value?.hasKey ? '不修改就不用重新填写' : '粘贴你的 API Key'} />
        </label>
      </div>
      <div class="ai-endpoint__meta">
        <p class="muted">换服务或地址时，Key 要重新填。已保存的 Key 不会再显示出来。</p>
        <label class="ai-endpoint__vision">
          <input type="checkbox" name={`${role}_vision`} value="1" checked={draft ? draft[`${role}_vision`] === '1' : item.vision} />
          <span>这个模型能看图片<small>会把你上传的照片和页面预览截图发给它</small></span>
        </label>
      </div>
    </fieldset>
  );
};

/** 只回显非敏感设置；URL 中误填的凭证也不带回 HTML。 */
function settingsDraft(fields: FormFields): FormFields {
  const draft: FormFields = {};
  for (const role of ['interview', 'generate']) {
    for (const field of ['provider', 'baseUrl', 'model', 'vision']) {
      let value = fields[`${role}_${field}`] ?? '';
      if (field === 'baseUrl' && value) {
        try {
          const url = new URL(value);
          if (url.username || url.password) { url.username = ''; url.password = ''; value = url.toString(); }
        } catch { if (value.includes('@')) value = ''; }
      }
      for (const key of [fields.interview_apiKey, fields.generate_apiKey]) {
        if (key?.trim()) value = value.replaceAll(key.trim(), '');
      }
      draft[`${role}_${field}`] = value;
    }
  }
  draft.shared = fields.shared ?? '';
  return draft;
}

export function registerAiSettingsRoutes(app: AppHono, deps: AppDeps): void {
  if (deps.demo) return;
  const user = requireUser(deps);
  const form = requireForm(deps);
  const render = (c: Parameters<typeof authOf>[0], error?: string, status = 200, draft?: FormFields) => {
    const auth = authOf(c);
    const interview = deps.userModels.summary(auth.user.id, 'interview');
    const generate = deps.userModels.summary(auth.user.id, 'generate');
    return renderPage(c, {
      title: 'AI 设置',
      bodyClass: 'page--ai',
      status,
      body: (
        <div class="container ai-settings">
          <header class="ai-settings__header">
            <div>
              <p class="eyebrow">账号设置 · AI 服务</p>
              <h1>使用自己的 AI 服务</h1>
              <p>连接你信任的模型服务，在网页里完成采访、生成和修改。</p>
            </div>
            <a class="btn btn--ghost btn--small ai-settings__back" href="/">返回我的墙</a>
          </header>
          <div class="ai-settings__layout">
            <div class="ai-settings__main">
              {deps.platformModel.available ? (
                <Notice tone="info">
                  不填自己的 Key 也可以用 NOWMe 的 AI。采访不收点数，生成与修改页面的费用见<a href="/account/credits">点数说明</a>。
                </Notice>
              ) : deps.userModels.available ? (
                <Notice tone="info">
                  NOWMe 的 AI 暂未开放。在网页里采访、生成或修改页面，需要先填写自己的 API Key。你也可以用自己电脑上的 AI 助手做页面。
                </Notice>
              ) : null}
              {!deps.userModels.available ? <Notice tone="error">这里暂时不能保存 API Key（服务器还没有开启加密保存）。你仍然可以在自己电脑上用 AI 助手做页面。</Notice> : null}
              {error ? <Notice tone="error">{error}</Notice> : null}
              {c.req.query('saved') === '1' ? <Notice tone="success">已保存。保存时不会调用模型，回到你的页面继续做就行。</Notice> : null}
              {c.req.query('deleted') === '1' ? <Notice tone="success">已删除你的 AI 设置和 Key。排队中和正在做的任务不会再发出新请求（已经发出的那一次可能仍会完成并计费）。你的页面和资料都还在。</Notice> : null}
              <form method="post" action="/account/ai" class="ai-settings-form" data-ai-settings="1">
                <CsrfField token={auth.session.csrfToken} />
                <div class="ai-settings-form__head">
                  <div>
                    <p class="eyebrow">模型连接</p>
                    <h2>配置你的模型</h2>
                  </div>
                  <span class="ai-settings-form__privacy">仅你能管理</span>
                </div>
                <div class="ai-settings-form__body">
                  <EndpointFields role="interview" value={interview} draft={draft} />
                  <label class="ai-settings-shared">
                    <input type="checkbox" name="shared" value="1" checked={draft ? draft.shared === '1' : !generate} />
                    <span>
                      <strong>做页面时沿用采访配置</strong>
                      <small>想分开设置？取消勾选，在下面单独填写。</small>
                    </span>
                  </label>
                  <EndpointFields role="generate" value={generate} draft={draft} />
                </div>
                <div class="ai-settings-form__footer">
                  <p class="muted">做页面的模型需要支持工具调用。自定义服务的地址必须是公网 HTTPS。</p>
                  <button class="btn btn--primary" type="submit" disabled={!deps.userModels.available}>保存 AI 配置</button>
                </div>
              </form>
              {interview || generate ? (
                <div class="ai-settings__danger">
                  <div>
                    <strong>不再需要这套配置？</strong>
                    <p>删除 Key 不会影响你的页面和资料。</p>
                  </div>
                  <PostButton action="/account/ai/delete" csrf={auth.session.csrfToken} label="删除 AI 配置与 Key" variant="danger" confirm="删除后，排队中的任务不会再发出请求；你的页面和资料都保留。确定删除吗？" />
                </div>
              ) : null}
            </div>
            <aside class="ai-settings__aside" aria-label="AI 服务说明">
              <section class="ai-settings-note ai-settings-note--key">
                <span class="ai-settings-note__badge">仅你可见</span>
                <h2>你的 Key，<br />由你掌控</h2>
                <p>Key 会加密保存在你的账号里，换设备登录也能用。只有你能管理，保存后不会再显示。</p>
                <ul class="ai-settings-benefits">
                  <li>
                    <span aria-hidden="true">01</span>
                    <div><strong>不扣 NOWMe 点数</strong><p>采访、做页面和改页面，都由你选的服务商直接计费。</p></div>
                  </li>
                  <li>
                    <span aria-hidden="true">02</span>
                    <div><strong>跨设备也能使用</strong><p>配置跟随账号，不必在每台设备上重新填写。</p></div>
                  </li>
                  <li>
                    <span aria-hidden="true">03</span>
                    <div><strong>随时修改或删除</strong><p>更换配置后，旧任务不会再发起新的模型请求。</p></div>
                  </li>
                </ul>
              </section>
              <section class="ai-settings-note ai-settings-note--checklist">
                <h2>配置前，留意这些</h2>
                <ul>
                  <li>生成模型需要支持工具调用</li>
                  <li>自定义服务必须使用公网 HTTPS</li>
                  <li>失败的请求也可能由服务商计费</li>
                </ul>
                <p>保存配置时不会调用模型。</p>
              </section>
            </aside>
          </div>
        </div>
      ),
    });
  };
  app.get('/account/ai', user, (c) => render(c));
  app.post('/account/ai', form, (c) => {
    const fields = c.get('form');
    const read = (role: ModelRole) => ({ provider: fields[`${role}_provider`] ?? '', baseUrl: fields[`${role}_baseUrl`] ?? '', model: fields[`${role}_model`] ?? '', apiKey: fields[`${role}_apiKey`] ?? '', vision: fields[`${role}_vision`] === '1' });
    try { deps.userModels.save(authOf(c).user.id, { interview: read('interview'), generate: read('generate') }, fields.shared === '1'); }
    catch { return render(c, '没能保存。请检查：服务和模型名称选对了吗、Key 填了吗、地址是不是公网 HTTPS。换了服务或地址的话，Key 也要重新填。本次填写的 Key 不会回显，请重新输入。', 422, settingsDraft(fields)); }
    return c.redirect('/account/ai?saved=1', 303);
  });
  app.post('/account/ai/delete', form, (c) => {
    deps.userModels.delete(authOf(c).user.id);
    return c.redirect('/account/ai?deleted=1', 303);
  });
}
