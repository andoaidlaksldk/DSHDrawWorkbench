/// <reference types='vitest' />
/**
 * DSH 画板工作台 · 内嵌白板的构建配置（overlay）。
 * 由 scripts/canvas-overlay.mjs 覆盖到上游 apps/web/vite.config.ts。
 *
 * 与上游唯一的差别是 `base: './'`：
 * 上游按站点根目录部署（`/assets/...`），而内嵌宿主页在
 * `/api/dsh-draw-workbench/app/` 下，必须用相对路径引用资源，
 * 否则脚本与样式全部 404，画布白屏。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  base: './',

  server: {
    port: 7200,
    host: 'localhost',
  },

  preview: {
    port: 4300,
    host: 'localhost',
  },

  plugins: [react(), nxViteTsPaths()],

  build: {
    outDir: '../../dist/apps/web',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },

  test: {
    watch: false,
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    coverage: {
      reportsDirectory: '../../coverage/apps/web',
      provider: 'v8',
    },
  },
});
