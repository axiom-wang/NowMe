import type { DemoProfile } from '../demo-content.js';
import { designResearch, designCanvas } from './research-canvas.js';
import { designSound, designData } from './sound-data.js';
import { designField, designHardware } from './field-hardware.js';
import type { DemoAiDesign, DemoAiDesigner } from './types.js';

/** The other four remain members with empty workspaces, including the test account. */
export const DEMO_AI_PUBLISHED_INDICES = [1, 2, 3, 4, 5, 6] as const;

const designers: Readonly<Record<number, DemoAiDesigner>> = {
  1: designResearch, 2: designCanvas, 3: designSound,
  4: designData, 5: designField, 6: designHardware,
};

export function designDemoAiProfile(profile: DemoProfile, index: number): DemoAiDesign {
  const design = designers[index];
  if (!design) throw new Error(`AI 共创成员尚未创建页面：${profile.name}`);
  return design(profile);
}
