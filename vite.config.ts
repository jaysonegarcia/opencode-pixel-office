import { defineConfig } from 'vite';
export default defineConfig({ build: { outDir: 'dist/ui', emptyOutDir: true }, server: { proxy: { '/api': 'http://127.0.0.1:4780' } } });
