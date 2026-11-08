import type { DemoProfile } from '../demo-content.js';
import { designRoute, designNewcomer } from './route-newcomer.js';
import { designPace, designNature } from './pace-nature.js';
import { designLunch, designPhoto } from './lunch-photo.js';
import type { DemoTrailDesign, DemoTrailDesigner } from './types.js';

export const DEMO_TRAIL_PUBLISHED_INDICES = [1, 2, 3, 4, 5, 6] as const;

const designers: Readonly<Record<number, DemoTrailDesigner>> = {
  1: designRoute, 2: designNewcomer, 3: designPace,
  4: designNature, 5: designLunch, 6: designPhoto,
};

export function designDemoTrailProfile(profile: DemoProfile, index: number): DemoTrailDesign {
  const design = designers[index];
  if (!design) throw new Error(`山野徒步成员尚未创建页面：${profile.name}`);
  return design(profile);
}
