import { h, type DemoAiDesigner } from './types.js';

/** 宋雨：给离线工具的构想留一本植物观察簿。 */
export const designField: DemoAiDesigner = (p) => ({
  fonts: [{ id: 'noto-serif-sc', weights: [400, 700] }],
  blocks: ['pocket-notebook', 'field-letter', 'prototype-notes', 'field-invitation'],
  css: `
:root { --field-paper:#f4f2e8; --field-ink:#263e31; --field-muted:#61705b; --field-line:#cbd1ba; --field-rust:#a54429; --nm-font-body:var(--nm-font-noto-serif-sc); }
* { box-sizing:border-box; } body { margin:0; background:var(--field-paper); color:var(--field-ink); font-family:var(--nm-font-body); font-size:16px; line-height:1.9; }
h1,h2,h3,p,figure { margin:0; } h1,h2,h3 { font-weight:700; } svg { max-width:100%; display:block; }
.field-book { width:min(100%,920px); margin:0 auto; padding:22px 24px 32px; }
.field-colophon { display:flex; align-items:center; justify-content:space-between; gap:12px; font:11px/1.6 ui-monospace,monospace; letter-spacing:.09em; color:var(--field-muted); padding-bottom:13px; border-bottom:1px solid var(--field-line); }
.field-colophon span:first-child::before { content:''; display:inline-block; width:7px; height:7px; background:var(--field-rust); border-radius:50%; margin-right:8px; }
.field-cover { position:relative; padding:22px 0 0; }
.field-identity { display:flex; justify-content:space-between; align-items:end; gap:14px; }
.field-identity h1 { font-size:39px; line-height:1.2; letter-spacing:.08em; }
.field-role { font-size:12px; padding-bottom:3px; color:var(--field-muted); }
.field-headline { font-size:27px; letter-spacing:-.035em; line-height:1.6; margin-top:15px; max-width:12em; }
.field-plate { position:relative; margin:16px 0 0; border-top:1px solid var(--field-line); border-bottom:1px solid var(--field-line); min-height:260px; background:repeating-linear-gradient(0deg,transparent,transparent 31px,#dfe1d3 32px); }
.field-plant { width:100%; height:245px; }
.field-specimen { position:absolute; top:15px; left:0; max-width:118px; font-size:12px; color:var(--field-muted); }
.field-specimen strong { display:block; font-size:17px; color:var(--field-ink); font-weight:400; margin-top:9px; line-height:1.8; }
.field-specimen small { display:block; font-size:11px; margin-top:10px; }
.field-plate figcaption { position:absolute; bottom:11px; right:0; font-size:11px; color:var(--field-muted); background:var(--field-paper); padding-left:9px; }
.field-caption { display:flex; justify-content:space-between; gap:20px; font:11px/1.7 ui-monospace,monospace; color:var(--field-muted); padding:9px 0 19px; }
.field-letter { padding:24px 0 27px; display:grid; gap:15px; }
.field-marker { font-size:11px; letter-spacing:.12em; color:var(--field-rust); }
.field-letter h2 { font-size:22px; line-height:1.6; }
.field-letter p { max-width:35em; }
.field-prototypes { border-top:1px solid var(--field-line); padding:25px 0; }
.field-prototypes h2 { font-size:21px; margin:8px 0 18px; }
.field-project-copy { margin-bottom:22px; }
.field-track { display:grid; grid-template-columns:26px 1fr; column-gap:12px; position:relative; padding:0 0 24px; }
.field-track:last-child { padding-bottom:0; }
.field-track:not(:last-child)::before { content:''; position:absolute; width:1px; background:var(--field-line); top:24px; bottom:0; left:11px; }
.field-track-index { width:23px; height:23px; border:1px solid var(--field-muted); border-radius:50%; font:11px/21px ui-monospace,monospace; text-align:center; margin-top:4px; }
.field-track h3 { font-size:17px; line-height:1.8; }
.field-track p { font-size:14px; color:var(--field-muted); }
.field-status { display:block; color:var(--field-rust); font-size:11px; margin-bottom:2px; letter-spacing:.06em; }
.field-invite { padding:24px 0 10px; border-top:1px solid var(--field-line); }
.field-invite h2 { font-size:24px; margin:8px 0 20px; }
.field-invite dl { margin:0; }
.field-invite dl>div { padding:15px 0; border-top:1px dashed var(--field-line); }
.field-invite dt { color:var(--field-muted); font-size:12px; margin-bottom:4px; }
.field-invite dd { margin:0; font-size:17px; }
.field-end { margin-top:24px; font-size:11px; color:var(--field-muted); border-top:1px solid var(--field-line); padding-top:14px; }
@media(min-width:650px) {
  .field-book { padding:30px 52px 40px; border-left:1px solid var(--field-line); border-right:1px solid var(--field-line); }
  .field-cover { padding-top:30px; display:grid; grid-template-columns:.92fr 1.08fr; column-gap:25px; }
  .field-identity { display:block; padding-top:8px; }
  .field-identity h1 { font-size:54px; }
  .field-role { font-size:14px; margin-top:12px; }
  .field-headline { grid-column:1; font-size:32px; margin-top:21px; align-self:start; }
  .field-plate { grid-column:2; grid-row:1/4; min-height:325px; margin:0; }
  .field-plant { height:320px; }
  .field-specimen { top:13px; max-width:95px; }
  .field-specimen strong { font-size:15px; }
  .field-caption { grid-column:1/-1; padding-top:15px; }
  .field-letter { grid-template-columns:170px 1fr; padding:35px 0; }
  .field-letter .field-marker { grid-column:1; }
  .field-letter h2 { grid-column:1; }
  .field-letter p { grid-column:2; grid-row:1/3; }
  .field-prototypes { padding:30px 0; }
  .field-project-copy { max-width:40em; }
  .field-track { margin-left:25px; }
  .field-invite dl { display:grid; grid-template-columns:1fr 1fr; gap:32px; }
}
`,
  body: `<main class="field-book">
  <div class="field-colophon"><span>口袋里的观察簿</span><span>移动端 / 自然</span></div>
  <header class="field-cover" data-nm-id="pocket-notebook">
    <div class="field-identity"><h1>${h(p.name)}</h1><p class="field-role">${h(p.role)}</p></div>
    <p class="field-headline">${h(p.headline)}</p>
    <figure class="field-plate">
      <div class="field-specimen">一页工具构想<strong>看见一片叶，<br>留一句观察。</strong><small>先看，再认识。</small></div>
      <svg class="field-plant" viewBox="0 0 340 260" role="img" aria-label="手绘枝叶，植物观察工具的构想示意">
        <g fill="none" stroke="#4a6748" stroke-width="1.5" stroke-linecap="round">
          <path d="M201 241C202 197 213 150 231 109C243 84 254 54 253 22"/>
          <path d="M207 204C189 179 171 158 151 143M217 164C242 145 262 122 275 93M232 108C211 94 198 76 192 55M245 70C263 60 279 46 288 29"/>
          <path fill="#b7c69c" d="M205 201C180 202 154 188 151 143C181 151 201 170 205 201Z"/>
          <path fill="#d3d9b7" d="M217 163C218 128 241 101 275 93C268 126 248 153 217 163Z"/>
          <path fill="#c4cdab" d="M232 109C205 108 186 87 192 55C215 64 232 84 232 109Z"/>
          <path fill="#c4cda9" d="M245 71C248 46 265 28 288 29C284 48 268 63 245 71Z"/>
          <path fill="#dce1c6" d="M252 52C235 35 238 18 248 7C260 19 265 34 252 52Z"/>
          <path d="M156 150L200 195M221 157L269 99M196 62L228 104M249 66L282 34M251 45L248 14"/>
          <path d="M171 177L172 163M184 187L183 174M233 145L232 128M247 130L247 114M211 88L212 77M268 49L267 40" stroke-width=".8"/>
        </g>
        <g fill="none" stroke="#879777" stroke-width=".7"><path d="M144 133L128 119H100"/><path d="M271 157H311M211 224H267"/></g>
        <g fill="#879777"><circle cx="144" cy="133" r="2"/><circle cx="211" cy="224" r="2"/></g>
      </svg>
      <figcaption>植物工具构想 · 手绘示意</figcaption>
    </figure>
    <div class="field-caption"><span>Swift · 离线优先 · 植物</span><span>带着好奇心出门 ↗</span></div>
  </header>
  <section class="field-letter" data-nm-id="field-letter">
    <span class="field-marker">写在扉页</span><h2>好用，应该发生在生活里。</h2>
    <p>${h(p.about)}</p>
  </section>
  <section class="field-prototypes" data-nm-id="prototype-notes">
    <span class="field-marker">从做过的，到想试的</span><h2>口袋里，留一点新位置。</h2>
    <p class="field-project-copy">${h(p.work)}</p>
    <div class="field-track"><span class="field-track-index">1</span><div><span class="field-status">做过的小工具</span><h3>离线背词小组件</h3><p>从熟悉的离线体验开始。</p></div></div>
    <div class="field-track"><span class="field-track-index">2</span><div><span class="field-status">下一次想试</span><h3>相机识别 + 一句话观察</h3><p>不只得到名字，也给自己的发现留个位置。</p></div></div>
  </section>
  <section class="field-invite" data-nm-id="field-invitation">
    <span class="field-marker">留一页给同行的人</span><h2>一起把想法带出门。</h2>
    <dl><div><dt>我可以</dt><dd>${h(p.offering)}</dd></div><div><dt>这次想找</dt><dd>${h(p.looking)}</dd></div></dl>
  </section>
  <footer class="field-end">${h(p.name)}的口袋观察簿 · 在页面外点「想聊这个」，从一片叶子聊起。</footer>
</main>`,
});

/** 陈默：灯、连线和还没解决的小问题，组成一张工作台。 */
export const designHardware: DemoAiDesigner = (p) => ({
  fonts: [{ id: 'noto-sans-sc', weights: [400, 700] }],
  blocks: ['workbench', 'signal-plan', 'maker-notes', 'join-the-bench'],
  css: `
:root { --bench-orange:#d96736; --bench-ink:#211d19; --bench-cream:#fff0d8; --bench-line:#a24825; --nm-font-body:var(--nm-font-noto-sans-sc); }
* { box-sizing:border-box; } body { margin:0; color:var(--bench-ink); background:var(--bench-orange); font-family:var(--nm-font-body); font-size:16px; line-height:1.85; }
h1,h2,h3,p,figure { margin:0; } svg { display:block; max-width:100%; } h1,h2,h3 { font-weight:700; }
.bench { max-width:1000px; margin:auto; padding:20px 21px 28px; }
.bench-top { display:flex; align-items:center; justify-content:space-between; gap:12px; border-bottom:1px solid var(--bench-line); padding-bottom:13px; font:11px/1.7 ui-monospace,monospace; letter-spacing:.09em; }
.bench-top b { font-weight:400; color:var(--bench-ink); }
.bench-title { padding:20px 0 15px; display:flex; justify-content:space-between; align-items:center; gap:18px; }
.bench-title h1 { font-size:55px; line-height:1; letter-spacing:-.06em; }
.bench-role { font-size:12px; text-align:right; }
.bench-role span { display:block; font:11px/1.8 ui-monospace,monospace; color:var(--bench-ink); }
.bench-headline { font-size:23px; font-weight:700; line-height:1.5; margin-bottom:17px; max-width:14em; }
.bench-object { position:relative; background:#292b28; color:#f7d8a5; margin:0 -1px; padding:12px 12px 0; border-radius:2px; }
.bench-object-label { display:flex; justify-content:space-between; gap:12px; font:11px/1.6 ui-monospace,monospace; color:#d9c5a4; }
.bench-lamp { width:100%; height:219px; }
.bench-object figcaption { font-size:11px; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:0 0 11px; color:#d9c5a4; }
.bench-led { display:inline-flex; align-items:center; gap:6px; }
.bench-led::before { content:''; width:6px; height:6px; border-radius:50%; background:#ffc466; }
.bench-work { padding:18px 0 26px; font-size:15px; }
.signal-plan { padding:21px 18px; background:var(--bench-cream); margin:0 -21px; border-top:1px solid #a94d28; border-bottom:1px solid #a94d28; }
.bench-eyebrow { font:11px/1.8 ui-monospace,monospace; letter-spacing:.08em; }
.signal-plan h2 { font-size:24px; line-height:1.5; margin:8px 0 18px; max-width:13em; }
.signal-chain { display:grid; grid-template-columns:1fr 22px 1fr 22px 1fr; align-items:center; margin-bottom:16px; }
.signal-chain div { padding:12px 2px; border-top:2px solid var(--bench-ink); border-bottom:1px solid #c5b49a; font-size:14px; text-align:center; }
.signal-chain span { font-size:18px; text-align:center; color:#8e432a; }
.signal-chain small { display:block; font-size:11px; color:#705846; }
.signal-note { font-size:13px; color:#705846; line-height:1.8; }
.maker-notes { padding:27px 0; }
.maker-notes h2 { font-size:23px; line-height:1.5; margin:8px 0 16px; }
.maker-note { position:relative; padding-left:18px; border-left:2px solid var(--bench-ink); }
.bench-tags { display:flex; flex-wrap:wrap; gap:7px; margin-top:18px; }
.bench-tags span { font:11px/1.7 ui-monospace,monospace; border:1px solid #7b391f; border-radius:30px; padding:2px 10px; }
.bench-invite { border-top:2px solid var(--bench-ink); padding:23px 0 4px; }
.bench-invite h2 { font-size:27px; line-height:1.45; margin:8px 0 21px; }
.bench-invite dl { margin:0; }
.bench-invite dl>div { display:grid; grid-template-columns:64px 1fr; gap:10px; padding:14px 0; border-top:1px solid var(--bench-line); }
.bench-invite dt { padding-top:3px; font-size:11px; }
.bench-invite dd { margin:0; font-size:17px; }
.bench-footer { font-size:11px; border-top:1px solid var(--bench-line); padding-top:16px; margin-top:20px; }
@media(min-width:650px) {
  .bench { padding:28px 42px 38px; }
  .bench-hero { display:grid; grid-template-columns:.8fr 1.2fr; gap:0 35px; padding-top:18px; }
  .bench-title { grid-column:1; display:block; padding-top:8px; }
  .bench-title h1 { font-size:76px; }
  .bench-role { text-align:left; margin-top:20px; font-size:14px; }
  .bench-headline { grid-column:1; font-size:30px; margin-top:4px; }
  .bench-object { grid-column:2; grid-row:1/4; margin-top:8px; align-self:start; padding:17px 18px 0; }
  .bench-lamp { height:290px; }
  .bench-work { grid-column:1/-1; max-width:43em; padding:25px 0 30px; }
  .signal-plan { margin:0; padding:26px 30px; display:grid; grid-template-columns:1fr 1.15fr; gap:8px 35px; }
  .signal-plan h2 { grid-column:1; margin-bottom:5px; }
  .signal-chain { grid-column:2; grid-row:1/3; margin:0; }
  .signal-note { grid-column:2; }
  .maker-notes { display:grid; grid-template-columns:.8fr 1.2fr; gap:0 35px; padding:34px 0; }
  .maker-notes .bench-eyebrow,.maker-notes h2 { grid-column:1; }
  .maker-note { grid-column:2; grid-row:1/4; margin-top:5px; }
  .bench-tags { grid-column:1; }
  .bench-invite { padding-top:28px; }
  .bench-invite dl { display:grid; grid-template-columns:1fr 1fr; gap:32px; }
}
`,
  body: `<main class="bench">
  <div class="bench-top"><span>陈默的桌面工作台</span><b>欢迎来拆开看看</b></div>
  <header class="bench-hero" data-nm-id="workbench">
    <div class="bench-title"><h1>${h(p.name)}</h1><p class="bench-role">${h(p.role)}<span>Arduino / 物联网 / 桌面装置</span></p></div>
    <p class="bench-headline">${h(p.headline)}</p>
    <figure class="bench-object">
      <div class="bench-object-label"><span>最近做的东西</span><span>久坐提醒灯</span></div>
      <svg class="bench-lamp" viewBox="0 0 360 250" role="img" aria-label="一盏暖光桌面小灯与电路板的结构示意">
        <defs><radialGradient id="lamp-glow"><stop stop-color="#ffd28a" stop-opacity=".24"/><stop offset="1" stop-color="#ffd28a" stop-opacity="0"/></radialGradient><linearGradient id="lamp-shade" x2="1" y2="1"><stop stop-color="#ffdc95"/><stop offset="1" stop-color="#c28c50"/></linearGradient></defs>
        <ellipse cx="215" cy="125" rx="116" ry="107" fill="url(#lamp-glow)"/>
        <g fill="none" stroke="#484c43" stroke-width=".6"><path d="M0 224H360M0 200H360M0 176H360M0 152H360M0 128H360M0 104H360M0 80H360M0 56H360M0 32H360"/><path d="M24 20V230M48 20V230M72 20V230M96 20V230M120 20V230M144 20V230M168 20V230M192 20V230M216 20V230M240 20V230M264 20V230M288 20V230M312 20V230M336 20V230"/></g>
        <ellipse cx="220" cy="216" rx="79" ry="10" fill="#151c18" opacity=".8"/>
        <path d="M206 118V201" stroke="#e2bc7c" stroke-width="8"/><path d="M209 120V201" stroke="#967146" stroke-width="2"/>
        <path d="M168 199H246L257 215H157Z" fill="#b38e56" stroke="#f1cf8c" stroke-width="1.2"/>
        <path d="M184 45H228L259 113H153Z" fill="url(#lamp-shade)" stroke="#f8d99f" stroke-width="1.4"/>
        <ellipse cx="206" cy="113" rx="53" ry="7" fill="#ffe5b4"/><ellipse cx="206" cy="115" rx="37" ry="4" fill="#fff4d9"/>
        <path d="M164 210C128 215 118 204 114 182S85 158 69 173" fill="none" stroke="#ee9a65" stroke-width="2"/>
        <path d="M174 213C131 231 99 219 96 192" fill="none" stroke="#9ac4bb" stroke-width="2"/>
        <g transform="translate(34 170) rotate(-7)"><rect width="69" height="37" rx="3" fill="#3e6157" stroke="#a0b2a0"/><rect x="19" y="9" width="23" height="20" rx="1" fill="#232c28" stroke="#92a38c"/><rect x="-5" y="11" width="13" height="14" fill="#a6aaa2"/><path d="M10 3H60M10 34H60" stroke="#e0b86b" stroke-width="3" stroke-dasharray="2 3"/><circle cx="55" cy="13" r="3" fill="#efc376"/></g>
        <g fill="none" stroke="#cab18e" stroke-width=".8"><path d="M259 86H293V65H323"/><path d="M249 205H306M98 184H128V155"/></g>
        <g fill="#ffe0ae"><circle cx="259" cy="86" r="2"/><circle cx="249" cy="205" r="2"/><circle cx="98" cy="184" r="2"/></g>
      </svg>
      <figcaption><span class="bench-led">小灯与接线 · 结构示意</span><span>桌面上的小实验</span></figcaption>
    </figure>
    <p class="bench-work">${h(p.work)}</p>
  </header>
  <section class="signal-plan" data-nm-id="signal-plan">
    <p class="bench-eyebrow">下一步构想 / 还在试</p><h2>如果房间有声音，<br>灯能不能慢慢回应？</h2>
    <div class="signal-chain" aria-label="构想中的声音响应流程：房间声音经传感器控制灯光"><div>房间声音<small>输入</small></div><span>→</span><div>传感器<small>感知</small></div><span>→</span><div>灯光变化<small>响应</small></div></div>
    <p class="signal-note">声音响应是想尝试的新方向，上图是构想流程。</p>
  </section>
  <section class="maker-notes" data-nm-id="maker-notes">
    <p class="bench-eyebrow">使用工作台之前，先认识我</p><h2>喜欢动手，<br>也负责装回去。</h2>
    <p class="maker-note">${h(p.about)}</p>
    <div class="bench-tags">${p.tags.map((tag) => `<span>${h(tag)}</span>`).join('')}</div>
  </section>
  <section class="bench-invite" data-nm-id="join-the-bench">
    <p class="bench-eyebrow">桌边还留着一个位置</p><h2>让一个点子，<br>在屏幕外亮起来。</h2>
    <dl><div><dt>我能帮忙</dt><dd>${h(p.offering)}</dd></div><div><dt>找你一起</dt><dd>${h(p.looking)}</dd></div></dl>
  </section>
  <footer class="bench-footer">${h(p.name)}的工作台 · 在页面外点「想聊这个」，带着一个想接上电的小点子来。</footer>
</main>`,
});
