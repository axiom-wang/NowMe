/**
 * 直接改文字（contracts 22）：按区块列出页面上的文字，主人改完保存为新的一版。不用 AI、不扣点数。
 *
 * 文字一律经 JSX 转义按文字输出；表单只提交 `t_<序号>`（有脚本时只提交改过的段，见 app.js `form[data-only-changed]`）。
 */
import type { FC } from 'hono/jsx';
import { TEXT_EDIT_LIMITS, type ValidationReport } from '@nowme/contracts';
import type { TextSegment } from '../services/text-edit.js';
import { CsrfField, Notice } from './forms.js';
import { ReportView } from './report.js';

export type TextEditError = 'unchanged' | 'too-long' | 'unsafe' | 'rate-limited' | 'failed' | 'pending' | 'rejected' | 'content';

export const TEXT_EDIT_ERROR_TEXT: Record<Exclude<TextEditError, 'content' | 'rejected'>, string> = {
  unchanged: '你还没有改任何文字。改好以后再点保存。',
  'too-long': `有一段超过了 ${TEXT_EDIT_LIMITS.segment} 字，删短一些再保存。`,
  unsafe: '这次的改动没法安全保存，什么都没有改变。换个写法试试，或者用一句话让 AI 改。',
  'rate-limited': '这一页今天做的版本太多了，明天再来改。什么都没有改变。',
  failed: '这次没有保存成功，什么都没有改变。请稍后再试。',
  pending: '还在处理这次修改。稍等一会儿，到“做过的每一版”里就能看到新的一版。',
};

export interface TextEditModel {
  wallId: string;
  wallName: string;
  csrf: string;
  revisionId: string;
  revisionNumber: number;
  segments: TextSegment[];
  truncated: boolean;
  /** 出错时回显主人填过的文字（序号 → 文字）。 */
  values?: ReadonlyMap<number, string>;
  error?: { kind: TextEditError; message?: string; report?: ValidationReport; index?: number } | null;
}

interface Group {
  block: string | null;
  segments: TextSegment[];
}

function groupByBlock(segments: readonly TextSegment[]): Group[] {
  const groups: Group[] = [];
  for (const segment of segments) {
    const last = groups[groups.length - 1];
    if (last && last.block === segment.block) last.segments.push(segment);
    else groups.push({ block: segment.block, segments: [segment] });
  }
  return groups;
}

const SegmentField: FC<{ segment: TextSegment; value: string; invalid: boolean }> = ({ segment, value, invalid }) => {
  const label = `第 ${segment.index + 1} 段`;
  const long = segment.multiline || [...segment.text].length > 40;
  return long ? (
    <label class="field text-edit__field">
      <span class="field__label visually-hidden">{label}</span>
      <textarea name={`t_${segment.index}`} rows={Math.min(6, Math.max(2, Math.ceil([...segment.text].length / 28)))} maxlength={TEXT_EDIT_LIMITS.segment} aria-invalid={invalid ? 'true' : undefined}>
        {value}
      </textarea>
    </label>
  ) : (
    <label class="field text-edit__field">
      <span class="field__label visually-hidden">{label}</span>
      <input type="text" name={`t_${segment.index}`} value={value} maxlength={TEXT_EDIT_LIMITS.segment} aria-invalid={invalid ? 'true' : undefined} />
    </label>
  );
};

export const TextEditView: FC<{ model: TextEditModel }> = ({ model }) => {
  const workspace = `/w/${model.wallId}/me`;
  const error = model.error;
  return (
    <div class="container container--form stack text-edit" id="text-edit">
      <p class="muted">
        <a href={`${workspace}?rev=${model.revisionId}#preview-heading`}>← 回到工作区</a>
      </p>
      <h1>直接改文字（第 {model.revisionNumber} 版）</h1>
      <p>
        改完点“保存为新的一版”，几秒就好。<strong>不用 AI，不扣点数。</strong>墙上的页面不会马上变：你先看预览，满意再发布。
      </p>
      <ul class="muted text-edit__notes">
        <li>
          名字、一行介绍、接话点和开场白在<a href={`${workspace}?rev=${model.revisionId}#publish`}>发布确认</a>里改。
        </li>
        <li>这里只能改文字，不会动样式和排版。想改样子、加内容，用一句话告诉 AI。</li>
        <li>页面上有、这里却找不到的文字，是动效一点点打出来的，也请用一句话让 AI 改。</li>
      </ul>
      {error ? (
        error.kind === 'rejected' && error.report ? (
          <Notice tone="error">
            改过以后页面没有通过检查，这次没有保存：
            <ReportView report={error.report} source="owner-edit" />
          </Notice>
        ) : (
          <Notice tone={error.kind === 'pending' ? 'info' : 'error'}>
            {error.message ?? (error.kind in TEXT_EDIT_ERROR_TEXT ? TEXT_EDIT_ERROR_TEXT[error.kind as keyof typeof TEXT_EDIT_ERROR_TEXT] : TEXT_EDIT_ERROR_TEXT.failed)}
          </Notice>
        )
      ) : null}
      {model.segments.length === 0 ? (
        <Notice tone="info">这一版里没有能直接改的文字（大概都是动效生成的）。回到工作区，用一句话告诉 AI 怎么改。</Notice>
      ) : (
        <div data-busy-scope>
        <form method="post" action={`${workspace}/text`} class="stack" data-only-changed data-busy-label="正在保存新的一版…">
          <CsrfField token={model.csrf} />
          <input type="hidden" name="revisionId" value={model.revisionId} />
            {groupByBlock(model.segments).map((group) => (
              <fieldset class="card stack text-edit__block">
                <legend class="text-edit__legend">{group.block ? `区块 ${group.block}` : '其他'}</legend>
                {group.segments.map((segment) => (
                  <SegmentField segment={segment} value={model.values?.get(segment.index) ?? segment.text} invalid={error?.index === segment.index} />
                ))}
              </fieldset>
            ))}
            {model.truncated ? <p class="muted">这一页的文字很多，这里只列出了前 {TEXT_EDIT_LIMITS.segments} 段；后面的请用一句话让 AI 改。</p> : null}
            <p class="muted" data-busy-status hidden></p>
            <div class="actions">
              <button type="submit" class="btn btn--primary btn--lg">
                保存为新的一版
              </button>
              <a class="btn btn--ghost" href={`${workspace}?rev=${model.revisionId}#preview-heading`}>
                不改了
              </a>
            </div>
        </form>
        </div>
      )}
    </div>
  );
};
