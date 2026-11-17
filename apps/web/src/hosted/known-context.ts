/** 只取主人确认过且适用于当前场景的资料；预填不作语义推断。 */
import type { SceneGuide } from '@nowme/contracts';
import type { AppDeps } from '../context.js';
import type { ProfileEntry } from '../db/hosted.js';
import type { OwnPage } from '../services/access.js';
import { loadPortrait } from '../services/portrait.js';
import { choiceLabel, type InterviewAnswers } from './brief.js';

export function relevantProfile(entries: ProfileEntry[], scene: string, wallId: string): ProfileEntry[] {
  return entries.filter((e) => !e.scope || e.scope === 'all' || e.scope === scene || e.scope === `wall:${wallId}`)
    .sort((a, b) => Number(b.scope === scene || b.scope === `wall:${wallId}`) - Number(a.scope === scene || a.scope === `wall:${wallId}`) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 16);
}

// 匹配只决定在哪里展示已有原文，不从关键词推导能力、角色或当前意图。
const QUESTION_TOPICS: Record<string, RegExp> = {
  skills: /技能|擅长|拿手|会做什么|技术栈/i,
  role: /担任.*角色|主要.*角色|分工/,
  teammate: /队友|组队.*找|找.*伙伴/,
  direction: /项目方向|想做.*方向|想解决.*问题/,
  'grade-major': /年级|专业/,
  'outside-hobby': /爱好|兴趣|最近.*玩/,
  tenure: /入坑多久|玩了多久|接触.*多久/,
  'looking-for': /希望.*认识|想认识.*人/,
};

function profileAnswersQuestion(entry: ProfileEntry, questionId: string): boolean {
  if (entry.category !== 'fact' && entry.category !== 'quote') return false;
  if (questionId === 'skills') {
    // “想找会前端的队友”不是自己的技能；保留“不擅长”等否定，不改成肯定选项。
    return !/想找|寻找|队友|希望认识/.test(entry.text)
      && /前端|后端|全栈|小程序|编程|设计|硬件|嵌入式|数据分析|typescript|python|react|vue|figma|sql/i.test(entry.text);
  }
  if (questionId === 'outside-hobby') return /喜欢|爱好|兴趣|沉迷|收藏|周末.*(?:玩|拍|做|看|去)/.test(entry.text);
  if (questionId === 'grade-major') return /大[一二三四五]|研[一二三]|博士|本科|研究生|专业|年级/.test(entry.text);
  // “这次的角色 / 找谁 / 想做什么”不从其他墙的旧画像推断。
  return false;
}

export function knownContext(repos: AppDeps['repos'], own: OwnPage, userId: string, scene: SceneGuide) {
  const profile = relevantProfile(repos.profileEntries.listForUser(userId), scene.id, own.wall.id);
  const stored = repos.questions.answersForUser(own.wall.id, userId);
  const knownAnswers = repos.questions.listForWall(own.wall.id).map((q) => ({
    question: q.prompt, answers: (stored.find((a) => a.questionId === q.id)?.choices ?? []).filter((a) => q.options.includes(a)),
  })).filter((q) => q.answers.length > 0);
  const nickname = repos.users.findById(userId)?.nickname;
  const choices: InterviewAnswers['choices'] = {};
  for (const question of scene.choiceQuestions) {
    // 隐私边界在确认页明确确认；不从自由文本猜测或跨场景推广。
    if (question.id === 'boundaries') continue;
    const matchingAnswers = knownAnswers.filter((a) => a.question === question.question || QUESTION_TOPICS[question.id]?.test(a.question));
    const values = matchingAnswers.filter((a) => a.question === question.question).flatMap((a) => a.answers);
    const entries = profile.filter((e) => e.questionKey === `${scene.id}:${question.id}` || profileAnswersQuestion(e, question.id));
    const selected = question.options.map(choiceLabel).filter((option) => values.includes(option) || entries.some((e) => e.text === option));
    const text = [...new Set([...entries.filter((e) => !selected.includes(e.text)).map((e) => e.text), ...matchingAnswers.filter((a) => a.question !== question.question).map((a) => `${a.question}：${a.answers.join('、')}`)])].join('；');
    if (selected.length || text) choices[question.id] = { selected: question.multi ? selected : selected.slice(0, 1), text };
  }
  const facts = profile.filter((p) => p.category === 'fact' || p.category === 'quote');
  const fast = facts.length >= 3 && facts.reduce((n, p) => n + p.text.length, 0) >= 40;
  const portrait = loadPortrait({ repos }, own.wall.id);
  const topics = portrait.kind === 'ready' ? portrait.view.themes.map((theme) => theme.title).slice(0, 4) : [];
  return { profile, knownAnswers, choices, fast, topics, nickname };
}
export type KnownContext = ReturnType<typeof knownContext>;
