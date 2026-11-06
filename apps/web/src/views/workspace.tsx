/**
 * 创作工作区（`GET /w/:wallId/me`）：墙上的页面（发布状态、公开链接）、Agent 指令、本地 Agent 连接状态、
 * 版本预览与发布确认、版本列表与校验报告、删除与退出入口。
 * 每一块是一个组件；发布相关的组件在 views/publish.tsx（T3.2）。
 */
import type { FC } from 'hono/jsx';
import { formatDateTime } from '../format.js';
import type { RevisionListItem } from '../db/revisions.js';
import { isRevisionDeleted, isRevisionUsable } from '../services/page-lifecycle.js';
import type { WorkspaceModel, WorkspaceNotice } from '../services/workspace.js';
import { Notice, PostButton } from './forms.js';
import { PageFrame } from './page-frame.js';
import { MoreActionsSection, PublishForm, WallStatusSection } from './publish.js';
import { ReportView } from './report.js';

const NOTICE_TEXT: Record<WorkspaceNotice, { tone: 'success' | 'warning' | 'error'; text: string; link?: { href: string; label: string } }> = {
  disconnected: { tone: 'success', text: '已断开本地 Agent：旧的页面凭证与未使用的指令都已失效。需要时重新生成指令即可。' },
  'not-previewable': { tone: 'warning', text: '这个版本没有通过校验，不能预览。展开下面的报告看看哪里需要修改。' },
  'deleted-revision': { tone: 'warning', text: '这个版本已随页面删除，不能预览或发布。请让 Agent 提交新版本。' },
  published: { tone: 'success', text: '已发布：墙上的成员现在看到的是这一版，以及你刚确认的缩略卡与联系方式。' },
  withdrawn: { tone: 'success', text: '已从墙上撤下：墙上的成员看不到你的页面了。版本都还在，随时可以重新发布。' },
  'not-published': { tone: 'warning', text: '现在墙上没有你的页面，不需要撤下。' },
  'public-link-on': {
    tone: 'success',
    text: '公开链接已开启（每次开启都会生成新链接）。把它发给墙外的人，他们不用登录就能看到你的页面，但看不到联系方式与接话点。',
    link: { href: '#public-link', label: '查看链接' },
  },
  'public-link-off': { tone: 'success', text: '公开链接已关闭，旧链接立即失效。' },
  deleted: {
    tone: 'success',
    text: '这一页已删除：所有版本的文件、发布记录里的缩略卡与联系方式都已清除，公开链接已关闭，本地 Agent 已断开。想重新开始，生成新的 Agent 指令即可。',
  },
  'publish-rejected': {
    tone: 'error',
    text: '发布没有完成：这个版本没有通过校验，不能发布。展开版本列表里的报告修好问题，让 Agent 重新提交后再发布。墙上的页面没有变化。',
  },
  'publish-deleted': { tone: 'error', text: '发布没有完成：这个版本已随页面删除，不能发布。请让 Agent 提交新版本。墙上的页面没有变化。' },
  'publish-failed': { tone: 'error', text: '发布没有完成：这个版本刚刚已不可用。请刷新工作区后重新选择版本。墙上的页面没有变化。' },
  'publish-errors': {
    tone: 'error',
    text: '发布没有完成：发布确认里还有需要修改的地方。墙上的页面没有变化。',
    link: { href: '#publish', label: '去修改' },
  },
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
    const hasUsable = model.revisions.some(isRevisionUsable);
    return (
      <section class="card" aria-labelledby="preview-heading">
        <h2 id="preview-heading">预览</h2>
        <p class="muted">
          {hasUsable
            ? '在下面的版本列表里选一个通过校验的版本预览。'
            : '还没有通过校验的版本。生成指令交给你的 Agent，提交通过后就能在这里看到页面。'}
        </p>
      </section>
    );
  }
  return (
    <section class="card" aria-labelledby="preview-heading">
      <h2 id="preview-heading">预览：第 {model.selected.number} 版</h2>
      <PageFrame ticket={model.ticket} title={`${ownerName}的页面（第 ${model.selected.number} 版）`} />
      <PublishForm model={model} />
    </section>
  );
};

/** 版本列表里给“其他通过的版本”的发布入口文字（进入同一个发布确认流程，W10）。 */
function publishLinkLabel(model: WorkspaceModel, revision: RevisionListItem): string | null {
  const active = model.publish.active;
  if (active?.publication.revisionId === revision.id) return null;
  if (active?.revisionNumber != null) return revision.number < active.revisionNumber ? '恢复为此版本' : '用这一版更新';
  return '发布这一版';
}

const DeletedRevisionItem: FC<{ revision: RevisionListItem }> = ({ revision }) => (
  <li class="revision revision--deleted" id={`rev-${revision.number}`}>
    <div class="revision__head">
      <strong class="revision__number">第 {revision.number} 版</strong>
      <span class="badge">已删除</span>
      <span class="muted revision__meta">{formatDateTime(revision.createdAt)} 提交，内容已随页面删除</span>
    </div>
  </li>
);

const RevisionItem: FC<{ model: WorkspaceModel; revision: RevisionListItem; latest: boolean }> = ({ model, revision, latest }) => {
  if (isRevisionDeleted(revision)) return <DeletedRevisionItem revision={revision} />;
  const accepted = revision.status === 'accepted';
  const selected = model.selected?.id === revision.id;
  const live = model.publish.active?.publication.revisionId === revision.id;
  const publishLabel = accepted ? publishLinkLabel(model, revision) : null;
  const issues = revision.report.errors.length + revision.report.warnings.length;
  return (
    <li class={`revision revision--${revision.status}${selected ? ' revision--selected' : ''}`} id={`rev-${revision.number}`}>
      <div class="revision__head">
        <strong class="revision__number">第 {revision.number} 版</strong>
        <span class={`badge ${accepted ? 'badge--ok' : 'badge--bad'}`}>{accepted ? '通过' : '不通过'}</span>
        {live ? <span class="badge badge--live">墙上展示中</span> : null}
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
        {publishLabel && !selected ? (
          <a class="revision__publish" href={`${basePath(model)}?rev=${revision.id}#publish`}>
            {publishLabel}
          </a>
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

const WorkspaceNoticeView: FC<{ notice: WorkspaceNotice }> = ({ notice }) => {
  const entry = NOTICE_TEXT[notice];
  return (
    <Notice tone={entry.tone}>
      {entry.text}
      {entry.link ? (
        <>
          {' '}
          <a href={entry.link.href}>{entry.link.label}</a>
        </>
      ) : null}
    </Notice>
  );
};

export const WorkspaceView: FC<{ model: WorkspaceModel; ownerName: string }> = ({ model, ownerName }) => (
  <>
    <section class="page-intro">
      <p class="muted">
        <a href="/">我的</a> / {model.wall.name}
      </p>
      <h1>我的页面 · 创作工作区</h1>
    </section>
    {model.notice ? <WorkspaceNoticeView notice={model.notice} /> : null}
    {model.revisions.length > 0 || model.publish.state !== 'unpublished' || model.publish.publicLinkUrl ? (
      <WallStatusSection model={model} />
    ) : null}
    {model.instruction || model.revisions.every(isRevisionDeleted) ? (
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
    <MoreActionsSection model={model} />
  </>
);
