/**
 * 跨文件组件标签注册表（TEMPLATE-CODEGEN.md §4）。
 *
 * 编译一个文件时要知道「哪些自定义标签已经存在」，才能把 `<x-foo .value=${...}>`
 * 里的 `.value` 判定为 prop 绑定而不是普通 attribute。这份注册表由全量预扫填充。
 *
 * 抽成独立模块的原因：`./vite` 与 `vite-plugin-compelem-sfc` 各自实现过一遍，
 * 且两边接受的扩展名不同（前者只认 `.tsx?`，后者还要 `.ce`）—— 两份逻辑一旦
 * 漂移，`.prop` 校验就会在某一侧失效。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** `@tag('x-foo')` / `@tag(\`x-foo\`)`；一次扫描内复用，调用方负责重置 lastIndex。 */
export const TAG_RE = /@tag\s*\(\s*['"`]([^'"`]+)['"`]/g

/** 默认只把 `.ts` / `.tsx` 当作组件来源。 */
export const DEFAULT_TAG_EXT = /\.tsx?$/

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage'])

export interface ScanKnownTagsOptions {
  /** 参与扫描的文件扩展名正则，默认 {@link DEFAULT_TAG_EXT}。 */
  extensions?: RegExp
  /** 目录递归深度上限，默认 20。 */
  maxDepth?: number
}

/**
 * 递归收集 root 下匹配 `extensions` 的文件里的 `@tag` 名，写入 `out`。
 *
 * 读失败的文件直接跳过：注册表是 best-effort 的，它只会**放宽**校验，
 * 不该让一次权限错误打断构建。`node_modules` 等目录不参与扫描。
 */
export function scanKnownTags(
  root: string,
  out: Set<string>,
  options: ScanKnownTagsOptions = {},
): void {
  const { extensions = DEFAULT_TAG_EXT, maxDepth = 20 } = options
  scanDir(root, out, extensions, 0, maxDepth)
}

function scanDir(root: string, out: Set<string>, ext: RegExp, depth: number, maxDepth: number): void {
  if (depth > maxDepth) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      scanDir(join(root, e.name), out, ext, depth + 1, maxDepth)
    } else if (ext.test(e.name) && !e.name.endsWith('.d.ts')) {
      let code: string
      try {
        code = readFileSync(join(root, e.name), 'utf-8')
      } catch {
        continue
      }
      // 快筛：绝大多数文件既没有 @tag 也没有组件基类，没必要跑正则
      if (code.indexOf('@tag') < 0 && code.indexOf('CompElem') < 0) continue
      TAG_RE.lastIndex = 0
      let m
      while ((m = TAG_RE.exec(code))) out.add(m[1].toLowerCase())
    }
  }
}
