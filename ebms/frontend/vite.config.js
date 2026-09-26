import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const backend = process.env.EBMS_BACKEND ?? 'http://127.0.0.1:4100';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5100,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
});
