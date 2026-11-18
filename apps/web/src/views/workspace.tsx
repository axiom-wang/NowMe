import { PROFILE_ENRICHMENT_QUESTIONS } from '@nowme/contracts';
import { DEMO_MODEL_READY, DEMO_MODEL_MISSING, demoModelError } from '../demo-access.js';
/**
 * 我的页面（创作工作区，`GET /w/:wallId/me`）。按主人现在所处的阶段只突出一件事（contracts 18.1，阶段见
 * services/workspace-stage.ts）：还没开始 → 开始采访；采访中 → 继续；资料待确认 → 确认资料；资料已确认 → 生成；
 * 正在做 → 实时进度；有做好的一版 → 看预览、修改或发布；已发布 → 看墙上效果、修改。
 *
 * 默认用 NOWMe 的 AI（平台 AI 可用且点数够时），界面不让新人选路线；“用自己的模型 Key”“用你自己电脑上的 AI 助手”
 * 收在下方的“更多方式”里（平台 AI 没开放或点数不够时默认展开）。墙上的小卡片、公开链接、撤下、做过的每一版、
 * 删除与退出都放在下方。发布相关的组件在 views/publish.tsx。
 */
import type { FC, PropsWithChildren } from 'hono/jsx';
import { formatDateTime } from '../format.js';
import type { RevisionListItem } from '../db/revisions.js';
import { JOB_ERROR_TEXT } from '../hosted/service.js';
import { isRevisionDeleted, isRevisionUsable } from '../services/page-lifecycle.js';
import type { WorkspaceModel, WorkspaceNotice } from '../services/workspace.js';
import { creditGap, type CreationRoute } from '../services/workspace-stage.js';
import { CsrfField, Notice, PostButton } from './forms.js';
import { PageFrame } from './page-frame.js';
import { JobProgress, jobPath } from './progress.js';
import { MoreActionsSection, PublishForm, WallStatusSection } from './publish.js';
import { ReportView } from './report.js';
import { CopyBlock } from './skill.js';
import { allowanceText, EditForm, JOB_START_ERROR_TEXT, priceText } from './hosted.js';

const NOTICE_TEXT: Record<WorkspaceNotice, { tone: 'success' | 'warning' | 'error'; text: string; link?: { href: string; label: string } }> = {
  disconnected: { tone: 'success', text: '已断开你电脑上的 AI 助手：之前给它的连接和没用过的指令都已失效。需要时重新生成指令即可。' },
  'not-previewable': { tone: 'warning', text: '这一版没有做成，不能预览。在下面“做过的每一版”里展开说明，看看哪里有问题。' },
  'deleted-revision': { tone: 'warning', text: '这一版已随页面删除，不能预览或发布。' },
  'text-edited': { tone: 'success', text: '改好了：这是改过文字的新一版。墙上的页面还没变，看看预览，满意就发布。' },
  published: { tone: 'success', text: '已发布：墙上的人现在看到的是这一版，以及你刚确认的小卡片和联系方式。' },
  withdrawn: { tone: 'success', text: '已从墙上撤下：墙上的人看不到你的页面了。做过的每一版都还在，随时可以重新发布。' },
  'not-published': { tone: 'warning', text: '现在墙上没有你的页面，不需要撤下。' },
  'public-link-on': {
    tone: 'success',
    text: '公开链接已开启（每次开启都会生成新链接）。把它发给墙外的人，他们不用登录就能看到你的页面，但看不到联系方式与接话点。',
    link: { href: '#public-link', label: '查看链接' },
  },
  'public-link-off': { tone: 'success', text: '公开链接已关闭，旧链接立即失效。' },
  deleted: {
    tone: 'success',
    text: '这一页已删除：做过的每一版、墙上的小卡片与联系方式都已清除，公开链接已关闭，你电脑上的 AI 助手也已断开。想重新开始，再做一次采访就行。',
  },
  'publish-rejected': {
    tone: 'error',
    text: '发布没有完成：这一版没有做成（检查没通过），不能发布。墙上的页面没有变化。',
  },
  'publish-deleted': { tone: 'error', text: '发布没有完成：这一版已随页面删除，不能发布。墙上的页面没有变化。' },
  'publish-failed': { tone: 'error', text: '发布没有完成：这一版刚刚已不可用。请刷新后重新选择。墙上的页面没有变化。' },
  'publish-errors': {
    tone: 'error',
    text: '发布没有完成：发布确认里还有需要修改的地方。墙上的页面没有变化。',
    link: { href: '#publish', label: '去修改' },
  },
};

const SOURCE_LABEL: Record<RevisionListItem['source'], string> = {
  'local-agent': '你电脑上的 AI 助手做的',
  hosted: '在 NOWMe 上做的',
  'owner-edit': '你自己改了文字',
};

function basePath(model: WorkspaceModel): string {
  return `/w/${model.wall.id}/me`;
}

// ---------------------------------------------------------------------------
// 你自己电脑上的 AI 助手（本地 Agent 路线）
// ---------------------------------------------------------------------------

const InstructionBlock: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const instruction = model.instruction;
  if (!instruction) return null;
  return (
    <div class="instruction" id="instruction">
      <div class="instruction__head">
        <h3>给 AI 助手的指令</h3>
        <span class="badge badge--warn">只能用一次</span>
      </div>
      <p>
        复制下面这一行，发给装好 NOWMe Skill 的 AI 助手。第一次用？先 <a href="#skill-install">给它装上 NOWMe Skill</a>。
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
        <summary>AI 助手不支持 Skill？复制这段纯文本说明</summary>
        <pre class="code code--wrap" id="nm-instruction-text">{instruction.plainText}</pre>
        <p>
          <button type="button" class="btn btn--ghost" data-copy="nm-instruction-text">
            复制说明
          </button>
        </p>
      </details>
      <p class="muted instruction__note">
        这条指令只能使用一次，{formatDateTime(instruction.expiresAt)} 前有效。离开这个页面后就看不到了；
        需要时可以重新生成（旧的未使用指令会作废）。指令里有一串相当于钥匙的字符，不要发到群里。
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
      <summary>第一次用？先给 AI 助手安装 NOWMe Skill</summary>
      <div class="skill-install__body">
        <ol class="skill-install__steps">
          <li>
            <strong>让 AI 助手自己安装（推荐）</strong>：把这句话发给它，它会按说明下载、核对并安装到自己的 Skill 目录。
            <CopyBlock id="nm-skill-install" text={skill.installPrompt} label="复制这句话" />
            想自己下载、或者从 Skill 市场安装，看 <a href={skill.installPageUrl}>安装页</a>。
          </li>
          <li>
            装好后<strong>退出并重新打开一个会话</strong>（多数 AI 助手只在会话开始时加载 Skill），再把指令粘贴给它。
          </li>
          <li>
            <strong>确认装好了</strong>：在新会话里发这句话，回复里有{' '}
            {skill.checkExpected ? <code>{skill.checkExpected}</code> : 'NOWMe Skill 的版本号'} 就说明装好了。
            <CopyBlock id="nm-skill-check" text={skill.checkPrompt} label="复制这句话" />
          </li>
        </ol>
        <p>
          <strong>AI 助手不支持 Skill，或者不想安装？</strong>生成指令后，展开指令下方的「AI 助手不支持 Skill？复制这段纯文本说明」，把整段发给它即可，不需要安装。
        </p>
        <p>
          <strong>
            AI 助手回复 <code>Unknown command: /nowme-page</code>，或者说不认识这个命令？
          </strong>
          说明当前会话没有加载 NOWMe Skill：还没安装、装好后没有重开会话，或者装到了它读不到的位置。按上面的步骤装好并确认后，重开会话再粘贴<strong>同一条</strong>指令。只有它真正开始做（运行了 <code>nowme fetch</code>），指令才会被用掉；如果已经用掉了，或者找不到那条指令，就点「重新生成指令」。
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
          <span class="muted">未知（AI 助手用的不是随 Skill 分发的命令行）</span>
        )}
      </dd>
    </div>
  );
};

const LocalAgentBlock: FC<{ model: WorkspaceModel; standalone?: boolean }> = ({ model, standalone = false }) => {
  const { connection } = model;
  const action = basePath(model);
  const Heading = standalone ? 'h2' : 'h3';
  return (
    <div class="ws-agent" id="local-agent">
      <Heading id="agent-heading">用你自己电脑上的 AI 助手</Heading>
      <p class="muted">适合已经在用 AI 编程助手的人：生成一条指令交给它，它在你的电脑上采访你、做好页面再交回来。资料留在你自己的电脑上。</p>
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
          <dt>最近一次交回</dt>
          <dd>{model.lastSubmittedAt ? formatDateTime(model.lastSubmittedAt) : <span class="muted">还没有交回过</span>}</dd>
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
        你的 AI 助手只能读取这面墙的介绍、交回做好的页面；<strong>发布需要你本人在这里确认</strong>，它不能替你发布。
      </p>
      <div class="actions">
        <PostButton
          action={`${action}/instruction`}
          csrf={model.csrf}
          label={model.instruction || connection.pendingInstructionExpiresAt || connection.connected ? '重新生成指令' : '生成给 AI 助手的指令'}
          variant={model.instruction ? 'ghost' : standalone ? 'primary' : 'ghost'}
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
            label="断开 AI 助手"
            variant="danger"
            confirm="断开后，你电脑上的 AI 助手立即不能再交回新的页面（已有的版本不受影响）。继续吗？"
          />
        ) : null}
      </div>
    </div>
  );
};

/** 用自己的模型 Key（在 AI 设置里配置；配置后采访与生成都用它，不消耗点数）。 */
const OwnKeyBlock: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const hosted = model.hosted;
  if (!hosted || hosted.demo) return null;
  const own = hosted.overview.ai.mode === 'own';
  return (
    <div class="ws-ownkey" id="own-key">
      <h3>用自己的模型 Key</h3>
      <p class="muted">
        {own
          ? '你已经填了自己的模型 Key：采访和生成都用它，不消耗点数，费用由模型服务商向你收取。'
          : '有 DeepSeek、通义千问、Kimi 等模型服务的 Key？在 AI 设置里填一次，就能在这里采访和生成，不消耗点数，费用由服务商向你收取。'}
      </p>
      <p>
        <a class="btn btn--ghost" href="/account/ai">
          {own ? '管理我的模型 Key' : '填写自己的模型 Key'}
        </a>
      </p>
    </div>
  );
};

/** “更多方式”：自己的 Key 与本地 AI 助手。平台 AI 不可用、点数不够、已经在用本地路线时默认展开。 */
const MoreWays: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const hosted = model.hosted;
  if (!hosted) return null;
  const usedLocal = model.connection.connected || Boolean(model.connection.pendingInstructionExpiresAt) || model.revisions.some((revision) => revision.source === 'local-agent' && !isRevisionDeleted(revision));
  const open = Boolean(model.instruction) || usedLocal || hosted.route === 'setup' || hosted.route === 'credits';
  return (
    <details class="card more-ways" id="more-ways" open={open}>
      <summary>
        <span class="more-ways__title">更多方式</span>
        <span class="muted more-ways__hint">用自己的模型 Key，或你自己电脑上的 AI 助手</span>
      </summary>
      <div class="more-ways__body">
        <OwnKeyBlock model={model} />
        <LocalAgentBlock model={model} />
      </div>
    </details>
  );
};

// ---------------------------------------------------------------------------
// 现在该做的事
// ---------------------------------------------------------------------------

/** 用的是谁的 AI、要多少点（一句话）。 */
const AiLine: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const hosted = model.hosted;
  if (!hosted) return null;
  const { overview } = hosted;
  if (hosted.demo) return <p class="muted next-step__ai">{overview.modelReady ? DEMO_MODEL_READY : DEMO_MODEL_MISSING}</p>;
  if (hosted.route === 'platform' || hosted.route === 'credits') {
    return (
      <p class="muted next-step__ai">
        用的是 NOWMe 的 AI：采访不收点数；{priceText(overview.ai.prices)}。{allowanceText(overview.ai)}。 <a href="/account/credits">点数</a>
      </p>
    );
  }
  if (hosted.route === 'own') return <p class="muted next-step__ai">用的是你自己的模型 Key，不消耗点数，费用由模型服务商向你收取。</p>;
  return null;
};

/** 平台 AI 用不了（点数不够 / 没开放）时的说明与下一步。 */
const RouteHelp: FC<{ model: WorkspaceModel; route: CreationRoute; kind?: 'generate' | 'edit' }> = ({ model, route, kind = 'generate' }) => {
  const hosted = model.hosted;
  if (!hosted || hosted.demo) return null;
  if (route === 'credits') {
    const gap = creditGap(hosted.overview.ai, kind);
    return (
      <div class="next-help next-help--credits" role="status">
        <p>
          <strong>点数不够。</strong>用 NOWMe 的 AI {kind === 'generate' ? '生成一版页面' : '修改一次'}要 {gap.price} 点，你现在能用 {gap.available} 点。
        </p>
        <p class="muted">
          可以用兑换码补充点数，或者请组织者给这面墙充一点额度（组织者为大家买单）。也可以展开下面的“更多方式”，用自己的模型 Key 或你自己电脑上的 AI 助手，不用点数。
        </p>
      </div>
    );
  }
  if (route === 'setup') {
    return (
      <div class="next-help next-help--setup" role="status">
        <p>
          <strong>这里暂时没有可以直接用的 AI，</strong>需要你自己准备一个。两种办法任选一种：
        </p>
        <ul class="next-help__list">
          <li>有模型服务的 Key（比如 DeepSeek、通义千问）？在 AI 设置里填一次，就能在这里采访和生成，费用由服务商向你收取。</li>
          <li>电脑上装了 AI 编程助手？用下面“更多方式”里的指令，让它帮你做。</li>
        </ul>
      </div>
    );
  }
  return null;
};

/** 点数不够 / 没开放时的主要按钮（只给一个）。 */
const RouteAction: FC<{ route: CreationRoute }> = ({ route }) =>
  route === 'credits' ? (
    <a class="btn btn--primary btn--lg" href="/account/credits">
      去兑换点数
    </a>
  ) : (
    <a class="btn btn--primary btn--lg" href="/account/ai">
      填写自己的模型 Key
    </a>
  );

const ProgressiveQuestion: FC<{ model: WorkspaceModel }> = ({ model }) => {
  if (!model.hosted || model.hosted.overview.activeJob) return null;
  const count = model.hosted.overview.brief?.brief?.ownerEdits?.length ?? 0;
  const questionIndex = count % PROFILE_ENRICHMENT_QUESTIONS.length;
  const question = PROFILE_ENRICHMENT_QUESTIONS[questionIndex]!;
  return <form method="post" action={`/w/${model.wall.id}/me/enrich`} class="card stack">
    <CsrfField token={model.csrf} /><input type="hidden" name="questionIndex" value={String(questionIndex)} /><label class="field"><span>{question.question}</span><input type="text" name="answer" maxlength={200} placeholder="有空补一句，让页面更具体（可选）" /></label>
    <button class="btn btn--ghost" type="submit">看看要不要加进页面</button>
  </form>;
};

const EditDetails: FC<{ model: WorkspaceModel; summary: string }> = ({ model, summary }) => {
  const hosted = model.hosted;
  if (!hosted || !model.selected || hosted.overview.activeJob) return null;
  const blocked = !hosted.demo && (hosted.editRoute === 'credits' || hosted.editRoute === 'setup');
  return (
    <details class="ws-hosted__edit" id="edit">
      <summary>{summary}</summary>
      {hosted.error ? <Notice tone="error">{(hosted.demo ? demoModelError(hosted.error) : null) ?? JOB_START_ERROR_TEXT[hosted.error]}</Notice> : null}
      {blocked ? (
        <RouteHelp model={model} route={hosted.editRoute} kind="edit" />
      ) : (
        <EditForm wallId={model.wall.id} csrf={model.csrf} revisionId={model.selected.id} blocks={hosted.editBlocks} revisionNumber={model.selected.number} />
      )}
    </details>
  );
};

/** 直接改文字的入口（contracts 22）：两条创作路线都有，不需要 AI。 */
const TextEditLink: FC<{ model: WorkspaceModel }> = ({ model }) =>
  model.selected && isRevisionUsable(model.selected) ? (
    <p class="ws-text-edit">
      <a href={`${basePath(model)}/text?rev=${model.selected.id}`}>只是改几个字？直接改文字</a>
      <span class="muted">（不用 AI，不扣点数）</span>
    </p>
  ) : null;

const NextStepCard: FC<PropsWithChildren<{ eyebrow: string; title: string; tone?: string }>> = ({ eyebrow, title, children, tone }) => (
  <section class={`card card--pinned next-step${tone ? ` next-step--${tone}` : ''}`} id="next-step" aria-labelledby="next-step-heading">
    <p class="next-step__eyebrow">{eyebrow}</p>
    <h2 id="next-step-heading">{title}</h2>
    {children}
  </section>
);

/** 网页内创作（平台 AI / 自己的 Key）：按阶段只突出一件事。 */
const NextStep: FC<{ model: WorkspaceModel }> = ({ model }) => {
  const hosted = model.hosted;
  if (!hosted) return <LocalNextStep model={model} />;
  const base = basePath(model);
  // 演示模式用预置的模型配置：始终按“自己的 Key”引导（没配好时 AiLine 会说明）
  const route = hosted.demo ? 'own' : hosted.route;
  const canRun = route === 'platform' || route === 'own';
  const error = hosted.error ? <Notice tone="error">{(hosted.demo ? demoModelError(hosted.error) : null) ?? JOB_START_ERROR_TEXT[hosted.error]}</Notice> : null;
  const active = model.publish.active;
  const updating = model.stage === 'published' && model.selected && active && active.publication.revisionId !== model.selected.id;

  switch (model.stage) {
    case 'start':
      return (
        <NextStepCard eyebrow="第一步" title={canRun || route === 'credits' ? '先聊几句，让 AI 认识你' : '先准备好 AI'}>
          <p>回答几个小问题，愿意的话加几张照片。AI 会把你的回答整理成一份资料，你确认后再做页面。大约 5 分钟。</p>
          {error}
          <AiLine model={model} />
          <RouteHelp model={model} route={route} />
          <div class="actions">
            {canRun ? (
              <a class="btn btn--primary btn--lg" href={`${base}/create`}>
                开始采访
              </a>
            ) : (
              <RouteAction route={route} />
            )}
            {route === 'credits' ? (
              <a class="btn btn--ghost" href={`${base}/create`}>
                先开始采访（不收点数）
              </a>
            ) : null}
          </div>
        </NextStepCard>
      );
    case 'interview':
      return (
        <NextStepCard eyebrow="采访中" title="采访还没做完">
          <p>接着回答剩下的几个问题就好，已经填的都保存着。</p>
          <div class="actions">
            <a class="btn btn--primary btn--lg" href={`${base}/create`}>
              继续采访
            </a>
          </div>
        </NextStepCard>
      );
    case 'review':
      return (
        <NextStepCard eyebrow="快好了" title="AI 整理好了你的资料">
          <p>看看对不对：每一句都可以改写或划掉。确认之后才开始做页面。</p>
          <div class="actions">
            <a class="btn btn--primary btn--lg" href={`${base}/create`}>
              确认资料
            </a>
          </div>
        </NextStepCard>
      );
    case 'ready':
      return (
        <NextStepCard eyebrow="资料确认好了" title="可以做页面了">
          {hosted.lastFailure ? (
            <Notice tone="error">
              上次没有做成：{JOB_ERROR_TEXT[hosted.lastFailure.errorCode ?? 'INTERNAL'] ?? JOB_ERROR_TEXT.INTERNAL}
            </Notice>
          ) : (
            <p>AI 会按你确认的资料做一页你自己，一般要几分钟。做好后先给你看，你确认了才会发布到墙上。</p>
          )}
          {error}
          <AiLine model={model} />
          <RouteHelp model={model} route={route} />
          <div class="actions">
            {canRun ? (
              <PostButton action={`${base}/generate`} csrf={model.csrf} label={hosted.lastFailure ? '再生成一次' : '生成页面'} variant="primary" />
            ) : (
              <RouteAction route={route} />
            )}
            {hosted.overview.brief?.record.briefMd ? (
              <a class="btn btn--ghost" href={`${base}/brief`}>
                看看我的资料
              </a>
            ) : null}
          </div>
        </NextStepCard>
      );
    case 'generating': {
      const job = hosted.overview.activeJob;
      if (!job) return null;
      return (
        <section class="card card--pinned next-step next-step--progress" id="next-step" aria-label="进度">
          <JobProgress wallId={model.wall.id} jobId={job.id} kind={job.kind} view={hosted.progress ?? { seq: 0, stage: 'queued', step: 'queued', label: '排队中，马上轮到你', turn: null, maxTurns: null }} pollMs={model.progressPollMs} emailOn={model.notifyEmail} heading />
          <p>
            <a href={jobPath(model.wall.id, job.id)}>查看详情</a>
          </p>
        </section>
      );
    }
    case 'preview':
      return (
        <NextStepCard eyebrow="做好了" title={`第 ${model.selected?.number ?? ''} 版做好了`} tone="ready">
          <p>先看看预览：满意就确认发布，墙上的人就能看到你；不满意可以用一句话告诉 AI 怎么改。</p>
          {error}
          <div class="actions">
            {model.publish.form ? (
              <a class="btn btn--primary btn--lg" href="#publish">
                发布到墙上
              </a>
            ) : null}
          </div>
          <EditDetails model={model} summary="想改一改？用一句话告诉 AI" />
          <TextEditLink model={model} />
        </NextStepCard>
      );
    case 'published':
      if (updating && model.selected) {
        return (
          <NextStepCard eyebrow="新的一版" title={`第 ${model.selected.number} 版做好了`} tone="ready">
            <p>墙上现在是第 {active?.revisionNumber ?? '?'} 版。看看预览，满意就用这一版更新墙上的页面。</p>
            {error}
            <div class="actions">
              <a class="btn btn--primary btn--lg" href="#publish">
                用这一版更新
              </a>
              {model.wallPagePath ? (
                <a class="btn btn--ghost" href={model.wallPagePath}>
                  看看墙上现在的样子
                </a>
              ) : null}
            </div>
            <EditDetails model={model} summary="再改一改？用一句话告诉 AI" />
          <TextEditLink model={model} />
          </NextStepCard>
        );
      }
      return (
        <NextStepCard eyebrow="已发布" title="你的页面已经在墙上了" tone="live">
          <ProgressiveQuestion model={model} />
          <p>墙上的人现在能看到你的第 {active?.revisionNumber ?? '?'} 版，点小卡片上的话题就能来找你聊。</p>
          {error}
          <div class="actions">
            {model.wallPagePath ? (
              <a class="btn btn--primary btn--lg" href={model.wallPagePath}>
                看看墙上的样子
              </a>
            ) : null}
            <a class="btn btn--ghost" href="#wall-status">
              公开链接与撤下
            </a>
          </div>
          <EditDetails model={model} summary="想改一改？用一句话告诉 AI" />
          <TextEditLink model={model} />
        </NextStepCard>
      );
  }
};

/** 只有本地 AI 助手一条路时（网页内创作没开启）。 */
const LocalNextStep: FC<{ model: WorkspaceModel }> = ({ model }) => {
  if (model.stage === 'published') {
    return (
      <NextStepCard eyebrow="已发布" title="你的页面已经在墙上了" tone="live">
          <ProgressiveQuestion model={model} />
        <div class="actions">
          {model.wallPagePath ? (
            <a class="btn btn--primary btn--lg" href={model.wallPagePath}>
              看看墙上的样子
            </a>
          ) : null}
        </div>
        <TextEditLink model={model} />
      </NextStepCard>
    );
  }
  if (model.stage === 'preview') {
    return (
      <NextStepCard eyebrow="做好了" title={`第 ${model.selected?.number ?? ''} 版做好了`} tone="ready">
        <p>先看看预览，满意就确认发布。</p>
        <div class="actions">
          {model.publish.form ? (
            <a class="btn btn--primary btn--lg" href="#publish">
              发布到墙上
            </a>
          ) : null}
        </div>
        <TextEditLink model={model} />
      </NextStepCard>
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// 预览、发布、做过的每一版
// ---------------------------------------------------------------------------

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
          <p class="muted">{hasUsable ? '在“做过的每一版”里选一版预览。' : '做好的页面会出现在这里。'}</p>
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

const Progress: FC<{ model: WorkspaceModel }> = ({ model }) => (
  <ol class={`progress progress--${model.steps.length}`} aria-label="进度">
    {model.steps.map((step, index) => (
      <li class={`progress__step progress__step--${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
        <span class="progress__num" aria-hidden="true">
          {step.state === 'done' ? '✓' : String(index + 1)}
        </span>
        <span class="progress__label">{step.label}</span>
      </li>
    ))}
  </ol>
);

/** 版本列表里给“其他做好的版本”的发布入口文字（进入同一个发布确认流程，W10）。 */
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
      <span class="muted revision__meta">{formatDateTime(revision.createdAt)}，内容已随页面删除</span>
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
        <span class={`badge ${accepted ? 'badge--ok' : 'badge--bad'}`}>{accepted ? '做好了' : '没做成'}</span>
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
          <summary>哪里出了问题（{revision.report.errors.length} 处要改）</summary>
          <ReportView report={revision.report} source={revision.source} />
        </details>
      ) : issues > 0 ? (
        <details class="revision__report">
          <summary>{revision.report.warnings.length} 条小提醒</summary>
          <ReportView report={revision.report} source={revision.source} />
        </details>
      ) : null}
    </li>
  );
};

const RevisionsSection: FC<{ model: WorkspaceModel }> = ({ model }) =>
  model.revisions.length === 0 ? null : (
    <section class="card ws-revisions" aria-labelledby="revisions-heading">
      <h2 id="revisions-heading">做过的每一版</h2>
      <p class="muted">每次生成、修改或交回都会多一版；没做成的那一版不会影响已有的。</p>
      <ol class="revisions">
        {model.revisions.map((revision, index) => (
          <RevisionItem model={model} revision={revision} latest={index === 0} />
        ))}
      </ol>
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
  const showStatus = model.publish.state !== 'unpublished' || Boolean(model.publish.publicLinkUrl);
  // 刚生成了给 AI 助手的指令：把“更多方式”放到最上面（指令只在这次响应里出现）
  const instructionFirst = Boolean(model.instruction);
  const hasPreview = Boolean(model.selected && model.ticket);
  return (
    <div class="container container--wide">
      <section class="ws-hero">
        <nav class="crumbs" aria-label="当前位置">
          <a href="/">我的</a>
          <span aria-hidden="true">/</span>
          <a class="crumbs__wall" href={`/w/${model.wall.id}`} title={model.wall.name}>{model.wall.name}</a>
        </nav>
        <h1 class="hero__title"><span class="display">我的页面</span></h1>
        <Progress model={model} />
      </section>
      {model.notice ? <WorkspaceNoticeView notice={model.notice} /> : null}
      <div class={`ws-layout ws-layout--${model.stage}${hasPreview ? '' : ' ws-layout--no-preview'}`}>
        <div class="ws-layout__main">
          {instructionFirst ? (
            <div class="ws-first">{model.hosted ? <MoreWays model={model} /> : <section class="card"><LocalAgentBlock model={model} standalone /></section>}</div>
          ) : null}
          <div class="ws-first">
            <NextStep model={model} />
          </div>
          <PublishSection model={model} />
          {model.hosted ? null : instructionFirst ? null : (
            <section class="card ws-local" aria-labelledby="agent-heading">
              <LocalAgentBlock model={model} standalone />
            </section>
          )}
          {showStatus ? <WallStatusSection model={model} /> : null}
          {instructionFirst ? null : <MoreWays model={model} />}
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
