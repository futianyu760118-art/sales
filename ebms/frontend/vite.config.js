import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 后端 BFF：架构方案 3.2.2 对内 REST API
      '/api': {
        target: process.env.EBMS_API_TARGET ?? 'http://localhost:4100',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
