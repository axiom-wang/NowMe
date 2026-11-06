/**
 * 创作工作区（`GET /w/:wallId/me`）：Agent 指令、本地 Agent 连接状态、版本预览、版本列表与校验报告。
 * 每一块是一个组件；T3.2 在 `PublishSlot` 的位置加入发布确认（缩略卡、联系方式、公开范围）、撤下、
 * 恢复旧版本、公开链接、删除。
 */
import type { FC } from 'hono/jsx';
import { formatDateTime } from '../format.js';
import type { RevisionListItem } from '../db/revisions.js';
import type { WorkspaceModel, WorkspaceNotice } from '../services/workspace.js';
import { Notice, PostButton } from './forms.js';
import { PageFrame } from './page-frame.js';
import { ReportView } from './report.js';

const NOTICE_TEXT: Record<WorkspaceNotice, { tone: 'success' | 'warning'; text: string }> = {
  disconnected: { tone: 'success', text: '已断开本地 Agent：旧的页面凭证与未使用的指令都已失效。需要时重新生成指令即可。' },
  'not-previewable': { tone: 'warning', text: '这个版本没有通过校验，不能预览。展开下面的报告看看哪里需要修改。' },
};

const SOURCE_LABEL: Record<RevisionListItem['source'], string> = {
  'local-agent': '本地 Agent',
};

function basePath(model: WorkspaceModel): string {
  return `/w/${model.wall.id}/me`;
}

const InstructionBlock: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const instruction = model.instruction;
  if (!instruction) return null;
  return (
    <div class="instruction" id="instruction">
      <h3>Agent 指令</h3>
      <p>复制下面这一行，发给支持 NOWMe Skill 的 Agent（例如在 Claude Code 里粘贴）：</p>
      <pre class="code" id="nm-instruction-command">{instruction.command}</pre>
      <p>
        <button type="button" class="btn btn--primary" data-copy="nm-instruction-command">
          复制指令
        </button>
      </p>
      <details class="instruction__plain">
        <summary>Agent 不支持 Skill？复制这段纯文本说明</summary>
        <pre class="code code--wrap" id="nm-instruction-text">{instruction.plainText}</pre>
        <p>
          <button type="button" class="btn btn--ghost" data-copy="nm-instruction-text">
            复制说明
          </button>
        </p>
      </details>
      <p class="muted">
        这条指令只能使用一次，{formatDateTime(instruction.expiresAt)} 前有效。离开这个页面后就看不到了；
        需要时可以重新生成（旧的未使用指令会作废）。指令里的 token 等同于钥匙，不要发到群里。
      </p>
    </div>
  );
};

const ConnectionSection: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const { connection } = model;
  const action = basePath(model);
  return (
    <section class="card" aria-labelledby="agent-heading">
      <h2 id="agent-heading">本地 Agent</h2>
      <dl class="facts">
        <div>
          <dt>连接状态</dt>
          <dd>
            {connection.connected ? (
              <span class="badge badge--ok">已连接</span>
            ) : (
              <span class="badge badge--muted">未连接</span>
            )}
            {connection.connected && connection.connectedAt ? (
              <span class="muted">（{formatDateTime(connection.connectedAt)} 连接）</span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>最近一次提交</dt>
          <dd>{model.lastSubmittedAt ? formatDateTime(model.lastSubmittedAt) : <span class="muted">还没有提交</span>}</dd>
        </div>
        {connection.pendingInstructionExpiresAt ? (
          <div>
            <dt>待使用的指令</dt>
            <dd class="muted">有一条还没用过的指令，{formatDateTime(connection.pendingInstructionExpiresAt)} 前有效</dd>
          </div>
        ) : null}
      </dl>
      <InstructionBlock model={model} />
      <p class="muted">
        你的 Agent 只能拉取这面墙的情境、提交新版本；<strong>发布需要你本人在这里确认</strong>，Agent 不能替你发布。
      </p>
      <div class="actions">
        <PostButton
          action={`${action}/instruction`}
          csrf={model.csrf}
          label={model.instruction || connection.pendingInstructionExpiresAt || connection.connected ? '重新生成指令' : '生成 Agent 指令'}
          variant={model.instruction ? 'ghost' : 'primary'}
          confirm={
            connection.pendingInstructionExpiresAt
              ? '重新生成后，之前那条还没用过的指令会作废。继续吗？'
              : undefined
          }
        />
        {connection.connected || connection.pendingInstructionExpiresAt ? (
          <PostButton
            action={`${action}/disconnect`}
            csrf={model.csrf}
            label="断开本地 Agent"
            variant="danger"
            confirm="断开后，本地 Agent 的页面凭证立即失效，不能再提交新版本（已有版本不受影响）。继续吗？"
          />
        ) : null}
      </div>
    </section>
  );
};

const PreviewSection: FC<{ model: WorkspaceModel; ownerName: string }> = ({ model, ownerName }) => {
  if (!model.selected || !model.ticket) {
    return (
      <section class="card" aria-labelledby="preview-heading">
        <h2 id="preview-heading">预览</h2>
        <p class="muted">还没有通过校验的版本。生成指令交给你的 Agent，提交通过后就能在这里看到页面。</p>
      </section>
    );
  }
  return (
    <section class="card" aria-labelledby="preview-heading">
      <h2 id="preview-heading">预览：第 {model.selected.number} 版</h2>
      <PageFrame ticket={model.ticket} title={`${ownerName}的页面（第 ${model.selected.number} 版）`} />
      <PublishSlot model={model} />
    </section>
  );
};

/** T3.2：发布确认（缩略卡、联系方式、公开范围）放在这里。 */
const PublishSlot: FC<{ model: WorkspaceModel }> = () => (
  <p class="muted publish-slot">发布到墙需要你确认缩略卡与联系方式（发布功能即将开放）。没有发布之前，墙上的其他人看不到这一页。</p>
);

const RevisionItem: FC<{ model: WorkspaceModel; revision: RevisionListItem; latest: boolean }> = ({ model, revision, latest }) => {
  const accepted = revision.status === 'accepted';
  const selected = model.selected?.id === revision.id;
  const issues = revision.report.errors.length + revision.report.warnings.length;
  return (
    <li class={`revision revision--${revision.status}${selected ? ' revision--selected' : ''}`} id={`rev-${revision.number}`}>
      <div class="revision__head">
        <strong class="revision__number">第 {revision.number} 版</strong>
        <span class={`badge ${accepted ? 'badge--ok' : 'badge--bad'}`}>{accepted ? '通过' : '不通过'}</span>
        <span class="muted revision__meta">
          {SOURCE_LABEL[revision.source] ?? revision.source} · {formatDateTime(revision.createdAt)}
        </span>
        {accepted ? (
          selected ? (
            <span class="revision__current">正在预览</span>
          ) : (
            <a class="revision__preview" href={`${basePath(model)}?rev=${revision.id}#preview-heading`}>
              预览
            </a>
          )
        ) : null}
      </div>
      {!accepted ? (
        <details class="revision__report" open={latest}>
          <summary>为什么没通过（{revision.report.errors.length} 个问题必须修复）</summary>
          <ReportView report={revision.report} />
        </details>
      ) : issues > 0 ? (
        <details class="revision__report">
          <summary>{revision.report.warnings.length} 条提醒</summary>
          <ReportView report={revision.report} />
        </details>
      ) : null}
    </li>
  );
};

const RevisionsSection: FC<{ model: WorkspaceModel }> = ({ model }) => (
  <section class="card" aria-labelledby="revisions-heading">
    <h2 id="revisions-heading">版本</h2>
    {model.revisions.length === 0 ? (
      <p class="muted">还没有版本。每次 nowme submit 都会在这里新增一个版本，没通过校验的版本不会影响已有的版本。</p>
    ) : (
      <ol class="revisions">
        {model.revisions.map((revision, index) => (
          <RevisionItem model={model} revision={revision} latest={index === 0} />
        ))}
      </ol>
    )}
  </section>
);

export const WorkspaceView: FC<{ model: WorkspaceModel; ownerName: string }> = ({ model, ownerName }) => (
  <>
    <section class="page-intro">
      <p class="muted">
        <a href="/">我的</a> / {model.wall.name}
      </p>
      <h1>我的页面 · 创作工作区</h1>
    </section>
    {model.notice ? <Notice tone={NOTICE_TEXT[model.notice].tone}>{NOTICE_TEXT[model.notice].text}</Notice> : null}
    {model.instruction || model.revisions.length === 0 ? (
      <>
        <ConnectionSection model={model} />
        <PreviewSection model={model} ownerName={ownerName} />
      </>
    ) : (
      <>
        <PreviewSection model={model} ownerName={ownerName} />
        <ConnectionSection model={model} />
      </>
    )}
    <RevisionsSection model={model} />
  </>
);
