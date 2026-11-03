import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Argus Workflow Builder — Vite-React island.
// Builds into ../dist/builder/ so the Argus Express server can serve it
// from /workflows/builder/* via express.static.
export default defineConfig({
  plugins: [react()],
  base: '/workflows/builder/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist/builder',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined;
          if (id.includes('/reactflow/')) return 'reactflow';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
          if (id.includes('/react-router') || id.includes('/@remix-run/')) return 'router';
          if (id.includes('/@tanstack/')) return 'query';
          if (id.includes('/@radix-ui/')) return 'radix';
          if (id.includes('/lucide-react/')) return 'icons';
          if (id.includes('/dagre/') || id.includes('/graphlib/') || id.includes('/lodash/')) return 'layout';
          if (id.includes('/tailwind-merge/') || id.includes('/clsx/') || id.includes('/class-variance-authority/')) return 'ui-utils';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      // Forward API calls to Argus during dev
      '/api': 'http://localhost:3000',
      '/console-assets': 'http://localhost:3000',
    },
  },
});
