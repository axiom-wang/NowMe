import { defineProject } from 'vitest/config';
import { sourceResolve, testInclude } from '../../vitest.shared.ts';

export default defineProject({
  ...sourceResolve,
  test: {
    name: '@nowme/kit',
    include: testInclude,
  },
});
