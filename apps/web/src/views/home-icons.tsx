import type { FC } from 'hono/jsx';

export type HomeIconName = 'layers' | 'check' | 'pending' | 'pencil' | 'enter' | 'eye' | 'plus' | 'arrow' | 'chevron';
export const HomeIcon: FC<{ name: HomeIconName }> = ({ name }) => (
  <svg class={`home-icon home-icon--${name}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {name === 'layers' ? <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></> : null}
    {name === 'check' ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></> : null}
    {name === 'pending' ? <circle cx="12" cy="12" r="9" stroke-dasharray="4 3" /> : null}
    {name === 'pencil' ? <><path d="m14 4 6 6M4 20l2-7L17 2a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L11 18l-7 2Z" /><path d="m6 13 5 5M15 21h6" /></> : null}
    {name === 'enter' ? <><path d="M13 4h7v7M20 4l-9 9" /><path d="M10 5H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5" /></> : null}
    {name === 'eye' ? <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></> : null}
    {name === 'plus' ? <path d="M12 5v14M5 12h14" /> : null}
    {name === 'arrow' ? <path d="M4 12h16m-6-6 6 6-6 6" /> : null}
    {name === 'chevron' ? <path d="m7 10 5 5 5-5" /> : null}
  </svg>
);
