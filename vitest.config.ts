import { defineConfig } from 'vitest/config'

// Unit tests for the pure TypeScript logic (no React Native runtime needed).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
