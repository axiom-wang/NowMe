/**
 * “AI 协助生成”标识（contracts 16.2）：页面是 AI 和页面主人一起做的，本人确认后发布。
 * 只出现在主站自己的界面里（墙上的页面卡片、成员页的页面框、公开链接页），不往用户页面的 HTML 里注入任何东西。
 */
import type { FC } from 'hono/jsx';

export const AI_BADGE_TEXT = 'AI 协助生成';
export const AI_BADGE_TITLE = '这一页由 AI 和页面主人一起做成，本人确认后发布';

export const AiBadge: FC = () => (
  <span class="ai-badge" title={AI_BADGE_TITLE} data-ai-badge="">
    <span aria-hidden="true">✦</span> {AI_BADGE_TEXT}
  </span>
);
