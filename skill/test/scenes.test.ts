import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCENE_TYPES, sceneGuideSchema } from '@nowme/contracts';
import { EXAMPLES_DIR, loadExamplesIndex, loadSceneGuide, loadSceneGuides, SCENES_DIR } from '../src/index.js';

describe('场景指南 scenes/<sceneType>.json（contracts 7）', () => {
  it.each(SCENE_TYPES)('%s 通过 sceneGuideSchema，id 与文件名一致', (type) => {
    const raw: unknown = JSON.parse(readFileSync(join(SCENES_DIR, `${type}.json`), 'utf8'));
    const result = sceneGuideSchema.safeParse(raw);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    expect(loadSceneGuide(type).id).toBe(type);
  });

  it('四个场景都能一次读出', () => {
    expect(Object.keys(loadSceneGuides()).sort()).toEqual([...SCENE_TYPES].sort());
  });

  it.each(SCENE_TYPES)('%s 引用的示例目录都存在且列在 examples/index.json 里', (type) => {
    const guide = loadSceneGuide(type);
    const indexed = new Set(loadExamplesIndex().examples.map((item) => item.dir));
    expect(guide.examples.length).toBeGreaterThan(0);
    for (const dir of guide.examples) {
      expect(existsSync(join(EXAMPLES_DIR, dir, 'index.html')), dir).toBe(true);
      expect(indexed.has(dir), dir).toBe(true);
    }
  });

  it.each(['hackathon', 'interest', 'club'] as const)('%s 引用的示例都是同一场景的', (type) => {
    const byDir = new Map(loadExamplesIndex().examples.map((item) => [item.dir, item.sceneType]));
    for (const dir of loadSceneGuide(type).examples) expect(byDir.get(dir)).toBe(type);
  });

  it.each(SCENE_TYPES)('%s 有边界多选题，且 mustHave、hookKinds、建议区块不为空', (type) => {
    const guide = loadSceneGuide(type);
    const boundaries = guide.choiceQuestions.find((question) => question.id === 'boundaries');
    expect(boundaries?.multi).toBe(true);
    expect(boundaries?.required).toBe(false);
    expect(guide.mustHave.length).toBeGreaterThan(0);
    expect(guide.hookKinds.length).toBeGreaterThanOrEqual(2);
    expect(guide.suggestedBlocks.length).toBeGreaterThanOrEqual(3);
    expect(guide.followUps.length).toBeGreaterThanOrEqual(guide.maxFollowUps > 0 ? 1 : 0);
    for (const question of guide.choiceQuestions) {
      if (question.required) expect(question.question, question.id).toMatch(/【(必答|重要|先选这个)】/);
    }
  });

  describe('黑客松（11 月试跑场景）', () => {
    const guide = loadSceneGuide('hackathon');

    it('约 90 秒；“想找什么样的队友”是唯一必答题；追问最多 1 个', () => {
      expect(guide.interviewBudgetSeconds).toBe(90);
      expect(guide.choiceQuestions.filter((question) => question.required).map((question) => question.id)).toEqual(['teammate']);
      expect(guide.maxFollowUps).toBe(1);
    });

    it('生成前必须有：角色、技能、想找的队友、项目或想法', () => {
      expect(guide.mustHave.map((item) => item.id)).toEqual(['role', 'skill', 'teammate', 'project-or-idea']);
    });

    it('默认显示学校、联系方式默认公开；接话点类型是“我能帮你 / 找队友 / 我想做”', () => {
      expect(guide.defaults).toEqual({ showSchool: true, useNickname: false, contactPublic: true });
      expect(guide.hookKinds.map((item) => item.kind)).toEqual(['can-help', 'looking-for', 'want-to-build']);
    });

    it('写明页面不能联网、demo 只能截图或外链', () => {
      expect(guide.visualTone).toMatch(/不能联网/);
      expect(guide.visualTone).toMatch(/data-nm-href/);
    });
  });

  it('兴趣社群：用昵称、不显示学校、联系方式默认不公开；作品是视觉主角', () => {
    const guide = loadSceneGuide('interest');
    expect(guide.defaults).toEqual({ showSchool: false, useNickname: true, contactPublic: false });
    expect(guide.pageGoal).toMatch(/视觉主角/);
  });

  it('社团：先分新老成员；联系方式默认不公开；接话点有“可以来问我”', () => {
    const guide = loadSceneGuide('club');
    expect(guide.choiceQuestions[0]?.id).toBe('member-type');
    expect(guide.choiceQuestions[0]?.required).toBe(true);
    expect(guide.defaults.contactPublic).toBe(false);
    expect(guide.hookKinds.map((item) => item.kind)).toContain('ask-me');
  });

  it('通用：必须有 3 个具体事实 + 1 个本页意图', () => {
    const guide = loadSceneGuide('general');
    expect(guide.mustHave.map((item) => item.id)).toEqual(['facts', 'intent']);
  });
});
