import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/vite.ts'],
  format: ['esm'],
  target: 'node18',
  platform: 'node',
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['rolldown', 'vite', 'compelem'],
})
