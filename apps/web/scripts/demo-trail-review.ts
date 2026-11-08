/** pnpm --filter @nowme/web exec tsx --conditions=source scripts/demo-trail-review.ts [--serve] */
import { runDemoWallReview } from './demo-wall-review.js';
await runDemoWallReview('trail');
