/** 账号 AI 设置：当前登录用户自己的加密凭证，会话 + Origin + CSRF。 */
import { defaultModelEndpoint, MODEL_PROVIDERS, MODEL_PROVIDER_PRESETS } from '@nowme/contracts';
import type { FC } from 'hono/jsx';
import type { AppDeps, AppHono } from '../context.js';
import { authOf, requireUser } from '../security/session.js';
import { requireForm } from '../security/forms.js';
import type { ModelRole, UserModelSummary } from '../hosted/user-models.js';
import { CsrfField, Notice, PostButton } from '../views/forms.js';
import { renderPage } from '../views/layout.js';

const EndpointFields: FC<{ role: ModelRole; value: UserModelSummary | null }> = ({ role, value }) => {
  const item = value?.endpoint ?? defaultModelEndpoint();
  return <fieldset class="card stack">
    <legend>{role === 'interview' ? '采访与整理资料' : '生成与修改页面'}</legend>
    <label class="field" for={`${role}-provider`}>模型服务
      <select id={`${role}-provider`} name={`${role}_provider`} data-model-provider={role}>
        {MODEL_PROVIDERS.map((provider) => <option value={provider} data-base-url={MODEL_PROVIDER_PRESETS[provider].baseUrl ?? ''} data-model={(role === 'interview' ? MODEL_PROVIDER_PRESETS[provider].interviewModel : MODEL_PROVIDER_PRESETS[provider].generateModel) ?? ''} data-vision={MODEL_PROVIDER_PRESETS[provider].vision ? '1' : '0'} selected={item.provider === provider}>{MODEL_PROVIDER_PRESETS[provider].label}</option>)}
      </select>
    </label>
    <label class="field" for={`${role}-url`}>API Base URL
      <input id={`${role}-url`} type="url" name={`${role}_baseUrl`} value={value?.endpoint.baseUrl ?? ''} placeholder="留空使用所选服务的预设地址" maxlength={2048} />
    </label>
    <label class="field" for={`${role}-model`}>模型名称或接入点 ID
      <input id={`${role}-model`} type="text" name={`${role}_model`} value={value?.endpoint.model ?? ''} placeholder="留空使用所选服务默认模型；无默认值时必填" maxlength={200} />
    </label>
    <label class="field" for={`${role}-key`}>API Key{value?.hasKey ? '（已加密保存，留空沿用）' : ''}
      <input id={`${role}-key`} type="password" name={`${role}_apiKey`} autocomplete="new-password" maxlength={4096} spellcheck={false} />
    </label>
    <p class="muted">换服务或地址时，Key 要重新填。已保存的 Key 不会再显示出来。</p>
    <label><input type="checkbox" name={`${role}_vision`} value="1" checked={item.vision} /> 这个模型能看图片（会把你上传的照片和页面预览截图发给它）</label>
  </fieldset>;
};

export function registerAiSettingsRoutes(app: AppHono, deps: AppDeps): void {
  if (deps.demo) return;
  const user = requireUser(deps);
  const form = requireForm(deps);
  const render = (c: Parameters<typeof authOf>[0], error?: string, status = 200) => {
    const auth = authOf(c);
    const interview = deps.userModels.summary(auth.user.id, 'interview');
    const generate = deps.userModels.summary(auth.user.id, 'generate');
    return renderPage(c, { title: 'AI 设置', bodyClass: 'page--ai', status, body: <div class="container container--form stack">
      <h1>使用自己的 AI 服务</h1>
      {deps.platformModel.available ? (
        <Notice tone="info">
          不填也能用：没有自己的 Key 时，NOWMe 的 AI 会帮你做页面（生成与修改消耗<a href="/account/credits">点数</a>）。填了自己的 Key 之后，就改用你的 Key，不再消耗点数。
        </Notice>
      ) : null}
      <p>填了自己的 Key 之后，采访、做页面和改页面都会用它去请求你选的模型服务。费用由服务商直接向你收取，失败的请求也可能计费。</p>
      <p class="muted">Key 会加密保存在你的账号里，换设备登录也能用，只有你能查看和删除。{deps.platformModel.available ? '用自己的 Key 时，NOWMe 不会替你付模型费用。' : '这是可选的：用自己的 Key 不扣点数；不填的话，也可以用 NOWMe 提供的 AI（按点数计，个人点数或圈子的额度都可以）。'}</p>
      {!deps.userModels.available ? <Notice tone="error">这里暂时不能保存 API Key（服务器还没有开启加密保存）。你仍然可以在自己电脑上用 AI 助手做页面。</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {c.req.query('saved') === '1' ? <Notice tone="info">已保存。保存时不会调用模型，回到你的页面继续做就行。</Notice> : null}
      {c.req.query('deleted') === '1' ? <Notice tone="info">已删除你的 AI 设置和 Key。排队中和正在做的任务不会再发出新请求（已经发出的那一次可能仍会完成并计费）。你的页面和资料都还在。</Notice> : null}
      <form method="post" action="/account/ai" class="stack" data-ai-settings="1">
        <CsrfField token={auth.session.csrfToken} />
        <EndpointFields role="interview" value={interview} />
        <label><input type="checkbox" name="shared" value="1" checked={!generate} /> 做页面时用和采访同一套设置（想分开设置，就取消勾选，在下面单独填）</label>
        <EndpointFields role="generate" value={generate} />
        <p class="muted">做页面的模型需要支持工具调用。自定义服务的地址必须是公网 HTTPS。</p>
        <button class="btn btn--primary" type="submit" disabled={!deps.userModels.available}>保存 AI 配置</button>
      </form>
      {interview || generate ? <PostButton action="/account/ai/delete" csrf={auth.session.csrfToken} label="删除 AI 配置与 Key" confirm="删除后，排队中的任务不会再发出请求；你的页面和资料都保留。确定删除吗？" /> : null}
      <a class="link-block" href="/">返回我的墙</a>
    </div> });
  };
  app.get('/account/ai', user, (c) => render(c));
  app.post('/account/ai', form, (c) => {
    const fields = c.get('form');
    const read = (role: ModelRole) => ({ provider: fields[`${role}_provider`] ?? '', baseUrl: fields[`${role}_baseUrl`] ?? '', model: fields[`${role}_model`] ?? '', apiKey: fields[`${role}_apiKey`] ?? '', vision: fields[`${role}_vision`] === '1' });
    try { deps.userModels.save(authOf(c).user.id, { interview: read('interview'), generate: read('generate') }, fields.shared === '1'); }
    catch { return render(c, '没能保存。请检查：服务和模型名称选对了吗、Key 填了吗、地址是不是公网 HTTPS。换了服务或地址的话，Key 也要重新填。', 422); }
    return c.redirect('/account/ai?saved=1', 303);
  });
  app.post('/account/ai/delete', form, (c) => {
    deps.userModels.delete(authOf(c).user.id);
    return c.redirect('/account/ai?deleted=1', 303);
  });
}
