/**
 * 检查报告（W19）：给人看的部分说人话（问题与怎么改），错误码、文件与行号收进“技术细节”。
 * 本地 AI 助手做的版本，提示把问题交给它；在 NOWMe 上做的版本，提示再生成或修改一次。
 */
import type { FC } from 'hono/jsx';
import type { ValidationIssue, ValidationReport } from '@nowme/contracts';

const IssueItem: FC<{ issue: ValidationIssue }> = ({ issue }) => (
  <li class={`issue issue--${issue.severity}`}>
    <p class="issue__message">{issue.message}</p>
    {issue.hint ? <p class="issue__hint">怎么改：{issue.hint}</p> : null}
    <details class="issue__tech">
      <summary>技术细节</summary>
      <p class="issue__head">
        <code class="issue__code">{issue.code}</code>
        <span class="issue__where">
          {issue.file}
          {issue.line ? `:${issue.line}` : ''}
        </span>
      </p>
    </details>
  </li>
);

export const ReportView: FC<{ report: ValidationReport; source?: 'local-agent' | 'hosted' | 'owner-edit' }> = ({ report, source = 'local-agent' }) => (
  <div class="report">
    {report.errors.length > 0 ? (
      <>
        <h4 class="report__title">要改的地方（{report.errors.length}）</h4>
        <ul class="report__list">
          {report.errors.map((issue) => (
            <IssueItem issue={issue} />
          ))}
        </ul>
      </>
    ) : null}
    {report.warnings.length > 0 ? (
      <>
        <h4 class="report__title">小提醒（{report.warnings.length}）</h4>
        <ul class="report__list">
          {report.warnings.map((issue) => (
            <IssueItem issue={issue} />
          ))}
        </ul>
      </>
    ) : null}
    {report.errors.length === 0 && report.warnings.length === 0 ? <p class="muted">没有发现问题。</p> : null}
    {report.errors.length > 0 ? (
      <p class="report__fix muted">
        {source === 'owner-edit'
          ? '改过的文字让页面没有通过检查，这次没有保存；已有的版本不受影响。'
          : source === 'hosted'
          ? '可以再生成一次，或者用一句话告诉 AI 怎么改；已有的版本不受影响。'
          : '把上面的问题交给你电脑上的 AI 助手，让它改好再交回一版（它会自己运行 nowme validate 检查）；已有的版本不受影响。'}
      </p>
    ) : null}
  </div>
);
