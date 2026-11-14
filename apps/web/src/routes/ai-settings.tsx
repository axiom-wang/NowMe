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
    <p class="muted">更换服务或地址时请重新填写 Key。平台不会显示已保存的完整 Key。</p>
    <label><input type="checkbox" name={`${role}_vision`} value="1" checked={item.vision} /> 该模型支持图片，可将上传照片和预览截图发送给它</label>
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
      <p>采访、生成和修改由平台服务器使用你的 API Key 请求你选择的模型服务，模型费用由该服务商向你收取。失败的请求也可能产生费用。</p>
      <p class="muted">Key 加密保存在你的账号下，其他设备登录后可继续使用；只有你能管理。{deps.platformModel.available ? '用自己的 Key 时，平台不会替你支付模型费用。' : '平台不提供公共 Key，也不会替你支付模型费用。'}</p>
      {!deps.userModels.available ? <Notice tone="error">平台尚未配置凭证加密功能，暂时无法保存或使用 API Key。请联系维护者；你仍可使用本地 Agent 创作。</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {c.req.query('saved') === '1' ? <Notice tone="info">配置已保存。你可以返回创作工作区继续；保存配置不会调用模型。</Notice> : null}
      {c.req.query('deleted') === '1' ? <Notice tone="info">AI 配置与加密 Key 已删除。排队及进行中的任务将停止后续模型请求；已发送的请求可能仍会完成或计费。已有页面和资料保留。</Notice> : null}
      <form method="post" action="/account/ai" class="stack" data-ai-settings="1">
        <CsrfField token={auth.session.csrfToken} />
        <EndpointFields role="interview" value={interview} />
        <label><input type="checkbox" name="shared" value="1" checked={!generate} /> 生成沿用采访的服务、地址、Key 和图片能力（仍可单独填写下方生成模型）</label>
        <EndpointFields role="generate" value={generate} />
        <p class="muted">需要支持工具调用的模型。自定义服务须使用公网 HTTPS 地址。开发模式允许的本机地址指向平台服务器所在电脑，并非访问者自己的电脑。</p>
        <button class="btn btn--primary" type="submit" disabled={!deps.userModels.available}>保存 AI 配置</button>
      </form>
      {interview || generate ? <PostButton action="/account/ai/delete" csrf={auth.session.csrfToken} label="删除 AI 配置与 Key" confirm="删除后将停止后续模型请求，已有资料和页面保留。继续吗？" /> : null}
      <a href="/">返回我的墙</a>
    </div> });
  };
  app.get('/account/ai', user, (c) => render(c));
  app.post('/account/ai', form, (c) => {
    const fields = c.get('form');
    const read = (role: ModelRole) => ({ provider: fields[`${role}_provider`] ?? '', baseUrl: fields[`${role}_baseUrl`] ?? '', model: fields[`${role}_model`] ?? '', apiKey: fields[`${role}_apiKey`] ?? '', vision: fields[`${role}_vision`] === '1' });
    try { deps.userModels.save(authOf(c).user.id, { interview: read('interview'), generate: read('generate') }, fields.shared === '1'); }
    catch { return render(c, '保存失败：请检查服务、模型、Key 与公网 HTTPS 地址；更换服务或地址需要重新填写 Key。', 422); }
    return c.redirect('/account/ai?saved=1', 303);
  });
  app.post('/account/ai/delete', form, (c) => {
    deps.userModels.delete(authOf(c).user.id);
    return c.redirect('/account/ai?deleted=1', 303);
  });
}
