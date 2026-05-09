import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react({ include: ['src-bubble/**/*.tsx', 'src-bubble/**/*.ts'] })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    minify: process.env.NODE_ENV === 'production' ? 'esbuild' : false,
    sourcemap: process.env.NODE_ENV !== 'production',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        vrmPicker: resolve(__dirname, 'vrm-picker.html'),
        agentBubble: resolve(__dirname, 'agent-bubble.html'),
      },
    },
  },
});
