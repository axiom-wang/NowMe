/**
 * 建墙（W02，`GET /walls/new`、`POST /walls`）：名称、简介、点选场景类型、可选的“组织者的话”。
 * 不配置模板、字段或风格；三分钟内能完成。
 */
import type { FC } from 'hono/jsx';
import type { SceneType } from '@nowme/contracts';
import { WALL_TEXT_LIMITS } from '../constants.js';
import type { WallFormErrors, WallFormValues } from '../services/walls.js';
import { CsrfField, Notice } from './forms.js';

export interface SceneChoice {
  type: SceneType;
  label: string;
}

export interface NewWallViewProps {
  csrf: string;
  scenes: SceneChoice[];
  values?: WallFormValues;
  errors?: WallFormErrors;
}

const FieldError: FC<{ id: string; message?: string }> = ({ id, message }) =>
  message ? (
    <span class="field__error" id={id}>
      {message}
    </span>
  ) : null;

export const NewWallView: FC<NewWallViewProps> = ({ csrf, scenes, values, errors = {} }) => {
  const hasErrors = Object.keys(errors).length > 0;
  return (
    <div class="container container--form">
    <section class="card card--form">
      <p class="eyebrow">组织者 · 三分钟</p>
      <h1 class="display form-title">建一面墙</h1>
      <p class="muted">起个名字，写句简介，选一种场景，就能拿到邀请链接和二维码，发给圈子里的人。不用设置别的。</p>
      {hasErrors ? <Notice tone="error">有几项需要改一下，已经在对应的位置标出来了。</Notice> : null}
      <form method="post" action="/walls" class="stack">
        <CsrfField token={csrf} />
        <label class="field">
          <span class="field__label">墙的名称</span>
          <input
            type="text"
            name="name"
            value={values?.name ?? ''}
            required
            maxlength={WALL_TEXT_LIMITS.name.max}
            placeholder="例如：2026 秋季校园黑客松"
            aria-invalid={errors.name ? 'true' : undefined}
            aria-describedby={errors.name ? 'name-error' : undefined}
          />
          <FieldError id="name-error" message={errors.name} />
        </label>
        <label class="field">
          <span class="field__label">简介</span>
          <textarea
            name="description"
            rows={3}
            maxlength={WALL_TEXT_LIMITS.description.max}
            placeholder="一两句话：这是什么圈子、什么时候、大家来做什么"
            aria-invalid={errors.description ? 'true' : undefined}
            aria-describedby={errors.description ? 'description-error' : undefined}
          >
            {values?.description ?? ''}
          </textarea>
          <FieldError id="description-error" message={errors.description} />
        </label>
        <fieldset class="field scene-picker" aria-describedby={errors.sceneType ? 'scene-error' : undefined}>
          <legend class="field__label">场景类型</legend>
          <p class="field__hint muted">会影响 AI 帮大家做页面时问什么、突出什么：比如黑客松更看重能力和项目，兴趣社群更看重爱好。</p>
          <div class="scene-picker__options">
            {scenes.map((scene) => (
              <label class={`scene-option scene--${scene.type}`}>
                <input type="radio" name="sceneType" value={scene.type} required checked={values?.sceneType === scene.type} />
                <span class="scene-option__swatch" aria-hidden="true"></span>
                <span class="scene-option__label">{scene.label}</span>
              </label>
            ))}
          </div>
          <FieldError id="scene-error" message={errors.sceneType} />
        </fieldset>
        <label class="field">
          <span class="field__label">
            组织者的话 <span class="muted">（可选）</span>
          </span>
          <input
            type="text"
            name="organizerNote"
            value={values?.organizerNote ?? ''}
            maxlength={WALL_TEXT_LIMITS.organizerNote.max}
            placeholder="例如：希望大家写清楚想找什么样的队友"
            aria-invalid={errors.organizerNote ? 'true' : undefined}
            aria-describedby={errors.organizerNote ? 'note-error' : undefined}
          />
          <span class="field__hint muted">会放在墙的顶部，成员的 AI 帮他们做页面时也会参考。</span>
          <FieldError id="note-error" message={errors.organizerNote} />
        </label>
        <button type="submit" class="btn btn--primary btn--block btn--lg">
          建好了，去拿邀请链接
        </button>
      </form>
    </section>
    </div>
  );
};
