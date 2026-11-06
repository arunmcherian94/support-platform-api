import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Parallel build slices run in worktrees under .claude/; never test their copies.
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
