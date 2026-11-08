import type { DemoProfile } from '../demo-content.js';

export interface DemoTrailDesign {
  body: string;
  css: string;
  blocks: string[];
  fonts: { id: string; weights: number[] }[];
  /** Optional white-listed raster assets, encoded for the existing submission API. */
  assets?: Record<string, string>;
}

export type DemoTrailDesigner = (profile: DemoProfile) => DemoTrailDesign;

export function h(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
