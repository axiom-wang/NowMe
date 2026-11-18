# 7. 场景指南配置（`skill/scenes/<sceneType>.json`）

每个场景一份，主站与 Skill 读取同一份文件（主站只用 `id`、`label`、`defaults.contactPublic`、`hookKinds`）。

```ts
interface SceneGuide {
  quickQuestions: { id: string; question: string; options: string[] }[]; // 0–4 道，每道 2 或 4 个完整原话选项
  sentenceStarters: string[]; // 0–3 个填空句开头
  id: SceneType; label: string; goal: string; interviewBudgetSeconds: number;
  assetPrompt: string;
  choiceQuestions: { id: string; question: string; options: string[]; multi: boolean; required: boolean }[];
  followUps: { direction: string; examples: string[] }[]; maxFollowUps: number;
  mustHave: { id: string; description: string }[];
  hookKinds: { kind: string; pattern: string }[];
  defaults: { showSchool: boolean; useNickname: boolean; contactPublic: boolean };
  pageGoal: string; suggestedBlocks: string[]; visualTone: string;
  examples: string[];            // skill/examples/ 下的目录名
}
```

内容取自[信息收集与 brief](../brief-collection.md)第 4 节与[页面生成方案](../page-generation-byo-agent.md)第 3 节。
