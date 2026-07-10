import { defineConfig } from 'vitest/config';

// vite.config.ts の root: 'web' の影響を受けないよう、テストは独立設定にする
export default defineConfig({
  test: {
    include: ['server/__tests__/**/*.test.ts', 'web/src/__tests__/**/*.test.ts'],
  },
});
