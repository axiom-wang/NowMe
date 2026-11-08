import type { DemoProfile } from '../demo-content.js';

export interface DemoAiDesign {
  /** Full, person-specific body markup; no shared section template. */
  body: string;
  css: string;
  blocks: string[];
  fonts: { id: string; weights: number[] }[];
}

export type DemoAiDesigner = (profile: DemoProfile) => DemoAiDesign;

export function h(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
