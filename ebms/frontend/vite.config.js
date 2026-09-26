import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5199,
    // 开发期直接代理到 EBMS 后端，避免前端持有后端地址
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3020',
        changeOrigin: true,
      },
    },
  },
});
