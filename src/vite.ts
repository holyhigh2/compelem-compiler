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
import type { CompilerOptions } from './types'
import { compileFile } from './compile'
import { hash32 } from './utils/oxc'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 极简的结构化插件类型，避免硬依赖 vite 的 types（peer 里 vite 是可选的）。 */
interface MinimalPlugin {
  name: string
  enforce?: 'pre' | 'post'
  transform?: (code: string, id: string) => { code: string; map: any } | null | undefined
  configResolved?: (config: any) => void
  buildStart?: (this: any) => void | Promise<void>
}

const TAG_RE = /@tag\(\s*['"]([^'"]+)['"]/g

/** 递归收集 root 下 .ts/.tsx 的 @tag 名（跨文件标签注册表，TEMPLATE-CODEGEN.md §4）。 */
function scanKnownTags(root: string, out: Set<string>, depth = 0): void {
  if (depth > 20) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(root, e.name)
    if (e.isDirectory()) {
      scanKnownTags(p, out, depth + 1)
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      try {
        const code = readFileSync(p, 'utf-8')
        TAG_RE.lastIndex = 0
        let m
        while ((m = TAG_RE.exec(code))) out.add(m[1].toLowerCase())
      } catch {
        /* 忽略读失败 */
      }
    }
  }
}

export interface VitePluginOptions extends CompilerOptions {
  /** 是否输出每个文件的编译诊断 */
  verbose?: boolean
  /**
   * D7（模板内直接嵌套模板）命中的处理力度。
   * - `'warn'`（默认）：仅控制台提示 D7 消息
   * - `'error'`：直接阻断构建，用于 CI 强制把关
   * - `'silent'`：不提示
   */
  d7?: 'warn' | 'error' | 'silent'
  /**
   * 约定错误（E-*：emit 未声明/非字面量、@prop 缺 type/命名/赋值、@computed 非 getter、
   * @csscope 非 static getter）的处理力度。默认 `'error'` —— 约定违规直接阻断构建。
   */
  conventions?: 'error' | 'warn' | 'silent'

  // compelem 不允许降级。基于 signal 模型的架构**必须**依赖编译器编译后执行，
  // 静态分析推不出正确依赖（D 系列）时唯一的正确做法是**报错**，而不是产出
  // 「运行时静默不渲染 / 渲染错」的降级产物。规则不对 ⇒ 编译报错，没有可调力度。

  /**
   * 调试用：把编译产物写到源文件同级（`foo.ts` → `foo.js`），便于直接查看
   * 注入后的 `__ce_static__` / buildTemplate / pointEffects / fx。
   * 仅对真实文件生效（跳过 `?v=` 之类的虚拟 id），且只在编译确有改动时写。
   */
  emitJs?: boolean
  /**
   * 调试编译产物用：令 sourcemap 以上游注入后的 TS 为 0 级原�?   * 这样 DevTools 直接显示编译后代码（含 `__ce_static__` / buildTemplate / fx），
   * 在这些区域打的断点能命中。代价：跳过「编译后代码 → 原始模板」的映射，
   * 栈帧行号指向注入后的 TS 而非用户源码里的模板位置。默认 `false`。
   */
  debugSourceMap?: boolean
}

/** 惰性构建换行偏移索引（升序；仅在有诊断时付费一次）。 */
function newlineIndex(code: string): Int32Array {
  const arr: number[] = []
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) arr.push(i)
  return Int32Array.from(arr)
}

/** 把源码偏移换算成 `行:列`（1 起算）；带换行索引时走二分（O(log n)）。 */
function offsetToLineCol(code: string, offset: number, nl?: Int32Array): string {
  if (!nl) {
    let line = 1
    let lastNl = -1
    for (let i = 0; i < offset && i < code.length; i++) {
      if (code.charCodeAt(i) === 10) {
        line++
        lastNl = i
      }
    }
    return `${line}:${offset - lastNl}`
  }
  //二分：count = 换行下标中严格小于 offset 的个数
  let lo = 0, hi = nl.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (nl[mid] < offset) lo = mid + 1
    else hi = mid
  }
  const lastNl = lo > 0 ? nl[lo - 1] : -1
  return `${lo + 1}:${offset - lastNl}`
}

/** 收集全部诊断违规（D7 或约定错误），带上 id / 行列信息。 */
function collectErrors(
  res: ReturnType<typeof compileFile>,
  code: string,
  id: string,
  root: string,
  kind: 'd7' | 'conventions',
): string[] {
  const out: string[] = []
  const rel = id.startsWith(root) ? id.replace(/\\/g, '/').slice(root.replace(/\\/g, '/').length + 1) : id
  let nl: Int32Array | undefined
  for (const d of res.diagnostics) {
    const list =
      kind === 'd7'
        ? d.errors.map((e) => ({ offset: e.exprStart, message: e.message }))
        : (d as any).conventionErrors?.map((e: any) => ({ offset: e.start, message: e.message })) ?? []
    for (const e of list) {
      nl ??= newlineIndex(code)
      const at = offsetToLineCol(code, e.offset, nl)
      out.push(`${rel}:${at} [${d.className}] ${e.message}`)
    }
  }
  return out
}

/** 按 mode 上报违规（error 阻断构建 / warn 控制台 / silent 忽略）。 */
function reportErrors(msgs: string[], mode: 'warn' | 'error' | 'silent', head: string, thisArg: any) {
  if (mode === 'silent' || !msgs.length) return
  const text = head + '\n  ' + msgs.join('\n  ')
  if (mode === 'error') {
    const err = thisArg?.error?.bind(thisArg)
    if (err) err(new Error(text))
    else throw new Error(text)
  } else {
    console.warn(text)
  }
}

/** compelem 编译期优化插件。 */
export function compelemCompiler(options: VitePluginOptions = {}): MinimalPlugin {
  let root = process.cwd()
  const d7Mode = options.d7 ?? 'warn'
  const convMode = options.conventions ?? 'error'
  const knownTags = new Set<string>()
  if (options.knownTags) for (const t of options.knownTags) knownTags.add(t.toLowerCase())
  let scanned = false
  // U4：transform 结果缓存（key = id + 源码哈希 + knownTags 版本）。
  // compileFile 对 (code,id,options) 纯函数（无 console/全局副作用），诊断随 res 缓存；
  // knownTags 只增不减 → size 即单调版本号（本文件 TAG_RE 扫描先跑后取 key，幂等）。
  // FIFO 上限防 dev 长会话内存增长；命中仍走全部 reporting（每次 transform 都要报）。
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
      // 惰性兜底：buildStart 未触发（如纯 API 调用）时按需扫描
      if (!scanned) {
        scanned = true
        scanKnownTags(root, knownTags)
      }
      // 本文件新出现的 @tag 立即并入（预扫后新增的热更场景；Set 幂等）
      TAG_RE.lastIndex = 0
      let tm
      while ((tm = TAG_RE.exec(code))) knownTags.add(tm[1].toLowerCase())

      const cacheKey = id + '\0' + hash32(code) + '\0' + knownTags.size
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

      // D7 是独立于「是否注入」的写法约束，没发生源码改动也要检查
      if (d7Mode !== 'silent') {
        const msgs = collectErrors(res, code, id, root, 'd7')
        reportErrors(msgs, d7Mode, `[compelem/compiler] 检测到 ${msgs.length} 处禁止写法：`, this)
      }

      // 约定错误：独立于降级判定，默认直接阻断构建
      if (convMode !== 'silent') {
        const msgs = collectErrors(res, code, id, root, 'conventions')
        reportErrors(msgs, convMode, `[compelem/compiler] 检测到 ${msgs.length} 处约定错误：`, this)
      }

      // D 系列命中 = 静态分析无法保证正确性 ⇒ **一律编译报错，无降级路径**。
      // compelem 的架构前提就是「必须经编译器编译后执行」，所以这里没有
      // warn/silent 档位：规则不对就不是能跑的代码，必须让用户在构建期看到。
      const degraded = res.diagnostics.filter((d) => d.degraded)
      if (degraded.length) {
        const root2 = root.replace(/\\/g, '/')
        const msgs = degraded.map((d) => {
          const rel = id.startsWith(root)
            ? id.replace(/\\/g, '/').slice(root2.length + 1)
            : id
          return `${rel} [${d.className}] 静态分析未通过：${d.reason ?? '未知原因'}`
        })
        reportErrors(
          msgs,
          'error',
          `[compelem/compiler] 检测到 ${msgs.length} 个未通过静态分析的组件（compelem 不支持降级，必须修）：`,
          this,
        )
      }

      if (!res.changed) return null

      // 调试：把编译产物落到源文件同级（foo.ts → foo.js）
      if (options.emitJs) emitCompiledJs(id, res.code, root)

      if (options.verbose) {
        const rel = id.startsWith(root) ? id.slice(root.length + 1) : id
        for (const d of res.diagnostics) {
          const state = d.degraded ? `降级(${d.reason})` : `编译(${d.viewDeps} deps)`
          console.log(`[compelem/compiler] ${rel} :: ${d.className} → ${state}`)
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
