import { DEMO_MODEL_READY, DEMO_MODEL_MISSING, demoModelError } from '../demo-access.js';
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
import { CopyBlock } from './skill.js';
import { EditForm, JOB_START_ERROR_TEXT } from './hosted.js';

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
  hosted: '在这里创作',
};

function basePath(model: WorkspaceModel): string {
  return `/w/${model.wall.id}/me`;
}

const InstructionBlock: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const instruction = model.instruction;
  if (!instruction) return null;
  return (
    <div class="instruction" id="instruction">
      <div class="instruction__head">
        <h3>Agent 指令</h3>
        <span class="badge badge--warn">一次性</span>
      </div>
      <p>
        复制下面这一行，发给装好 NOWMe Skill 的 Agent。第一次用？先 <a href="#skill-install">安装 NOWMe Skill</a>。
      </p>
      <div class="terminal">
        <div class="terminal__bar" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </div>
        <pre class="code" id="nm-instruction-command">{instruction.command}</pre>
      </div>
      <p>
        <button type="button" class="btn btn--accent" data-copy="nm-instruction-command">
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
      <p class="muted instruction__note">
        这条指令只能使用一次，{formatDateTime(instruction.expiresAt)} 前有效。离开这个页面后就看不到了；
        需要时可以重新生成（旧的未使用指令会作废）。指令里的 token 等同于钥匙，不要发到群里。
      </p>
    </div>
  );
};

/**
 * 「安装 NOWMe Skill」（T3.6，contracts 4.5）：不管有没有指令都显示，关掉页面后再回来、已经碰到
 * “Unknown command” 的人也能看到。通用写法，不写具体 Agent。这里没有任何 token。
 * 没连接过、也没有版本时默认展开。
 */
const SkillInstallGuide: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const { skill } = model;
  const firstTime = !model.connection.connected && model.revisions.length === 0;
  return (
    <details class="skill-install" id="skill-install" open={firstTime}>
      <summary>第一次用？先给 Agent 安装 NOWMe Skill</summary>
      <div class="skill-install__body">
        <ol class="skill-install__steps">
          <li>
            <strong>让 Agent 自己安装（推荐）</strong>：把这句话发给你的 Agent，它会按说明下载、核对并安装到自己的 Skill 目录。
            <CopyBlock id="nm-skill-install" text={skill.installPrompt} label="复制这句话" />
            想自己下载、或者从 Skill 市场安装，看 <a href={skill.installPageUrl}>安装页</a>。
          </li>
          <li>
            装好后<strong>退出并重新打开一个会话</strong>（多数 Agent 只在会话开始时加载 Skill），再把 Agent 指令粘贴给它。
          </li>
          <li>
            <strong>确认装好了</strong>：在新会话里发这句话，回复里有{' '}
            {skill.checkExpected ? <code>{skill.checkExpected}</code> : 'NOWMe Skill 的版本号'} 就说明装好了。
            <CopyBlock id="nm-skill-check" text={skill.checkPrompt} label="复制这句话" />
          </li>
        </ol>
        <p>
          <strong>Agent 不支持 Skill，或者不想安装？</strong>生成指令后，展开指令下方的「Agent 不支持 Skill？复制这段纯文本说明」，把整段发给 Agent 即可，不需要安装。
        </p>
        <p>
          <strong>
            Agent 回复 <code>Unknown command: /nowme-page</code>，或者说不认识这个命令？
          </strong>
          说明当前会话没有加载 NOWMe Skill：还没安装、装好后没有重开会话，或者装到了 Agent 读不到的位置。按上面的步骤装好并确认后，重开会话再粘贴<strong>同一条</strong>指令。只有 Agent 运行了 <code>nowme fetch</code>，token 才会被用掉；如果已经用掉了，或者找不到那条指令，就点「重新生成指令」。
        </p>
      </div>
    </details>
  );
};

/** 连接状态里的「Skill 版本」一行（只在已连接时显示）。 */
const SkillVersionFact: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const { connection, skill } = model;
  if (!connection.connected) return null;
  return (
    <div>
      <dt>Skill 版本</dt>
      <dd>
        {connection.skillVersion ? (
          <>
            {connection.skillVersion}
            {skill.outdated && skill.latestVersion ? (
              <>
                {' '}
                <span class="badge badge--warn">有新版本 {skill.latestVersion}</span>{' '}
                <a href={skill.installPageUrl}>去更新</a>
              </>
            ) : null}
          </>
        ) : (
          <span class="muted">未知（Agent 用的不是随 Skill 分发的命令行）</span>
        )}
      </dd>
    </div>
  );
};

const ConnectionSection: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const { connection } = model;
  const action = basePath(model);
  return (
    <section class="card ws-agent" aria-labelledby="agent-heading">
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
        <SkillVersionFact model={model} />
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
      <SkillInstallGuide model={model} />
      <p class="muted ws-agent__rule">
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

/** “在这里创作”（平台托管路线，contracts 9）：与本地 Agent 并列。 */
const HostedSection: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const hosted = model.hosted;
  if (!hosted) return null;
  const { overview } = hosted;
  const status = overview.brief?.record.status ?? null;
  const statusText =
    status === 'confirmed' ? 'brief 已确认，可以生成' : status === 'review' ? '等你确认“AI 眼中的你”' : status === 'followups' ? '还有几个追问' : status === 'collecting' ? '采访进行中' : '还没开始';
  const action = basePath(model);
  return (
    <section class="card ws-hosted" id="hosted" aria-labelledby="hosted-heading">
      <h2 id="hosted-heading">在这里创作</h2>
      <p class="muted">{hosted.demo ? overview.modelReady ? DEMO_MODEL_READY : DEMO_MODEL_MISSING : '填写你自己的 AI API，在应用里点选几道题、上传几张图，AI 按同一份 NOWMe Skill 帮你做页面。模型费用由服务商向你收取。'}</p>
      {hosted.error ? <Notice tone="error">{(hosted.demo ? demoModelError(hosted.error) : null) ?? JOB_START_ERROR_TEXT[hosted.error]}</Notice> : null}
      <dl class="facts">
        <div>
          <dt>采访</dt>
          <dd>{statusText}</dd>
        </div>
        <div>
          <dt>AI 服务</dt>
          <dd>{hosted.demo ? overview.modelReady ? '演示模型已配置' : '请维护者补齐配置' : <>{overview.modelReady ? '已配置自己的 API' : '尚未配置'} · <a href="/account/ai">AI 设置</a></>}</dd>
        </div>
      </dl>
      {overview.activeJob ? (
        <Notice tone="info">
          正在{overview.activeJob.kind === 'generate' ? '生成' : '修改'}页面… <a href={`${action}/jobs/${overview.activeJob.id}`}>查看进度</a>
        </Notice>
      ) : null}
      <div class="actions">
        <a class="btn btn--primary" href={`${action}/create`}>
          {status === null ? '开始采访' : status === 'confirmed' ? '去生成' : '继续采访'}
        </a>
        {overview.brief?.record.briefMd ? (
          <a class="btn btn--ghost" href={`${action}/brief`}>
            查看 brief
          </a>
        ) : null}
      </div>
      {model.selected && !overview.activeJob ? (
        <details class="ws-hosted__edit" open={overview.recentJobs.some((job) => job.status === 'succeeded')}>
          <summary>用日常语言修改第 {model.selected.number} 版</summary>
          <EditForm wallId={model.wall.id} csrf={model.csrf} revisionId={model.selected.id} blocks={hosted.editBlocks} revisionNumber={model.selected.number} />
        </details>
      ) : null}
      <p class="muted ws-agent__rule">
        生成和修改的结果是新版本，<strong>发布仍需要你本人在这里确认</strong>。你的采访内容只有你能看到，可以在<a href="/account/data">我的资料</a>里删除。
      </p>
    </section>
  );
};

const PreviewSection: FC<{ model: WorkspaceModel; ownerName: string }> = ({ model, ownerName }) => {
  if (!model.selected || !model.ticket) {
    const hasUsable = model.revisions.some(isRevisionUsable);
    return (
      <section class="ws-preview" aria-labelledby="preview-heading">
        <h2 id="preview-heading" class="ws-preview__title">
          预览
        </h2>
        <div class="phone-empty">
          <p class="phone-empty__mark display" aria-hidden="true">
            Me
          </p>
          <p class="muted">
            {hasUsable
              ? '在版本列表里选一个通过校验的版本预览。'
              : model.hosted
                ? '还没有通过校验的版本。在“在这里创作”里生成，或把指令交给你的 Agent，通过后就能在这里看到页面。'
                : '还没有通过校验的版本。生成指令交给你的 Agent，提交通过后就能在这里看到页面。'}
          </p>
        </div>
      </section>
    );
  }
  return (
    <section class="ws-preview" aria-labelledby="preview-heading">
      <h2 id="preview-heading" class="ws-preview__title">
        预览：第 {model.selected.number} 版
      </h2>
      <PageFrame ticket={model.ticket} title={`${ownerName}的页面（第 ${model.selected.number} 版）`} />
    </section>
  );
};

/** 选中版本的发布确认卡片（没有可发布的版本时不显示）。 */
const PublishSection: FC<{ model: WorkspaceModel }> = ({ model }) =>
  model.selected && model.ticket && model.publish.form ? (
    <section class="card publish-card" aria-label="发布确认">
      <PublishForm model={model} />
    </section>
  ) : null;

type StepState = 'done' | 'current' | 'todo';

/** 顶部的四步进度：生成指令 → Agent 提交 → 通过校验 → 确认发布。 */
function progressSteps(model: WorkspaceModel): { label: string; state: StepState }[] {
  const live = model.revisions.filter((revision) => !isRevisionDeleted(revision));
  const done = [
    Boolean(
      model.instruction ||
        model.connection.connected ||
        model.connection.pendingInstructionExpiresAt ||
        live.length > 0 ||
        model.hosted?.overview.brief ||
        model.hosted?.overview.activeJob,
    ),
    live.length > 0,
    live.some(isRevisionUsable),
    model.publish.state === 'published',
  ];
  const labels = model.hosted
    ? ['开始创作', '生成版本', '通过校验', '确认发布到墙上']
    : ['生成 Agent 指令', 'Agent 提交版本', '通过校验', '确认发布到墙上'];
  const current = done.indexOf(false);
  return labels.map((label, index) => ({ label, state: done[index] ? 'done' : index === current ? 'current' : 'todo' }));
}

const Progress: FC<{ model: WorkspaceModel }> = ({ model }) => (
  <ol class="progress" aria-label="进度">
    {progressSteps(model).map((step, index) => (
      <li class={`progress__step progress__step--${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
        <span class="progress__num" aria-hidden="true">
          {step.state === 'done' ? '✓' : String(index + 1)}
        </span>
        <span class="progress__label">{step.label}</span>
      </li>
    ))}
  </ol>
);

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

export const WorkspaceView: FC<{ model: WorkspaceModel; ownerName: string }> = ({ model, ownerName }) => {
  const showStatus = model.revisions.length > 0 || model.publish.state !== 'unpublished' || model.publish.publicLinkUrl;
  const connectionFirst = !model.hosted?.demo && (Boolean(model.instruction) || model.revisions.every(isRevisionDeleted));
  return (
    <div class="container container--wide">
      <section class="ws-hero">
        <p class="crumbs">
          <a href="/">我的</a>
          <span aria-hidden="true">/</span>
          <a href={`/w/${model.wall.id}`}>{model.wall.name}</a>
        </p>
        <h1 class="hero__title">
          <span class="display">创作工作区</span>
          <span class="ws-hero__sub">我的页面</span>
        </h1>
        <Progress model={model} />
      </section>
      {model.notice ? <WorkspaceNoticeView notice={model.notice} /> : null}
      <div class="ws-layout">
        <div class="ws-layout__main">
          {showStatus ? (
            <div class="ws-first">
              <WallStatusSection model={model} />
            </div>
          ) : null}
          {connectionFirst ? (
            <div class="ws-first">
              <ConnectionSection model={model} />
            </div>
          ) : null}
          <PublishSection model={model} />
          <HostedSection model={model} />
          {connectionFirst ? null : <ConnectionSection model={model} />}
          <RevisionsSection model={model} />
          <MoreActionsSection model={model} />
        </div>
        <aside class="ws-layout__side">
          <PreviewSection model={model} ownerName={ownerName} />
        </aside>
      </div>
    </div>
  );
};
