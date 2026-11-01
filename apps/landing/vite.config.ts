import { defineConfig } from 'vite';

// Relative base path: the built dist/ can be served from any host or sub-directory (DIST-01).
// release-manifest.json is copied from public/ next to index.html and fetched at runtime.
export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 19181, strictPort: true },
  preview: { host: '127.0.0.1', port: 19181, strictPort: true },
});
