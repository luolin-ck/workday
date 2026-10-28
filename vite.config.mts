import { defineConfig } from 'vitest/config';
export default defineConfig({base:'./',server:{host:'127.0.0.1'},build:{outDir:'dist/renderer',emptyOutDir:true},test:{maxWorkers:2,include:['tests/**/*.test.ts'],testTimeout:30000}});
