import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    extends: './vitest.config.js',
    test: {
      name: 'server',
      environment: 'node',
      include: ['test/server/**/*.test.js'],
      setupFiles: ['./test/setup/server.setup.js'],
    },
  },
  {
    extends: './vitest.config.js',
    test: {
      name: 'web',
      environment: 'jsdom',
      include: ['test/web/**/*.test.{js,jsx}'],
      setupFiles: ['./test/setup/web.setup.js'],
      globals: true,
    },
  },
]);
