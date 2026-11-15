import { defineWorkspace } from 'vitest/config';

/**
 * One vitest project per package so a single root `vitest run` (and a single
 * repo-wide coverage report) exercises core, server, and client together.
 * Each package keeps its own vite/vitest config (notably the client's jsdom
 * environment and `@` alias).
 */
export default defineWorkspace(['packages/core', 'packages/server', 'packages/client']);
