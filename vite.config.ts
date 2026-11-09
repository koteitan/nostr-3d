import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // relative base: dist/ works from any path of a static server
  base: './',
  plugins: [react()],
  server: { port: 5183 },
  build: { target: 'esnext', sourcemap: true },
});
