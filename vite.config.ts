import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// root と rollup の input は必ず同じ基準（__dirname）から作る。
// root だけを相対指定にすると、カレントディレクトリがジャンクション経由
// （C:\WORK\MGWork\... ＝ OneDrive 実体へのリンク）のときに
// root と input の前置きパスが食い違い、rollup が
// 「emitted chunks ... must be strings that are neither absolute nor relative paths」
// で失敗する。
const rendererRoot = resolve(__dirname, 'src/renderer')

export default defineConfig({
  plugins: [react()],
  root: rendererRoot,
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: resolve(rendererRoot, 'index.html'),
        ranking: resolve(rendererRoot, 'ranking.html'),
      },
      output: {
        assetFileNames: `assets/[name][extname]`,
        entryFileNames: `[name].js`, // Ensure separate JS files for each entry
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main')
    }
  },
  server: {
    port: 3000,
    strictPort: true
  },
  publicDir: resolve(__dirname, 'assets')
})