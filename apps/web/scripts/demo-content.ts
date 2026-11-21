/** 黑客松演示用虚构人物；每面新墙含组织者在内恰好 10 人。 */
import { cardSchema, manifestSchema, type SceneType } from '@nowme/contracts';
import { designDemoAiProfile } from './demo-ai/index.js';
import { designDemoTrailProfile } from './demo-trail/index.js';

export interface DemoProfile {
  name: string;
  role: string;
  headline: string;
  about: string;
  work: string;
  offering: string;
  looking: string;
  tags: string[];
}

function person(name: string, role: string, headline: string, about: string, work: string, offering: string, looking: string, tags: string[]): DemoProfile {
  return { name, role, headline, about, work, offering, looking, tags };
}

export interface DemoWallPlan {
  slug: string;
  name: string;
  sceneType: SceneType;
  description: string;
  note: string;
  theme: 'lab' | 'city' | 'studio' | 'trail';
  colors: readonly string[];
  profiles: readonly DemoProfile[];
}

export const DEMO_TEST_EMAIL = 'newbie@demo.nowme.test';
export const DEMO_TEST_NAME = '江予安';
export const DEMO_TEST_IDENTITY = '22 岁，数字媒体专业大四学生，喜欢做 AI 小工具，也喜欢城市摄影、写作和轻徒步。';

export const DEMO_EXTRA_WALLS: readonly DemoWallPlan[] = [
  {
    slug: 'ai', name: 'AI 共创实验室 · 周末造点东西', sceneType: 'hackathon', theme: 'lab',
    description: '10 个好奇的人，把脑洞变成能玩的原型。有人写代码，有人做设计，也有人带着一个值得解决的小问题来。',
    note: '说说你能做什么，也说说你想找谁。周末见到能跑的 Demo。',
    colors: ['#c8f560', '#83d5ff', '#ffbd87', '#e7b0ff', '#96ecc9'],
    profiles: [
      person(DEMO_TEST_NAME, '数字媒体大四 / 产品探索者', '让灵感，在周末发生', `${DEMO_TEST_IDENTITY}喜欢把一句“要是能这样就好了”，拆成周末就能试的小实验。比起宏大计划，更期待第一次有人说好用。`, '做过一个把群聊里的活动自动整理成日历的小工具，这次想把它带到线下试试。', '一起梳理产品最小闭环', '找人做一个活动整理助手', ['产品', 'AI 工具', '快速原型']),
      person('许知远', '后端开发 / 检索爱好者', '把散落的知识，接起来', '写 Python 和检索系统，最近在研究怎样让回答附上真正有用的出处。咖啡很淡，日志很详细。', '给实验室做了一个论文问答原型，支持按段落找引用，最想听非技术同学的使用反馈。', '帮你接通检索与模型 API', '找设计伙伴打磨论文问答', ['Python', '知识检索', '开源']),
      person('唐可', '交互设计师', '先画出那个“啊哈”时刻', '做界面之前，习惯先问一遍用户今天到底被什么卡住。随身带方格本，能把讨论迅速画成能点的东西。', '把志愿者报名流程从七步改成三步；最近想给 AI 工具做一次真正面向新手的引导。', '把点子画成交互原型', '一起做新手友好的 AI 界面', ['交互设计', '用户访谈', '原型']),
      person('周野', '前端开发', '小交互，也有大情绪', '喜欢有一点惊喜但不打扰人的网页。白天写 TypeScript，晚上拆解滚动、排版和动效。', '做了一个用声音记录一天心情的网页，正在补键盘操作与减少动效模式。', '一起搭好响应式前端', '找人合作声音日记网页', ['TypeScript', '动效', '无障碍']),
      person('顾言', '数据分析 / 可视化', '给数字，一个好懂的形状', '在表格里找线索，再把线索画出来。喜欢能被普通人读懂的小图，不迷恋复杂仪表盘。', '把食堂排队记录画成了时段热力图，下一步想试试从自然语言生成小型数据故事。', '把你的数据画成图', '一起做食堂排队预测', ['数据分析', '可视化', '生活观察']),
      person('宋雨', '移动端开发', '把好点子，装进口袋', '写 Swift，也做跨端原型。想让工具在弱网、单手操作和一早没睡醒的时候仍然好用。', '做过离线背词小组件，现在想试试用相机识别植物并留下一句话观察。', '做一个可以上手的手机原型', '找植物观察工具的伙伴', ['移动端', '离线优先', '植物']),
      person('陈默', '硬件玩家', '让屏幕外的世界也能响应', '爱拆东西，也尽量负责装回去。桌上有一盒彩色杜邦线，喜欢把传感器接到日常生活里。', '最近做了一盏提醒久坐的小灯，想让灯光根据房间里的声音慢慢变化。', '帮你把传感器接进原型', '一起做会呼吸的桌面小灯', ['Arduino', '物联网', '桌面装置']),
      person('陆夏', '语言学习 / 提示词实验', '给每次开口，一点勇气', '在学第三门语言，最懂“明明会但不敢说”的感觉。想用有耐心的对话练习代替机械打卡。', '手工整理了二十个旅行口语情境，正在找人把它变成可以反复练习的互动故事。', '设计自然的对话情境', '找语音开发一起练口语', ['语言学习', '对话设计', '语音']),
      person('何一', '游戏策划', '让第一次尝试，就想再来一局', '喜欢把规则设计得简单，把可能性留得很大。包里总有一副卡牌，欢迎一起测一个十分钟的小游戏。', '做了一款合作解谜纸牌，想试试让 AI 扮演会记住玩家选择的线索提供者。', '一起设计轻量游戏机制', '找人做 AI 合作解谜', ['游戏设计', '叙事', '桌游']),
      person('沈鹿', '测试工程师', '让“能跑”变成“放心玩”', '喜欢问“如果我偏要这么点呢”。愿意做第一个试玩者，也愿意把问题复现步骤写清楚。', '给朋友的报名工具测出过重复提交问题，现在在做一套方便小团队复用的验收清单。', '帮你的 Demo 跑一轮验收', '找一个原型一起做体验测试', ['测试', '体验反馈', '质量']),
    ],
  },
  {
    slug: 'trail', name: '山野轻徒步 · 一起去透气', sceneType: 'club', theme: 'trail',
    description: '不拼配速，不赶路。找几位步调相近的人，从公园绿道走到山脚，在自然里吃顿简单的午饭。',
    note: '路线、时间、天气提前说清楚，照顾彼此的节奏。',
    colors: ['#c8dc8b', '#eed194', '#aacdcd', '#d7bddc', '#c5d3a8'],
    profiles: [
      person(DEMO_TEST_NAME, '轻徒步召集人', '走进山里，给脑袋放个假', `${DEMO_TEST_IDENTITY}平时坐得太久，所以想在周末把步子放慢。喜欢有树荫、能聊天、终点有热汤的路线。`, '整理了一条从公园到山脚的轻松路线，沿途有三个休息点，想先找小队一起探一遍。', '一起整理新手友好的路线', '找步调相近的轻徒步搭子', ['轻徒步', '慢节奏', '热汤']),
      person('江川', '路线规划爱好者', '把路线走熟，把风景留给你', '习惯先查清起终点和交通，不爱临时加量。喜欢在地图上标出可以休息、补水和折返的位置。', '走过几条近郊绿道，最近在整理一份坐公交也能到达的周末路线卡。', '分享近郊公共交通路线卡', '一起走一条有树荫的绿道', ['路线规划', '公共交通', '绿道']),
      person('周晴', '户外新手', '第一次出发，也可以很轻松', '装备还很简单，最想找到可以边走边聊的伙伴。已经从每天晚饭后绕小区一圈开始练习。', '刚完成第一次五公里公园步行，想试试有一点坡但不用赶路的路线。', '交换新手出发前的小问题', '找人一起完成第一次轻徒步', ['户外新手', '慢走', '周末']),
      person('高远', '越野跑 / 慢走也行', '今天不看配速，只看风景', '平时跑步，和朋友出门会主动放慢。很喜欢听大家边走边聊，知道什么时候该停下来吃点东西。', '做过几次小队收尾，记得最清楚的是大家一起看云发呆的休息站。', '一起做队伍的耐心收尾', '找人走一段山脚缓坡', ['越野跑', '收尾', '耐心']),
      person('安宁', '自然笔记', '走慢一点，会看见更多', '喜欢苔藓、叶脉和藏在石缝里的小花。包里有放大镜和铅笔，常常为一片叶子停下来。', '在做近郊植物观察本，每次只认真记录一种植物，不急着把名字全部记住。', '分享自然笔记的小方法', '一起记录一种路边植物', ['自然笔记', '植物', '观察']),
      person('麦子', '户外午餐研究员', '好风景，配一口热乎的', '出门前最认真准备的是午饭。喜欢把三明治包得整齐，也喜欢到休息点再打开保温杯的那一刻。', '试了几种方便携带的冷餐组合，想和搭子交换不怕挤压的午餐点子。', '交换便携午餐的小点子', '找人一起带饭去看风景', ['午餐', '保温杯', '野餐']),
      person('赵森', '山野摄影', '把远处的山，装进口袋', '拍照不想影响行程，所以常用一支轻镜头。喜欢山路的层次，也愿意给同行的人留一张自然的照片。', '正在整理一组雾里的树，不追求壮观，想拍出安静走在路上的感觉。', '帮同行伙伴拍一张自然照', '一起拍山路上的光影', ['摄影', '轻装备', '山路']),
      person('小雨', '慢速观鸟', '听到鸟叫，先停十秒', '刚开始练习用耳朵认鸟，常常判断错，但很享受大家一起查资料的过程。带一副轻便望远镜。', '在公园记录过白鹭和乌鸫，想试试清晨沿着溪边走，看看有什么新发现。', '一起试试用耳朵认鸟', '找人清晨走一段溪边', ['观鸟', '清晨', '溪流']),
      person('向晚', '下班后散步派', '从一公里开始，也算出发', '不是运动高手，但很擅长约人准时出门。希望周末的活动既能透气，也能留时间回家休息。', '给自己定了每周两次饭后散步，已经坚持一个月，最近想走出小区看看。', '一起养成每周散步的小习惯', '找人周末走一小时就好', ['散步', '轻量活动', '规律']),
      person('程橙', '环保志愿者', '带走小垃圾，留下好心情', '每次出门带一个小袋子，顺手收好自己产生的垃圾。喜欢干净安静的休息点，也愿意分享经验。', '参与过两次绿道清洁活动，想做一张简短的出行打包卡，让新手准备更轻松。', '分享轻装出行打包清单', '一起走完也收好自己的垃圾', ['环保', '志愿者', '轻装']),
    ],
  },
];

export function profileEmail(plan: DemoWallPlan, index: number): string {
  return index === 0 ? DEMO_TEST_EMAIL : `${plan.slug}-${String(index).padStart(2, '0')}@demo.nowme.test`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** 独立的人物、接话点、页面与封面；封面由真实渲染管线生成。 */
export function buildDemoProfile(plan: DemoWallPlan, index: number): { displayName: string; files: Record<string, string> } {
  const p = plan.profiles[index];
  if (!p) throw new Error(`演示人物不存在：${plan.slug}/${index}`);
  const h = escapeHtml;
  const fontId = plan.theme === 'city' || plan.theme === 'studio' ? 'noto-serif-sc' : 'noto-sans-sc';
  const card = cardSchema.parse({
    schemaVersion: 1, displayName: p.name, tagline: `${p.role.split(' / ')[0]}，${p.looking}`,
    hooks: [
      { id: 'offer', text: p.offering, opener: `${p.name}你好！在墙上看到你写的“${p.offering}”，我很感兴趣，想听你多讲一点。` },
      { id: 'together', text: p.looking, opener: `${p.name}你好！我也想${p.looking.replace(/^(找人|一起|找.*?伙伴)/, '')}，想和你聊聊怎么一起开始。` },
    ],
  });
  if (plan.slug === 'ai' || plan.slug === 'trail') {
    const trailDesign = plan.slug === 'trail' ? designDemoTrailProfile(p, index) : null;
    const design = trailDesign ?? designDemoAiProfile(p, index);
    const manifest = manifestSchema.parse({
      schemaVersion: 1, sceneType: plan.sceneType, kitVersion: '1', motionLevel: 'calm',
      fonts: design.fonts, extraChars: '', blocks: design.blocks, generator: { agent: 'nowme-demo' },
    });
    const html = `<!doctype html><html lang="zh-CN" data-nm-motion="calm"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(p.name)} · ${h(p.headline)}</title><link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">
<style>${design.css}</style></head><body>${design.body}</body></html>`;
    return { displayName: p.name, files: { ...Object.fromEntries(Object.entries({
      'index.html': html, 'card.json': JSON.stringify(card), 'manifest.json': JSON.stringify(manifest),
    }).map(([path, text]) => [path, Buffer.from(text).toString('base64')])), ...trailDesign?.assets } };
  }
  const manifest = manifestSchema.parse({
    schemaVersion: 1, sceneType: plan.sceneType, kitVersion: '1', motionLevel: 'calm',
    fonts: [{ id: fontId, weights: [400, 700] }],
    extraChars: '', blocks: ['hero', 'about', 'work', 'together'], generator: { agent: 'nowme-demo' },
  });
  const html = `<!doctype html>
<html lang="zh-CN" data-nm-motion="calm"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${h(p.name)} · ${h(p.headline)}</title><link rel="stylesheet" href="/_nowme/kit/v1/nowme.css">
<style>
:root { --accent:${plan.colors[index % plan.colors.length]}; --paper:#f6f0e3; --ink:#292d27; --line:#d4cdbd; --nm-bg:var(--paper); --nm-font-body:var(--nm-font-${fontId}); }
* { box-sizing:border-box; } body { margin:0; color:var(--ink); background:var(--paper); font-family:var(--nm-font-body); font-size:15px; line-height:1.8; }
main { max-width:720px; margin:auto; padding:22px; } p,h1,h2 { margin:0; } .mast { display:flex; justify-content:space-between; gap:12px; border-bottom:1px solid var(--line); padding-bottom:12px; font-size:11px; letter-spacing:.12em; }
.hero { position:relative; padding:26px 0 22px; } .role { font-size:12px; color:var(--accent); font-weight:700; } h1 { position:relative; font-size:48px; line-height:1.2; letter-spacing:-.05em; margin:12px 0; font-weight:700; }
.headline { font-size:24px; line-height:1.5; max-width:17em; } .art { position:relative; height:132px; margin:22px 0; overflow:hidden; border:1px solid var(--line); }
.art span { position:absolute; display:block; width:96px; height:96px; border:1px solid var(--accent); border-radius:50%; left:calc(16% + ${index % 3 * 9}px); top:16px; }
.art span:nth-child(2) { left:36%; background:var(--accent); opacity:.75; }.art span:nth-child(3) { left:56%; border-style:dashed; }
.art b { position:absolute; right:12px; bottom:6px; font-size:11px; font-weight:400; letter-spacing:.14em; } .tags { display:flex; flex-wrap:wrap; gap:6px; }
.tags span { border:1px solid var(--line); border-radius:2px; padding:2px 9px; font-size:11px; } .section { border-top:1px solid var(--line); padding:20px 0; }
.kicker { color:var(--accent); font-size:11px; font-weight:700; margin-bottom:7px; letter-spacing:.08em; } h2 { font-size:20px; margin-bottom:10px; font-weight:700; }
.note { padding:16px; border-left:3px solid var(--accent); background:rgba(128,128,128,.06); } .invite { display:grid; gap:10px; margin-top:12px; }
.invite p { padding:14px; border:1px solid var(--line); } .invite strong { display:block; font-size:11px; color:var(--accent); margin-bottom:4px; } footer { border-top:1px solid var(--line); padding:18px 0 8px; font-size:11px; color:var(--ink); }
.lab { --paper:#172321; --ink:#edf1e7; --line:#43514a; } .lab h1 { color:var(--accent); }
.lab .art { background:repeating-linear-gradient(0deg,transparent,transparent 23px,#33433b 24px),repeating-linear-gradient(90deg,transparent,transparent 23px,#33433b 24px); } .lab .art span { border-radius:${index % 2 ? '8px' : '50%'}; }
.city .art { background:#e7ddc8; border:0; transform:rotate(${index % 2 ? '-1' : '1'}deg); }
.city .art span { border-radius:48% 48% 0 0; top:25px; height:120px; } .city .art span:nth-child(3) { border-radius:0; width:18px; height:140px; transform:rotate(28deg); left:78%; top:-5px; }
.studio { --paper:#f8f2e9; }.studio .mast { border-top:4px solid var(--accent); padding-top:10px; }.studio h1 { font-size:58px; }
.studio .art { border:0; height:145px; }.studio .art span { border-radius:0; background:var(--accent); transform:rotate(${index % 2 ? '18' : '-12'}deg); }
.studio .art span:nth-child(2) { border-radius:50%; background:transparent; border-width:12px; }.studio .art span:nth-child(3) { width:40px; height:110px; transform:rotate(30deg); }
.trail { --paper:#183d32; --ink:#f2ecd9; --line:#5a7565; }.trail .art { border:0; height:145px; }.trail .art span { width:140px; height:140px; top:55px; left:5%; border-radius:6px; transform:rotate(45deg); background:var(--accent); }
.trail .art span:nth-child(2) { left:35%; top:35px; opacity:.65; }.trail .art span:nth-child(3) { left:64%; top:75px; background:var(--paper); border-style:solid; }
@media(min-width:560px) { main { padding:32px; }.invite { grid-template-columns:1fr 1fr; } h1 { font-size:64px; } }
@media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none !important; transition:none !important; scroll-behavior:auto !important; } }
</style></head><body class="${plan.theme}"><main>
<div class="mast"><span>NOWMe / ${h(plan.name.split(' · ')[0]!)}</span><span>人物 ${String(index + 1).padStart(2, '0')} / 10</span></div>
<section class="hero" data-nm-id="hero"><p class="role">${h(p.role)}</p><h1>${h(p.name)}</h1><p class="headline">${h(p.headline)}</p>
<div class="art" aria-hidden="true"><span></span><span></span><span></span><b>${h(p.tags.join(' / '))}</b></div>
<div class="tags">${p.tags.map((tag) => `<span>${h(tag)}</span>`).join('')}</div></section>
<section class="section" data-nm-id="about"><p class="kicker">01 / 关于我</p><h2>先从一点小事认识我</h2><p>${h(p.about)}</p></section>
<section class="section" data-nm-id="work"><p class="kicker">02 / 最近在做</p><div class="note">${h(p.work)}</div></section>
<section class="section" data-nm-id="together"><p class="kicker">03 / 一起开始</p><h2>如果你也感兴趣</h2><div class="invite"><p><strong>我可以</strong>${h(p.offering)}</p><p><strong>想找你</strong>${h(p.looking)}</p></div></section>
<footer>在页面外点「想聊这个」，从一个共同话题开始。<br>NOWMe · ${h(p.name)}的一页</footer></main></body></html>`;
  return { displayName: p.name, files: Object.fromEntries(Object.entries({ 'index.html': html, 'card.json': JSON.stringify(card), 'manifest.json': JSON.stringify(manifest) }).map(([path, text]) => [path, Buffer.from(text).toString('base64')])) };
}
