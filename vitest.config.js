import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'web/src/**/*.{js,jsx}'],
      exclude: ['server/index.js', 'web/src/main.jsx', 'web/src/components/Backdrop.jsx'],
      reporter: ['text', 'html'],
    },
  },
});
