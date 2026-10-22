import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/vite.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  // myfx 是 peerDependency，产物保留裸导入由宿主解析（不显式列出会随 tsdown 默认策略变化）
  external: [/^vite/, /^compelem/, /^myfx/],
})
