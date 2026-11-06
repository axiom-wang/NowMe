/** 校验报告（W19）：每个问题给出位置、中文原因与修复指引。 */
import type { FC } from 'hono/jsx';
import type { ValidationIssue, ValidationReport } from '@nowme/contracts';

const IssueItem: FC<{ issue: ValidationIssue }> = ({ issue }) => (
  <li class={`issue issue--${issue.severity}`}>
    <div class="issue__head">
      <code class="issue__code">{issue.code}</code>
      <span class="issue__where">
        {issue.file}
        {issue.line ? `:${issue.line}` : ''}
      </span>
    </div>
    <p class="issue__message">{issue.message}</p>
    {issue.hint ? <p class="issue__hint">怎么改：{issue.hint}</p> : null}
  </li>
);

export const ReportView: FC<{ report: ValidationReport }> = ({ report }) => (
  <div class="report">
    {report.errors.length > 0 ? (
      <>
        <h4 class="report__title">必须修复（{report.errors.length}）</h4>
        <ul class="report__list">
          {report.errors.map((issue) => (
            <IssueItem issue={issue} />
          ))}
        </ul>
      </>
    ) : null}
    {report.warnings.length > 0 ? (
      <>
        <h4 class="report__title">提醒（{report.warnings.length}）</h4>
        <ul class="report__list">
          {report.warnings.map((issue) => (
            <IssueItem issue={issue} />
          ))}
        </ul>
      </>
    ) : null}
    {report.errors.length === 0 && report.warnings.length === 0 ? <p class="muted">没有发现问题。</p> : null}
    <p class="report__fix muted">修好之后，让你的 Agent 重新运行 nowme validate 与 nowme submit 即可，已有的版本不受影响。</p>
  </div>
);
