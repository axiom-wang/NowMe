/**
 * 导出我的数据（contracts 14、S11）：一个 ZIP，内容是用户在界面上本来就能看到、属于他自己的数据。
 *
 * ```
 * README.txt                        说明（中文）
 * data.json                         全部结构化数据（见 AccountExport）
 * avatar.webp                       头像（有的话）
 * pages/<墙 ID>/v<版本号>/...        自己每个仍保留的、通过校验的版本提交的原文件（index.html、card.json、assets/…）
 * interviews/<墙 ID>/<文件名>        采访时自己上传的图片
 * ```
 *
 * 不含：任何令牌 / 凭证 / 会话 / 验证码（明文或哈希）、加密的模型 Key、邀请码、公开链接令牌；
 * 别人的未公开内容（别人的草稿、未发布页面、采访、联系方式）。会话里只有当前仍能在界面上看到的会话给出全部消息，
 * 已经看不到的会话（退出墙、对方离开）只导出自己发的消息；“和 TA 聊什么”只导出当前仍会展示的结果。
 *
 * 页面文件按版本从新到旧放入，总量超过 `EXPORT_PAGE_FILES_MAX_BYTES` 后，更早的版本只给元数据（`files: null`、`filesOmitted: true`）。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePublishedCard as parseCard } from '../db/publications.js';
import type { AppDeps } from '../context.js';
import { accountDataQueries } from '../db/account-data.js';
import type { ModelRole } from '../hosted/user-models.js';
import { readAsset } from '../hosted/assets.js';
import { findPublishedMemberPage } from './access.js';
import { userAccount } from './billing.js';
import { loadIcebreaker } from './icebreaker.js';
import { exportAsks } from './ask.js';
import { exportIntros } from './intro.js';
import { isRevisionDeleted } from './page-lifecycle.js';
import { REVISION_ORIGINAL_DIR, revisionDir } from './revision-storage.js';
import { buildZip, isSafeZipPath, type ZipEntry } from './zip.js';

/** 页面文件的总量上限（未压缩）。 */
export const EXPORT_PAGE_FILES_MAX_BYTES = 120 * 1024 * 1024;
export const EXPORT_FORMAT = 'nowme-export';
export const EXPORT_VERSION = 1;

type ExportDeps = Pick<AppDeps, 'db' | 'repos' | 'config' | 'now' | 'userModels'>;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

async function readTree(root: string, prefix = ''): Promise<{ path: string; data: Uint8Array }[]> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(join(root, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { path: string; data: Uint8Array }[] = [];
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await readTree(root, rel)));
    else if (entry.isFile()) out.push({ path: rel, data: new Uint8Array(await readFile(join(root, rel))) });
  }
  return out;
}

const README = [
  'NOWMe 数据导出',
  '',
  'data.json      你的账号、加入的墙、页面的版本与发布记录、采访资料与 brief、长期画像、“和 TA 聊什么”的结果、聊天消息、点数余额与流水。',
  'avatar.webp    你的头像（设置过才有）。',
  'pages/         你每面墙上页面的各个版本（你或你的 Agent 提交的原文件），按“墙 ID/版本号”分目录。',
  'interviews/    在应用内采访时你上传的图片。',
  '',
  '这里只有属于你自己的内容；不包含登录凭证、Agent 指令、模型 Key 等任何密钥，也不包含别人没有公开的内容。',
  '',
].join('\n');

/** 生成导出文件。`userId` 必须是当前会话的用户。 */
export async function buildAccountExport(deps: ExportDeps, userId: string): Promise<{ fileName: string; zip: Uint8Array } | null> {
  const { repos } = deps;
  const user = repos.users.findById(userId);
  if (!user || user.deletedAt) return null;
  const queries = accountDataQueries(deps.db);
  const now = deps.now();
  const files: ZipEntry[] = [{ path: 'README.txt', data: new TextEncoder().encode(README) }];

  const avatar = repos.users.avatarForUser(userId);
  if (avatar) files.push({ path: 'avatar.webp', data: new Uint8Array(avatar) });

  const briefs = queries.briefs(userId);
  const assets = queries.assets(userId);
  const jobs = queries.jobs(userId);
  let budget = EXPORT_PAGE_FILES_MAX_BYTES;

  const walls = [];
  for (const { membership, wall, pageId } of repos.memberships.listAllForUser(userId)) {
    const page = pageId ? repos.pages.findById(pageId) : null;
    let pageData: Record<string, unknown> | null = null;
    if (page && page.ownerId === userId) {
      const numberOf = new Map<string, number>();
      const revisions = [];
      for (const revision of repos.revisions.listForPage(page.id)) {
        numberOf.set(revision.id, revision.number);
        const deleted = isRevisionDeleted(revision);
        let filesPath: string | null = null;
        let filesOmitted = false;
        if (!deleted && revision.status === 'accepted') {
          const tree = await readTree(join(revisionDir(deps.config.dataDir, revision.id), REVISION_ORIGINAL_DIR));
          const size = tree.reduce((sum, file) => sum + file.data.byteLength, 0);
          const base = `pages/${wall.id}/v${revision.number}`;
          if (size <= budget && tree.every((file) => isSafeZipPath(`${base}/${file.path}`))) {
            budget -= size;
            filesPath = tree.length > 0 ? `${base}/` : null;
            for (const file of tree) files.push({ path: `${base}/${file.path}`, data: file.data });
          } else if (tree.length > 0) {
            filesOmitted = true;
          }
        }
        revisions.push({
          number: revision.number,
          source: revision.source,
          status: revision.status,
          createdAt: revision.createdAt,
          deleted,
          report: deleted ? null : { ok: revision.report.ok, errors: revision.report.errors, warnings: revision.report.warnings },
          card: deleted ? null : parseJson(revision.cardJson),
          files: filesPath,
          ...(filesOmitted ? { filesOmitted: true } : {}),
        });
      }
      const publications = queries.publications(page.id).map((publication) => {
        const card = parseCard(publication.cardJson);
        return {
          revisionNumber: numberOf.get(publication.revisionId) ?? null,
          card,
          contact: parseJson(publication.contactJson),
          publishedAt: publication.publishedAt,
          endedAt: publication.endedAt,
          endReason: publication.endReason,
          ...(card ? {} : { deleted: true }),
        };
      });
      const brief = briefs.find((row) => row.pageId === page.id) ?? null;
      const images = [];
      for (const asset of assets.filter((row) => row.pageId === page.id)) {
        const path = `interviews/${wall.id}/${asset.fileName}`;
        try {
          files.push({ path, data: await readAsset(deps.config.dataDir, page.id, asset.fileName) });
          images.push({ file: path, mime: asset.mime, uploadedAt: asset.createdAt });
        } catch {
          images.push({ file: null, mime: asset.mime, uploadedAt: asset.createdAt });
        }
      }
      pageData = {
        id: page.id,
        createdAt: page.createdAt,
        contact: page.contactChannel || page.contactValue ? { channel: page.contactChannel, value: page.contactValue, public: page.contactPublic } : null,
        publicLinkOn: page.publicToken !== null,
        revisions: revisions.reverse(),
        publications,
        interview: brief
          ? {
              status: brief.status,
              answers: parseJson(brief.answersJson),
              followups: parseJson(brief.followupsJson),
              brief: parseJson(brief.briefJson),
              briefMarkdown: brief.briefMd,
              confirmedAt: brief.confirmedAt,
              createdAt: brief.createdAt,
              updatedAt: brief.updatedAt,
              images,
            }
          : null,
        aiJobs: jobs
          .filter((job) => job.pageId === page.id)
          .map((job) => ({
            kind: job.kind,
            status: job.status,
            request: job.requestText,
            resultMessage: job.resultMessage,
            errorCode: job.errorCode,
            revisionNumber: job.revisionId ? (numberOf.get(job.revisionId) ?? null) : null,
            createdAt: job.createdAt,
            finishedAt: job.finishedAt,
          })),
      };
    }
    walls.push({
      wall: {
        id: wall.id,
        name: wall.name,
        description: wall.description,
        sceneType: wall.sceneType,
        organizerNote: wall.organizerNote,
        status: wall.status,
        closedAt: wall.closedAt,
      },
      membership: { role: membership.role, status: membership.status, joinedAt: membership.joinedAt, endedAt: membership.endedAt },
      page: pageData,
    });
  }

  // 会话：仍能看到的给全部消息，看不到的只给自己发的
  const wallNames = new Map(walls.map((item) => [item.wall.id, item.wall.name]));
  const conversations = queries.conversations(userId).map((conversation) => {
    const visible = repos.chat.findVisible(conversation.id, userId) !== null;
    const peer = conversation.peerId && visible ? repos.users.findById(conversation.peerId) : null;
    const messages = queries.messages(conversation.id, visible ? null : userId).map((message) => ({
      at: message.createdAt,
      from: message.senderId === userId ? '我' : message.senderName,
      mine: message.senderId === userId,
      text: message.text,
    }));
    return {
      wallId: conversation.wallId,
      wallName: wallNames.get(conversation.wallId) ?? null,
      kind: conversation.kind,
      with: conversation.kind === 'direct' ? (peer?.nickname ?? null) : null,
      stillVisible: visible,
      messages,
    };
  }).filter((conversation) => conversation.messages.length > 0 || conversation.stillVisible);

  // “和 TA 聊什么”：只导出当前仍会展示给他的结果（对方仍在墙上、发布没变）
  const icebreakers = [];
  for (const row of queries.icebreakers(userId)) {
    const found = findPublishedMemberPage(deps, userId, row.wallId, row.pageId);
    if (!found || !loadIcebreaker(deps, found, userId)) continue;
    icebreakers.push({
      wallId: row.wallId,
      wallName: found.wall.name,
      about: parseCard(found.entry.cardJson)?.displayName ?? null,
      createdAt: row.createdAt,
      result: parseJson(row.resultJson),
    });
  }

  const aiSettings = (['interview', 'generate'] as ModelRole[]).flatMap((role) => {
    const summary = deps.userModels.summary(userId, role);
    if (!summary) return [];
    const { provider, baseUrl, model, vision } = summary.endpoint;
    return [{ role, provider, baseUrl, model, vision, hasKey: summary.hasKey }];
  });

  const data = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    account: { id: user.id, email: user.email, nickname: user.nickname, createdAt: user.createdAt, avatar: avatar ? 'avatar.webp' : null },
    walls,
    profile: repos.profileEntries.listForUser(userId).map((entry) => ({
      category: entry.category,
      text: entry.text,
      source: entry.source,
      confirmation: entry.confirmation,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
    icebreakers,
    // AI 介绍给他的人（contracts 20）
    intros: exportIntros(deps, userId),
    // 问墙：最近一次提问与找到的人（contracts 21）
    asks: exportAsks(deps, userId),
    // 必答题的回答（contracts 19.1）
    wallAnswers: repos.questions.allAnswersOfUser(userId).map((answer) => ({ ...answer, wallName: wallNames.get(answer.wallId) ?? null })),
    receivesReminderEmails: repos.reminders.acceptsReminders(userId),
    conversations,
    blocked: repos.moderation.listBlockedBy(userId).map((row) => ({ nickname: row.nickname, since: row.blockedAt })),
    reportsFiled: queries.reportsFiled(userId).map((report) => ({ ...report, wallName: wallNames.get(report.wallId) ?? null })),
    credits: { balance: repos.credits.balanceOf(userAccount(userId)), entries: queries.creditEntries(userId) },
    aiSettings,
  };
  files.splice(1, 0, { path: 'data.json', data: new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`) });
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  return { fileName: `nowme-export-${day}.zip`, zip: buildZip(files, now) };
}
