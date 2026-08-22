import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Spark's inlined WebAssembly dominates the single application bundle.
    chunkSizeWarningLimit: 6000,
  },
});
