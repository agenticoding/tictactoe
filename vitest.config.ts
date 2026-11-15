import { defineConfig } from 'vitest/config';

/**
 * Repo-wide coverage config for the workspace run. `include` points at every
 * package's src so untested production files (client components, static
 * serving, hook) count against coverage instead of being silently omitted.
 * Thresholds sit just below the measured baseline; ratchet upward as coverage
 * grows.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      // Entry points and vendored shadcn primitives are not our logic and are
      // asserted indirectly through the app; keep coverage focused on contracts.
      exclude: [
        'packages/*/src/**/*.d.ts',
        'packages/core/src/domain.ts',
        'packages/core/src/testing.ts',
        'packages/server/src/main.ts',
        'packages/client/src/main.tsx',
        'packages/client/src/components/ui/**',
        'packages/client/src/lib/**',
      ],
      // Baseline was 49% before the missing suites landed; these thresholds sit
      // just below the measured 98/93/95 to catch real regressions without
      // blocking incremental work. Ratchet upward as coverage grows.
      thresholds: {
        statements: 90,
        lines: 90,
        functions: 85,
        branches: 85,
      },
    },
  },
});
