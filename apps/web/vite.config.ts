import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In production apps/api serves dist/ at / and the API at /api on the same origin.
// During development and e2e-against-mock, /api is proxied to the mock API (127.0.0.1:19189).
const apiTarget = process.env.BLACKBOX_API_PROXY ?? 'http://127.0.0.1:19189';
const proxy = {
  '/api': { target: apiTarget, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 19180, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 19180, strictPort: true, proxy },
});
