/**
 * 演示墙的第二批人物：四面墙各把人数扩到原来的两倍（黑客松 8→16、摄影社 6→12、AI 共创与山野轻徒步 10→20）。
 *
 * 每位新增成员都有一页独立设计的页面，放在 `demo-more/<dir>/`（`index.html`、`card.json`、`manifest.json`），
 * 由维护者按人物设定逐页手写，人物均为虚构。种子与复用启动都调用 `ensureDemoWallAdditions`：
 * 只给还没有任何版本的成员走真实提交管线（校验 + 渲染）并发布，绝不覆盖已有版本。
 */
import { fileURLToPath } from 'node:url';

export const DEMO_MORE_DIR = fileURLToPath(new URL('./demo-more/', import.meta.url));

export type DemoAdditionWall = 'hackathon' | 'club' | 'ai' | 'trail';

export interface DemoAddition {
  wall: DemoAdditionWall;
  /** demo-more/ 下的目录名，也是 card.json 之外唯一需要和人物对上的标识。 */
  dir: string;
  email: string;
  name: string;
  contactPublic: boolean;
  /** 黑客松墙的两道必答题（demo-organizer.ts）；不给就不答。 */
  answers?: readonly [string, readonly string[]];
}

const at = (local: string) => `${local}@demo.nowme.test`;

export const DEMO_ADDITIONS: readonly DemoAddition[] = [
  // NOWMe 演示黑客松：+8
  { wall: 'hackathon', dir: 'hack-yezhiqiu', email: at('hack-01'), name: '叶知秋', contactPublic: true, answers: ['开发', ['周六白天', '周六通宵']] },
  { wall: 'hackathon', dir: 'hack-bailu', email: at('hack-02'), name: '白露', contactPublic: false, answers: ['产品', ['周六白天', '周日白天']] },
  { wall: 'hackathon', dir: 'hack-mengchuan', email: at('hack-03'), name: '孟川', contactPublic: true, answers: ['开发', ['周六通宵', '周日白天']] },
  { wall: 'hackathon', dir: 'hack-tangxiaoguo', email: at('hack-04'), name: '唐小果', contactPublic: false, answers: ['设计', ['周六白天', '周六通宵', '周日白天']] },
  { wall: 'hackathon', dir: 'hack-qixia', email: at('hack-05'), name: '齐夏', contactPublic: true, answers: ['开发', ['周六白天', '周日白天']] },
  { wall: 'hackathon', dir: 'hack-ouyangle', email: at('hack-06'), name: '欧阳乐', contactPublic: true, answers: ['都能来一点', ['周六白天', '周六通宵', '周日白天']] },
  { wall: 'hackathon', dir: 'hack-qinwan', email: at('hack-07'), name: '秦宛', contactPublic: false },
  { wall: 'hackathon', dir: 'hack-duheng', email: at('hack-08'), name: '杜衡', contactPublic: true, answers: ['开发', ['周六通宵', '周日白天']] },
  // 山海摄影社 · 2026 秋季招新：+6
  { wall: 'club', dir: 'club-taoran', email: at('club-01'), name: '陶然', contactPublic: false },
  { wall: 'club', dir: 'club-ningyuan', email: at('club-02'), name: '宁远', contactPublic: true },
  { wall: 'club', dir: 'club-keke', email: at('club-03'), name: '柯柯', contactPublic: false },
  { wall: 'club', dir: 'club-liming', email: at('club-04'), name: '黎明', contactPublic: true },
  { wall: 'club', dir: 'club-xuduo', email: at('club-05'), name: '许多', contactPublic: false },
  { wall: 'club', dir: 'club-luyifan', email: at('club-06'), name: '卢一帆', contactPublic: true },
  // AI 共创实验室 · 周末造点东西：+10
  { wall: 'ai', dir: 'ai-linjian', email: at('ai-10'), name: '林间', contactPublic: true },
  { wall: 'ai', dir: 'ai-sumo', email: at('ai-11'), name: '苏墨', contactPublic: false },
  { wall: 'ai', dir: 'ai-baige', email: at('ai-12'), name: '白鸽', contactPublic: true },
  { wall: 'ai', dir: 'ai-chengxiaoman', email: at('ai-13'), name: '程小满', contactPublic: true },
  { wall: 'ai', dir: 'ai-hanxiao', email: at('ai-14'), name: '韩笑', contactPublic: false },
  { wall: 'ai', dir: 'ai-fangyuan', email: at('ai-15'), name: '方圆', contactPublic: true },
  { wall: 'ai', dir: 'ai-yexiaozhou', email: at('ai-16'), name: '叶小舟', contactPublic: false },
  { wall: 'ai', dir: 'ai-luolan', email: at('ai-17'), name: '罗兰', contactPublic: true },
  { wall: 'ai', dir: 'ai-jibai', email: at('ai-18'), name: '季白', contactPublic: false },
  { wall: 'ai', dir: 'ai-xiatian', email: at('ai-19'), name: '夏天', contactPublic: true },
  // 山野轻徒步 · 一起去透气：+10
  { wall: 'trail', dir: 'trail-linxiaoxi', email: at('trail-10'), name: '林小溪', contactPublic: true },
  { wall: 'trail', dir: 'trail-shitou', email: at('trail-11'), name: '石头', contactPublic: false },
  { wall: 'trail', dir: 'trail-ouyangchen', email: at('trail-12'), name: '欧阳晨', contactPublic: true },
  { wall: 'trail', dir: 'trail-chenyiwei', email: at('trail-13'), name: '陈一苇', contactPublic: false },
  { wall: 'trail', dir: 'trail-yuanye', email: at('trail-14'), name: '袁野', contactPublic: true },
  { wall: 'trail', dir: 'trail-muzi', email: at('trail-15'), name: '木子', contactPublic: true },
  { wall: 'trail', dir: 'trail-guyu', email: at('trail-16'), name: '谷雨', contactPublic: false },
  { wall: 'trail', dir: 'trail-ajie', email: at('trail-17'), name: '阿杰', contactPublic: true },
  { wall: 'trail', dir: 'trail-songxiaobai', email: at('trail-18'), name: '宋小白', contactPublic: false },
  { wall: 'trail', dir: 'trail-hexi', email: at('trail-19'), name: '何夕', contactPublic: true },
];
