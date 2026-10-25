/**
 * Vite / Rolldown 插件入口。
 *
 * 用法（vite.config.ts）：
 * ```ts
 * import { compelemCompiler } from '@compelem/compiler/vite'
 * export default defineConfig({ plugins: [compelemCompiler()] })
 * ```
 *
 * 通过 `enforce: 'pre'` + `transform` 钩子工作：在 TS→JS 转换之前拿到 `.ts` 源码，
 * 注入 `static __ce_static__` 后交回后续插件链。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { compileFile } from './compile'
import { collectDiagnostics, reportConventionDiagnostics, type ConventionMode } from './diagnostics'
import { TAG_RE, scanKnownTags } from './tag-registry'
import type { CompilerOptions } from './types'
import { hash32 } from './utils/ast'

/** 极简的结构化插件类型，避免硬依赖 vite 的 types（peer 里 vite 是可选的）。 */
interface MinimalPlugin {
  name: string
  enforce?: 'pre' | 'post'
  transform?: (code: string, id: string) => { code: string; map: any } | null | undefined
  configResolved?: (config: any) => void
  buildStart?: (this: any) => void | Promise<void>
}

/**
 * 用于 transform 缓存键的按文件指纹（见 tagFingerprint）。
 */
const FILE_HYPHEN_TAG_RE = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g

/**
 * 按文件标签指纹（替代全局 `knownTags.size`）。
 */
function tagFingerprint(usedTags: Set<string>, knownTags: Set<string>): string {
  if (usedTags.size === 0) return ''
  const inter: string[] = []
  for (const t of usedTags) if (knownTags.has(t)) inter.push(t)
  if (inter.length === 0) return ''
  inter.sort()
  return hash32(inter.join('\n'))
}

export interface VitePluginOptions extends CompilerOptions {
  /** 是否输出每个文件的编译诊断 */
  verbose?: boolean
  /**
   * 约定错误（E-*：emit 未声明/非字面量、@prop 缺 type/命名/赋值、@computed 非 getter、
   * @csscope 非 static getter）的处理力度。默认 `'error'` —— 约定违规直接阻断构建。
   */
  conventions?: 'error' | 'warn' | 'silent'

  /**
   * 调试用：把编译产物写到源文件同级（`foo.ts` → `foo.js`），便于直接查看
   * 注入后的 `__ce_static__` / buildTemplate / pointEffects / fx。
   * 仅对真实文件生效（跳过 `?v=` 之类的虚拟 id），且只在编译确有改动时写。
   */
  emitJs?: boolean
  debugSourceMap?: boolean
}

/** compelem 编译期优化插件。 */
export function compelemCompiler(options: VitePluginOptions = {}): MinimalPlugin {
  let root = process.cwd()
  const convMode = options.conventions ?? 'error'
  const knownTags = new Set<string>()
  if (options.knownTags) for (const t of options.knownTags) knownTags.add(t.toLowerCase())
  let scanned = false
  const transformCache = new Map<string, ReturnType<typeof compileFile>>()
  const TRANSFORM_CACHE_MAX = 512

  return {
    name: 'compelem:compiler',
    enforce: 'pre',

    configResolved(config: any) {
      root = config?.root ?? root
    },

    buildStart() {
      // 启动时全量预扫 @tag，填充跨文件标签注册表（编译顺序无关）
      if (scanned) return
      scanned = true
      scanKnownTags(root, knownTags)
    },

    transform(code: string, id: string) {
      if (id.includes('\0')) return null
      const clean = id.split('?')[0]
      if (!/\.(?:m|c)?(?:tsx?|jsx?)$/.test(clean)) return null
      if (clean.includes('node_modules')) return null

      // 惰性兜底：buildStart 未触发（如纯 API 调用）时按需扫描
      if (!scanned) {
        scanned = true
        scanKnownTags(root, knownTags)
      }
      // 本文件新出现的 @tag 立即并入（预扫后新增的热更场景；Set 幂等）
      TAG_RE.lastIndex = 0
      FILE_HYPHEN_TAG_RE.lastIndex = 0
      let tm
      const usedTags = new Set<string>()
      while ((tm = TAG_RE.exec(code))) {
        const t = tm[1].toLowerCase()
        knownTags.add(t)
        usedTags.add(t)
      }
      let hm
      while ((hm = FILE_HYPHEN_TAG_RE.exec(code))) usedTags.add(hm[1].toLowerCase())

      const cacheKey = id + '\0' + hash32(code) + '\0' + tagFingerprint(usedTags, knownTags)
      let res = transformCache.get(cacheKey)
      if (!res) {
        res = compileFile(code, id, {
          ...options,
          knownTags: options.knownTags
            ? new Set([...knownTags, ...[...options.knownTags].map((t) => t.toLowerCase())])
            : knownTags,
        })
        if (transformCache.size >= TRANSFORM_CACHE_MAX) {
          const oldest = transformCache.keys().next().value
          if (oldest !== undefined) transformCache.delete(oldest)
        }
        transformCache.set(cacheKey, res)
      }

      // 约定错误：独立于静态分析闸门，默认直接阻断构建；
      // W 码（severity:'warn'，如 W-PROP-CUSTOM-CTOR）恒为控制台提示，不随档位阻断。
      if (convMode !== 'silent') {
        reportConventionDiagnostics(collectDiagnostics(res, code, id, root), convMode, this)
      }

      if (!res.changed) return null

      // 调试：把编译产物落到源文件同级（foo.ts → foo.js）
      if (options.emitJs) emitCompiledJs(id, res.code, root)

      if (options.verbose) {
        const rel = id.startsWith(root) ? id.slice(root.length + 1) : id
        for (const d of res.diagnostics) {
          console.log(`[compelem/compiler] ${rel} :: ${d.className} → 编译(${d.viewDeps} deps)`)
        }
      }
      return { code: res.code, map: options.debugSourceMap ? null : res.map }
    },
  }
}

/**
 * 把编译产物写到源文件同级：`foo.ts` → `foo.js`。
 * 写失败只告警不抛：产物是调试便利，不该让 dev server 起不来。
 */
function emitCompiledJs(id: string, code: string, root: string): void {
  // 跳过虚拟模块：带 ?v= / \0 的不是磁盘路径
  if (id.includes('\0') || id.includes('?')) return
  if (!/\.tsx?$/.test(id)) return
  try {
    const out = id.replace(/\.tsx?$/, '.js')
    const prev = existsSync(out) ? readFileSync(out, 'utf-8') : null
    if (prev === code) return
    writeFileSync(out, code, 'utf-8')
    const rel = id.startsWith(root) ? id.slice(root.length + 1) : id
    console.log(`[compelem/compiler] emit → ${out.replace(root, '.')}${prev === null ? '' : ' (updated)'}`)
    void rel
  } catch (e) {
    console.warn(`[compelem/compiler] emitJs 写入失败：${id} → ${String(e)}`)
  }
}

export default compelemCompiler
