/**
 * 演示用的组织者工具数据（contracts 19）：黑客松墙预置两道必答题、成员的回答和一份墙的群像，
 * 打开墙和后台就能看到“按回答筛选”“完成度”“群像”，不需要现场调用模型。
 *
 * - 题目与回答走真实的服务（saveQuestions / saveAnswers）。周一鸣故意不答：后台“还没答完”里有人，可以演示提醒。
 * - 群像是 2026-11-17 在这份种子数据上点“生成群像”、由真实模型写出来后原样保存的文案（种子时不调用模型），
 *   所以界面上“AI 归纳”的说法属实；人物或题目改了要重新生成一次再更新这里。按回答的统计由 questionStats 现算。
 */
import type { AppDeps } from '../src/context.js';
import type { Wall } from '../src/db/walls.js';
import { wallQueries } from '../src/db/wall-queries.js';
import { DEMO_ADDITIONS } from './demo-more.js';
import { answersForWall, questionStats, saveAnswers, saveQuestions } from '../src/services/wall-questions.js';

export const DEMO_QUESTIONS = [
  { prompt: '这次你主要做什么？', kind: 'single', options: ['开发', '设计', '产品', '都能来一点'] },
  { prompt: '周末哪些时段在？', kind: 'multi', options: ['周六白天', '周六通宵', '周日白天'] },
] as const;

/** 按成员邮箱的前缀对应两道题的回答；不在表里的人（周一鸣）不答。 */
export const DEMO_ANSWERS: Readonly<Record<string, readonly [string, readonly string[]]>> = {
  linzhou: ['开发', ['周六白天', '周六通宵', '周日白天']],
  suqing: ['设计', ['周六白天', '周日白天']],
  chengye: ['开发', ['周六通宵', '周日白天']],
  fangtang: ['开发', ['周六白天', '周六通宵']],
  zhuyiyi: ['产品', ['周六白天', '周日白天']],
  organizer: ['都能来一点', ['周六白天', '周六通宵', '周日白天']],
  newbie: ['设计', ['周六白天', '周日白天']],
};

export const DEMO_PORTRAIT = {
  summary: '这面墙上技术、设计、产品各占一角，都在找能熬夜的队友：有人搭后端和模型，有人画原型，有人做硬件小盒子，缺的正好是你。',
  themes: [
    { title: '找视觉/UI 设计', detail: '好几个写完后端和模型的人，界面还空着，就等一位会画会交互的', count: 3 },
    { title: 'AI 小工具点子', detail: '课程通知变待办、录音变卡片、约时间的小助手，都是身边小事', count: 3 },
    { title: '周末通宵赶工', detail: '周六白天到通宵都有人在线，愿意一起熬到周日', count: 3 },
    { title: '找技术队友', detail: '会做访谈和路演的人想配上前端、后端或 AI 的开发', count: 2 },
  ],
} as const;

export function seedDemoOrganizerTools(
  deps: Pick<AppDeps, 'db' | 'repos' | 'now'>,
  wall: Wall,
  people: { organizerId: string; testerId: string; members: readonly { email: string; userId: string }[] },
): void {
  saveQuestions(deps, wall.id, DEMO_QUESTIONS.map((question, index) => ({ id: null, index, prompt: question.prompt, kind: question.kind, options: [...question.options] })));
  const questions = deps.repos.questions.listForWall(wall.id);
  const [role, time] = questions;
  if (!role || !time) throw new Error('演示数据异常：必答题没有保存');
  const users = new Map<string, string>([['organizer', people.organizerId], ['newbie', people.testerId]]);
  for (const member of people.members) users.set(member.email.split('@')[0]!, member.userId);
  for (const [slug, [roleChoice, timeChoices]] of Object.entries(DEMO_ANSWERS)) {
    const userId = users.get(slug);
    if (!userId) throw new Error(`演示数据异常：找不到回答必答题的成员 ${slug}`);
    saveAnswers(deps, wall.id, userId, new Map([[role.id, [roleChoice]], [time.id, [...timeChoices]]]));
  }
  saveDemoAdditionAnswers(deps, wall);
  writeDemoPortrait(deps, wall, people.organizerId);
}

/** 第二批黑客松成员（demo-more.ts）的回答；已经答过的人不覆盖。没有题目时什么也不做。 */
export function saveDemoAdditionAnswers(deps: Pick<AppDeps, 'db' | 'repos' | 'now'>, wall: Wall): void {
  const [role, time] = deps.repos.questions.listForWall(wall.id);
  if (!role || !time) return;
  const answered = new Set((deps.db.prepare('SELECT DISTINCT user_id AS id FROM wall_answers WHERE wall_id = ?').all(wall.id) as { id: string }[]).map((row) => row.id));
  for (const person of DEMO_ADDITIONS) {
    if (person.wall !== 'hackathon' || !person.answers) continue;
    const user = deps.repos.users.findByEmail(person.email);
    if (!user || answered.has(user.id)) continue;
    const [roleChoice, timeChoices] = person.answers;
    saveAnswers(deps, wall.id, user.id, new Map([[role.id, [roleChoice]], [time.id, [...timeChoices]]]));
  }
}

/** 保存的群像文案配上墙上当前的发布与按回答的统计（墙上人变了就重写一次，文案不变）。 */
export function writeDemoPortrait(deps: Pick<AppDeps, 'db' | 'repos' | 'now'>, wall: Wall, organizerId: string): void {
  const questions = deps.repos.questions.listForWall(wall.id);
  if (questions.length === 0) return;
  const entries = wallQueries(deps.db).listPublished(wall.id);
  deps.repos.portraits.replace({
    wallId: wall.id,
    resultJson: JSON.stringify({
      summary: DEMO_PORTRAIT.summary,
      themes: DEMO_PORTRAIT.themes,
      stats: questionStats(questions, answersForWall(deps, wall.id, questions), entries.map((entry) => entry.ownerId)),
    }),
    sources: entries.map((entry) => entry.publicationId),
    pageCount: entries.length,
    createdBy: organizerId,
    createdAt: deps.now().toISOString(),
  });
}
