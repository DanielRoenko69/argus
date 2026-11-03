import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/chat-assets/',
  // Preserve Vite 5's browser syntax targets through the toolchain upgrade.
  build: { target: ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14'], outDir: 'dist', assetsDir: 'assets', emptyOutDir: true },
  server: {
    port: 5174,
    fs: { allow: ['..'] },
    proxy: {
      // Argus validates Origin/Host for state-changing session requests.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        headers: { origin: 'http://localhost:3000' },
      },
      // Vite owns /chat-assets/ (including HMR/TSX); proxying it would serve
      // stale production files or a 404 instead of the development app.
      '/console-assets': 'http://localhost:3000',
    },
  },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.ts' },
});
