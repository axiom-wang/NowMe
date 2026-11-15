/**
 * 墙、邀请、加入、浏览、想聊这个（T3.1，contracts 4.2、W02、W04、W13、W14）。
 *
 * | 路径 | 谁能访问 |
 * | --- | --- |
 * | GET /walls/new、POST /walls | 登录用户（建好后跳到组织者后台） |
 * | GET /join/:inviteCode、POST /join/:inviteCode | 登录用户（邀请码无效 / 墙关闭 → 404；已移除 → 友好提示，不能加入；已是成员 → 直接进墙） |
 * | GET /w/:wallId | 墙内有效成员 |
 * | GET /w/:wallId/p/:pageId | 墙内有效成员；页面有活跃发布且主人成员关系有效（PageFrame，票据只给当前发布版本） |
 * | POST /w/:wallId/p/:pageId/chat | 墙内有效成员；接话点存在且不是自己 → 进入站内私聊，预填开场白 |
 * | POST /w/:wallId/p/:pageId/direct | 墙内有效成员；不是自己的已发布页面 → 进入私聊 |
 * | POST /w/:wallId/p/:pageId/contact | 墙内有效成员；公开联系方式、接话点存在且不是自己 → 查看联系方式 |
 * | POST /w/:wallId/p/:pageId/icebreaker | 墙内有效成员；不是自己的已发布页面 → 用查看者自己的模型找话题（contracts 11） |
 * | POST /w/:wallId/p/:pageId/icebreaker/chat | 同上；用结果里的某一句开场白进入私聊（只预填，不发送） |
 * | POST /w/:wallId/p/:pageId/icebreaker/clear | 同上；清除查看者自己的结果 |
 * | GET /w/:wallId/covers/:pageId.png | 墙内有效成员（墙上可见页面的当前发布版本封面） |
 *
 * GET 用 `requireUser`（未登录 → /login?next=）；POST 用 `requireForm`（会话 + CSRF + Origin，忽略 Authorization）。
 * 无权访问一律 `renderNotFound(c)`，不暴露墙或页面是否存在。授权检查在 services/access.ts。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isTokenFormat, PAGE_ID_PATTERN, SCENE_TYPES } from '@nowme/contracts';
import type { AppDeps, AppHono } from '../context.js';
import type { Wall } from '../db/walls.js';
import { requireForm } from '../security/forms.js';
import { authOf, requireUser } from '../security/session.js';
import { findMemberWall, findPublishedMemberPage } from '../services/access.js';
import { coverFilePath, loadMemberPageModel, loadWallModel, parsePublishedCard, resolveChat } from '../services/wall-view.js';
import { createWall, joinState, joinWall, parseWallForm } from '../services/walls.js';
import { parseQuestionForm, questionTexts, saveQuestions } from '../services/wall-questions.js';
import { questionsGate } from './organizer-tools.js';
import { portraitShareText } from '../services/portrait.js';
import { openDirect } from '../services/chat.js';
import { clearIcebreaker, generateIcebreaker, ICEBREAKER_ERROR_TEXT, icebreakerOpener, loadIcebreakerPanel, type IcebreakerFailure } from '../services/icebreaker.js';
import { renderNotFound } from '../views/errors.js';
import { pageSafetyModel } from './moderation.js';
import { JoinView, RemovedFromWallView } from '../views/join.js';
import { renderPage } from '../views/layout.js';
import { ChatView, MemberPageView } from '../views/member-page.js';
import { NewWallView, type SceneChoice } from '../views/wall-new.js';
import { WallView, type WallNotice } from '../views/wall.js';
import { sceneLabels } from './home.js';

/** 邀请码格式不对、不存在、墙已关闭都显示这一句，不暴露是哪一种。 */
const INVITE_NOT_FOUND_TEXT = '这个邀请链接打不开：可能少复制了几个字，或者这面墙已经关闭。可以向组织者再要一个链接。';

const WALL_NOTICES: ReadonlySet<string> = new Set<WallNotice>(['joined', 'rejoined', 'blocked']);

export function wallPath(wallId: string): string {
  return `/w/${wallId}`;
}

export function invitePath(inviteCode: string): string {
  return `/join/${inviteCode}`;
}

export function registerWallRoutes(app: AppHono, deps: AppDeps): void {
  const user = requireUser(deps);
  const form = requireForm(deps);
  const labels = sceneLabels();
  const scenes: SceneChoice[] = SCENE_TYPES.map((type) => ({ type, label: labels[type] }));

  // 头像仅向同墙的有效成员提供，移除或关墙后立即失效。
  app.get('/w/:wallId/members/:userId/avatar', user, (c) => {
    const viewer = authOf(c).user.id;
    const wallId = c.req.param('wallId');
    const targetId = c.req.param('userId');
    if (!findMemberWall(deps.repos, viewer, wallId) || !findMemberWall(deps.repos, targetId, wallId)) return renderNotFound(c);
    const bytes = deps.repos.users.avatarForUser(targetId);
    if (!bytes) return renderNotFound(c);
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' });
  });

  // -------------------------------------------------------------------------
  // 建墙（W02）
  // -------------------------------------------------------------------------

  app.get('/walls/new', user, (c) =>
    renderPage(c, { title: '建一面墙', body: <NewWallView csrf={authOf(c).session.csrfToken} scenes={scenes} /> }),
  );

  app.post('/walls', form, async (c) => {
    const auth = authOf(c);
    const fields = c.get('form');
    const parsed = parseWallForm(fields);
    const questions = parseQuestionForm(fields);
    const questionErrors = questions.ok ? {} : questions.errors;
    if (!parsed.ok || !questions.ok) {
      return renderPage(c, {
        title: '建一面墙',
        status: 400,
        body: <NewWallView csrf={auth.session.csrfToken} scenes={scenes} values={parsed.ok ? { ...parsed.input, organizerNote: parsed.input.organizerNote ?? '' } : parsed.values} errors={parsed.ok ? {} : parsed.errors} questions={questions.values} questionErrors={questionErrors} />,
      });
    }
    // 内容安全（contracts 16.1）：墙的名称、简介、组织者的话、必答题
    const errors: Record<string, string> = {};
    for (const [field, text] of [['name', parsed.input.name], ['description', parsed.input.description], ['organizerNote', parsed.input.organizerNote]] as const) {
      const verdict = await deps.contentSafety.checkText('wall', text);
      if (!verdict.ok) errors[field] = verdict.message;
    }
    const blockedQuestions: Record<number, string> = {};
    const texts = questionTexts(questions.drafts);
    for (const [index, draft] of questions.drafts.entries()) {
      const verdict = await deps.contentSafety.checkText('wall', texts[index] ?? '');
      if (!verdict.ok) blockedQuestions[draft.index] = verdict.message;
    }
    if (Object.keys(errors).length > 0 || Object.keys(blockedQuestions).length > 0) {
      const { name, description, sceneType, organizerNote } = parsed.input;
      return renderPage(c, {
        title: '建一面墙',
        status: 422,
        body: (
          <NewWallView
            csrf={auth.session.csrfToken}
            scenes={scenes}
            values={{ name, description, sceneType, organizerNote: organizerNote ?? '' }}
            errors={errors}
            questions={questions.values}
            questionErrors={blockedQuestions}
          />
        ),
      });
    }
    const { wall } = createWall(deps, { organizerId: auth.user.id, ...parsed.input });
    if (questions.drafts.length > 0) {
      // 建墙时还没有任何题目：表单里的题目 ID 一律当作新题
      saveQuestions(deps, wall.id, questions.drafts.map((draft) => ({ ...draft, id: null })));
      deps.repos.events.record({ type: 'wall_questions_save', wallId: wall.id, pageId: null, actorId: auth.user.id, props: { questions: questions.drafts.length, created: true }, createdAt: deps.now().toISOString() });
    }
    return c.redirect(`${wallPath(wall.id)}/admin?notice=created`, 303);
  });

  // -------------------------------------------------------------------------
  // 邀请与加入（W04）
  // -------------------------------------------------------------------------

  /** 邀请码对应的、开启的墙；格式不对、不存在、墙已关闭都返回 null（404）。 */
  function invitedWall(inviteCode: string): Wall | null {
    if (!isTokenFormat(inviteCode, 'invite')) return null;
    const wall = deps.repos.walls.findByInviteCode(inviteCode);
    return wall && wall.status === 'open' ? wall : null;
  }

  app.get('/join/:inviteCode', user, (c) => {
    const auth = authOf(c);
    const wall = invitedWall(c.req.param('inviteCode'));
    if (!wall) return renderNotFound(c, { message: INVITE_NOT_FOUND_TEXT });
    const state = joinState(deps, wall, auth.user.id);
    if (state.kind === 'member') return c.redirect(wallPath(wall.id), 303);
    if (state.kind === 'removed') {
      return renderPage(c, { title: '现在不能加入这面墙', status: 403, body: <RemovedFromWallView wall={wall} /> });
    }
    return renderPage(c, {
      title: `加入「${wall.name}」`,
      body: <JoinView wall={wall} sceneLabel={labels[wall.sceneType]} csrf={auth.session.csrfToken} rejoin={state.rejoin} />,
    });
  });

  app.post('/join/:inviteCode', form, (c) => {
    const auth = authOf(c);
    const wall = invitedWall(c.req.param('inviteCode'));
    if (!wall) return renderNotFound(c, { message: INVITE_NOT_FOUND_TEXT });
    const result = joinWall(deps, wall, auth.user.id);
    switch (result.kind) {
      case 'closed':
        return renderNotFound(c, { message: INVITE_NOT_FOUND_TEXT });
      case 'removed':
        return renderPage(c, { title: '现在不能加入这面墙', status: 403, body: <RemovedFromWallView wall={wall} /> });
      case 'already':
        return c.redirect(wallPath(wall.id), 303);
      case 'joined':
      case 'rejoined':
        return c.redirect(`${wallPath(wall.id)}?notice=${result.kind}`, 303);
    }
  });

  // -------------------------------------------------------------------------
  // 墙（W13）
  // -------------------------------------------------------------------------

  app.get('/w/:wallId', user, (c) => {
    const auth = authOf(c);
    const member = findMemberWall(deps.repos, auth.user.id, c.req.param('wallId'));
    if (!member) return renderNotFound(c);
    const gate = questionsGate(c, deps, member);
    if (gate) return gate;
    const model = loadWallModel(deps, member);
    deps.repos.events.record({
      type: 'wall_view',
      wallId: member.wall.id,
      pageId: null,
      actorId: auth.user.id,
      props: { cards: model.cards.length },
      createdAt: deps.now().toISOString(),
    });
    const notice = c.req.query('notice');
    return renderPage(c, {
      title: member.wall.name,
      bodyClass: 'page--wall',
      body: (
        <WallView
          model={model}
          sceneLabel={labels[member.wall.sceneType]}
          notice={notice && WALL_NOTICES.has(notice) ? (notice as WallNotice) : null}
          csrf={auth.session.csrfToken}
          portraitShare={model.portrait.kind === 'ready' ? portraitShareText(member.wall, model.portrait.view, `${deps.config.webOrigin}${wallPath(member.wall.id)}`) : null}
        />
      ),
    });
  });

  app.get('/w/:wallId/covers/:file', user, async (c) => {
    const auth = authOf(c);
    const file = c.req.param('file');
    const pageId = file.endsWith('.png') ? file.slice(0, -'.png'.length) : '';
    if (!PAGE_ID_PATTERN.test(pageId)) return renderNotFound(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), pageId);
    if (!found) return renderNotFound(c);
    let body: Buffer;
    try {
      body = await readFile(coverFilePath(deps.config.dataDir, found.entry.revisionId));
    } catch {
      return renderNotFound(c);
    }
    // ETag 用版本 ID 的哈希（不在响应里暴露版本 ID）；每次都重新做授权检查（no-cache），移除 / 关闭后立即失效
    const etag = `"${createHash('sha256').update(found.entry.revisionId).digest('base64url').slice(0, 22)}"`;
    const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    return c.body(new Uint8Array(body), 200, { ...headers, 'Content-Type': 'image/png' });
  });

  // -------------------------------------------------------------------------
  // 成员页与想聊这个（W14）
  // -------------------------------------------------------------------------

  app.get('/w/:wallId/p/:pageId', user, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found) return renderNotFound(c);
    const gate = questionsGate(c, deps, found);
    if (gate) return gate;
    const model = loadMemberPageModel(deps, found);
    if (!found.own) {
      deps.repos.events.record({
        type: 'page_open',
        wallId: found.wall.id,
        pageId: found.entry.pageId,
        actorId: auth.user.id,
        createdAt: deps.now().toISOString(),
      });
    }
    const failure = c.req.query('ice');
    return renderPage(c, {
      title: `${model.card.displayName} · ${found.wall.name}`,
      body: (
        <MemberPageView
          model={model}
          csrf={auth.session.csrfToken}
          icebreaker={found.own ? null : loadIcebreakerPanel(deps, found, auth.user.id)}
          icebreakerError={failure && Object.hasOwn(ICEBREAKER_ERROR_TEXT, failure) ? ICEBREAKER_ERROR_TEXT[failure as IcebreakerFailure] : null}
          aiSettings={!deps.demo}
          safety={found.own ? null : pageSafetyModel(deps, found, auth.user.id, c.req.query('safety'))}
        />
      ),
    });
  });

  // -------------------------------------------------------------------------
  // 和 TA 聊什么（contracts 11）
  // -------------------------------------------------------------------------

  app.post('/w/:wallId/p/:pageId/icebreaker', form, async (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own) return renderNotFound(c);
    const result = await generateIcebreaker(deps, found, auth.user.id);
    const base = `/w/${found.wall.id}/p/${found.entry.pageId}`;
    return c.redirect(result.ok ? `${base}#talk` : `${base}?ice=${result.error}#talk`, 303);
  });

  app.post('/w/:wallId/p/:pageId/icebreaker/chat', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own) return renderNotFound(c);
    const fields = c.get('form');
    const index = /^[0-2]$/.test(fields.opener ?? '') ? Number(fields.opener) : -1;
    const icebreakerId = fields.icebreakerId ?? '';
    if (icebreakerOpener(deps, found, auth.user.id, icebreakerId, index) === null) return renderNotFound(c);
    const id = openDirect(deps, auth.user.id, found.wall.id, found.entry.ownerId);
    if (!id) return renderNotFound(c);
    deps.repos.events.record({ type: 'want_to_chat', wallId: found.wall.id, pageId: found.entry.pageId, actorId: auth.user.id, props: { ai: true, openerIndex: index }, createdAt: deps.now().toISOString() });
    return c.redirect(`/messages/${id}?pageId=${found.entry.pageId}&ice=${icebreakerId}&o=${index}`, 303);
  });

  app.post('/w/:wallId/p/:pageId/icebreaker/clear', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own) return renderNotFound(c);
    clearIcebreaker(deps, found, auth.user.id);
    return c.redirect(`/w/${found.wall.id}/p/${found.entry.pageId}#talk`, 303);
  });

  app.post('/w/:wallId/p/:pageId/chat', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own) return renderNotFound(c);
    const hookId = c.get('form').hookId ?? '';
    const hooks = parsePublishedCard(found.entry.cardJson, '').hooks;
    const hook = hooks.find((item) => item.id === hookId) ?? (/^\d{1,2}$/.test(hookId) ? hooks.find((item) => item.index === Number(hookId)) : undefined);
    if (!hook) return renderNotFound(c);
    const id = openDirect(deps, auth.user.id, found.wall.id, found.entry.ownerId);
    if (!id) return renderNotFound(c);
    deps.repos.events.record({ type: 'want_to_chat', wallId: found.wall.id, pageId: found.entry.pageId, actorId: auth.user.id, props: { hookIndex: hook.index }, createdAt: deps.now().toISOString() });
    return c.redirect(`/messages/${id}?pageId=${found.entry.pageId}&hookId=${encodeURIComponent(hook.id)}`, 303);
  });

  app.post('/w/:wallId/p/:pageId/direct', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found || found.own) return renderNotFound(c);
    const id = openDirect(deps, auth.user.id, found.wall.id, found.entry.ownerId);
    return id ? c.redirect(`/messages/${id}`, 303) : renderNotFound(c);
  });

  app.post('/w/:wallId/p/:pageId/contact', form, (c) => {
    const auth = authOf(c);
    const found = findPublishedMemberPage(deps, auth.user.id, c.req.param('wallId'), c.req.param('pageId'));
    if (!found) return renderNotFound(c);
    const chat = resolveChat(deps, found, c.get('form').hookId ?? c.get('form').contactHookId ?? '');
    if (!chat) return renderNotFound(c);
    deps.repos.events.record({
      type: 'want_to_chat',
      wallId: found.wall.id,
      pageId: found.entry.pageId,
      actorId: auth.user.id,
      props: { hookIndex: chat.hook.index },
      createdAt: deps.now().toISOString(),
    });
    return renderPage(c, { title: `想和 ${chat.displayName} 聊聊`, body: <ChatView model={chat} /> });
  });
}
