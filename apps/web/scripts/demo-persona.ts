/** 仅供演示种子初始化；通过真实资料仓储保存，不在登录或读取页面时补回。 */
import { generateId } from '@nowme/contracts';
import { loadSceneGuide } from '@nowme/skill';
import type { AppDeps } from '../src/context.js';
import type { ProfileCategory } from '../src/db/hosted.js';
import type { Wall } from '../src/db/walls.js';
import { briefOutputSchema, renderBriefMarkdown, toStructuredBrief, type InterviewAnswers } from '../src/hosted/brief.js';
import { DEMO_TEST_IDENTITY, DEMO_TEST_NAME, type DemoProfile } from './demo-content.js';

export const DEMO_TEST_PROFILE: readonly { category: ProfileCategory; text: string }[] = [
  { category: 'fact', text: `我叫${DEMO_TEST_NAME}，${DEMO_TEST_IDENTITY}` },
  { category: 'fact', text: '会用 Figma 和 TypeScript 做交互原型，做过一个把群聊活动整理成日历的小工具。' },
  { category: 'fact', text: '周末会用手机拍街道光影，也在写一本关于第一次独立生活的小册子。' },
  { category: 'quote', text: '先做一个周末能试的小东西，再听听别人怎么说。' },
  { category: 'preference', text: '喜欢自然、具体的自我介绍，先从作品和共同兴趣聊起，不用夸张的能力标签。' },
  { category: 'preference', text: '喜欢有树荫和休息点的轻徒步，按最慢伙伴的步调走，不临时增加里程。' },
  { category: 'boundary', text: '不公开具体学校、住址、手机号和日常通勤时间；先在墙内聊天，熟悉后再交换联系方式。' },
  { category: 'boundary', text: '不使用本人正脸照片，不编造比赛奖项、实习公司或专业摄影师经历。' },
];

export interface DemoPersonalPage {
  wall: Wall;
  pageId: string;
  profile: DemoProfile;
}

export function seedDemoPersonalData(deps: Pick<AppDeps, 'repos' | 'now'>, userId: string, pages: readonly DemoPersonalPage[]): void {
  const now = deps.now().toISOString();
  for (const entry of DEMO_TEST_PROFILE) {
    deps.repos.profileEntries.insert({
      id: generateId('pfe'), userId, ...entry, source: 'interview', confirmation: 'owner-stated', createdAt: now, updatedAt: now,
    });
  }
  for (const { wall, pageId, profile } of pages) {
    const answers: InterviewAnswers = {
      material: `${DEMO_TEST_IDENTITY}\n${profile.about}\n${profile.work}\n我可以${profile.offering}，想${profile.looking}。`,
      choices: {}, styles: [], motion: 'calm',
    };
    const output = briefOutputSchema.parse({
      displayName: DEMO_TEST_NAME, firstScreen: `${profile.role}：${profile.headline}`,
      suggestedBlocks: ['hero', 'about', 'work', 'together'],
      facts: [
        { text: DEMO_TEST_PROFILE[0]!.text, source: 'profile' },
        { text: profile.about, source: 'interview' },
        { text: profile.work, source: 'interview' },
      ],
      quotes: [DEMO_TEST_PROFILE.find((entry) => entry.category === 'quote')!.text],
      highlights: [profile.work, profile.offering], intentAspect: profile.role, intentRemember: profile.looking,
      tone: '自然、具体，像向刚认识的伙伴介绍自己', otherPreferences: '留白清楚，文字易读，安静的动效',
      boundaries: {
        name: DEMO_TEST_NAME, school: '不显示', gradeMajor: '显示', photo: '不可以',
        hidden: ['具体学校、住址、手机号和日常通勤时间'], rejected: ['正脸照片', '编造奖项或实习经历'],
      },
      unknowns: ['具体学校名称', '手机号', '住址'],
      hooks: [
        { text: profile.offering, opener: `${DEMO_TEST_NAME}你好，我想听你聊聊${profile.offering}。` },
        { text: profile.looking, opener: `${DEMO_TEST_NAME}你好，我也对这个活动感兴趣，一起从哪里开始？` },
      ],
      aiView: [profile.about, profile.work, `你希望从“${profile.looking}”开始认识步调相近的人。`],
    });
    const brief = { ...toStructuredBrief(output, answers), confirmedAt: now };
    deps.repos.briefs.insert({
      id: generateId('brf'), pageId, ownerId: userId, status: 'confirmed', answersJson: JSON.stringify(answers),
      followupsJson: null, briefJson: JSON.stringify(brief), briefMd: renderBriefMarkdown(brief, wall, loadSceneGuide(wall.sceneType)),
      confirmedAt: now, createdAt: now, updatedAt: now,
    });
  }
}
