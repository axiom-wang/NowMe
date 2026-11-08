/** pnpm --filter @nowme/web exec tsx --conditions=source scripts/demo-ai-review.ts [--serve] */
import { runDemoWallReview } from './demo-wall-review.js';
await runDemoWallReview('ai');
