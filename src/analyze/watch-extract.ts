/**
 * @watch 编译期解析（watch 前移）。
 *
 * 运行时 @watch 装饰器在类定义期用 myfx `get(options, 'deep'/'immediate'/'once')`
 * 逐键解析选项并注册六张 watch 表；这里把「选项解析」移到编译期：
 *   - 静态解析 @watch(source, options?) → watchEffects 工厂数组注入 __ce_static__，
 *     并从源码中**删除 @watch 装饰器调用**（处理器方法保留）；
 *   - 运行时由 CompElem 构造期 `for (const factory of ceStatic.watchEffects)
 *     effect(factory(this))` 消费 —— 每个工厂产出一个 signal effect，
 *     直接读 `rc.__s.<source>.value` 建立依赖，变更即回调处理器；
 *   - 解析失败（source / options 非静态字面量）→ E-WATCH-ARG（error 级，阻断构建），
 *     此时**不删除装饰器、不注入 watchEffects**，运行时装饰器路径照常兜底。
 *
 * source 支持形态：字符串字面量、字符串字面量数组、模块级 const 字符串常量
 * （含成员访问，如 EV.TITLE —— 对齐 conventions 的 stringConsts 机制）。
 */
import type { ComponentAnalysis } from '../types'
import { keyName } from '../utils/oxc'
import { decoratorName, type ConventionError, type ConventionsContext } from './conventions'
import { classInfoOf, superClassName } from './component'

/** 源码字面量序列化（与 codegen 各文件的同名局部常量一致） */
const J = JSON.stringify

export interface WatchEntry {
  /** 处理器方法名 */
  name: string
  /** 监控路径（多路径已展开） */
  sources: string[]
  deep?: boolean
  immediate?: boolean
  once?: boolean
  /** 处理器是否为 static 成员 */
  isStatic?: boolean
}

export interface WatchExtractResult {
  entries: WatchEntry[]
  /** 需从源码删除的 @watch(...) 装饰器 span（已做整行清理） */
  removals: Array<{ start: number; end: number }>
  errors: ConventionError[]
}
/**
 * 生成 signal 模式 watch effect 工厂数组。
 * 每个 watch 条目 → `(rc) => effectFn`。
 *
 * ⚠️ 处理器实参必须与**库 API** 一致，本实现按下列权威来源对齐：
 *   - `compelem/README.md`「属性/状态监视」：
 *       `@watch("width", { immediate: true }) watchWidth(nv: string, ov: string, sourceName: string)`
 *   - `WatchHandler` 签名：
 *       `(newValue, oldValue, source: string, subNewValue?, subOldValue?) => any`
 *
 * 两个由此推出的语义要点：
 * 1. **每个 source 各自独立判定与独立调用**。多源 `@watch(['a','b'])` 时处理器被
 *    调用**多次**，每次带各自的 nv/ov/sourceName —— 靠 sourceName 区分是哪个源
 *    触发的（README 明确这么用）。
 * 2. `ov` 是**该源的上一次值**，不是数组。
 *
 * deep：signal 模型下没有 Proxy，**就地修改**（`obj.n.v = 7`）不会写信号，
 * 因此不可能被任何 effect 观测到；此处仅对 `deep: true` 的源退化为 JSON 深比较，
 * 用于「整体换成新引用但内容相同」时不误触发。非 deep 源一律 `!==` 引用比较
 * （比 JSON.stringify 便宜得多，且对对象源语义正确）。
 *
 * once：按源各自计一次。
 * immediate：创建时按源各调用一次，ov 为 undefined。
 */
export function generateWatchEffects(entries: WatchEntry[]): string {
  const factories: string[] = []
  for (const entry of entries) {
    const { name, sources, immediate, once, isStatic, deep } = entry
    /**
     * static handler 不在原型上，必须经构造器取：`rc.constructor.<name>(...)`。
     * 写成 `rc.<name>` 会得到 undefined，effect 首次触发即抛
     * "rc.onA is not a function"。
     */
    const recv = isStatic ? 'rc.constructor' : 'rc'
    /**
     * source → 读取表达式。
     *
     * source 可以是**多级路径**。signal 模型下 `__s` 只按根键建信号，
     * 所以 `"a.b"` 必须读成 `rc.__s.a.value.b`；直接拼成 `rc.__s.a.b.value`
     * 会把整串当键名，运行时得到 `undefined.value`。
     */
    const readOf = (src: string): string => {
      const segs = src.split('.')
      const root = segs[0]
      return `rc.__s.${root}.value${segs.slice(1).map((x) => '.' + x).join('')}`
    }
    const reads = sources.map(readOf)
    const seed = `[${reads.join(', ')}]`
    const idx = sources.map((_, i) => i)
    /**
     * deep 源用「序列化缓存」：每次触发只对 n[i] 做**一次** JSON.stringify，
     * 与上一轮缓存的字符串比较。
     * s[i] 在工厂期用同一读取表达式播种，保证 immediate 语义不变
     * （首轮 n 与播种 o 相同 → 不触发）。
     */
    const useStrCache = deep === true
    const sSeed = useStrCache ? ` const s = [${reads.map((r) => `JSON.stringify(${r})`).join(', ')}];` : ''
    const qDecl = useStrCache ? 'let q; ' : ''
    /** 该源是否真的变了：deep 走缓存字符串比较，其余走引用比较 */
    const changed = (i: number) =>
      useStrCache
        ? `(q = JSON.stringify(n[${i}])) !== s[${i}] && (s[${i}] = q, true)`
        : `n[${i}] !== o[${i}]`
/**
     * 变更回调：(nv, ov, sourceName)。
     *
     * ⚠️ **必须包 `untrack`**：这个调用发生在 effect 体**内部**（`CompElem.setup` 里
     * `effect(factory(this))`），作者方法体里任何额外的信号读都会被 `track()` 收编成
     * 本 watch 的依赖 —— 而本 watch 的订阅集本该**只含装饰器里声明的源**（`reads` 是
     * 静态算出的）。例：
     *
     * ```ts
     * @watch('a', 'aChanged')
     * aChanged(nv) { this.a = nv; console.log(this.debugInfo) }  // debugInfo 被误订阅
     * ```
     *
     * 方法体对 codegen 是黑盒（用户代码），无法静态剔除里面的读，故在调用点整体
     * 关闭收集。这是 `untrack` 唯一的内部使用点，也是它存在的理由。
     */
    const call = (i: number) => `untrack(() => ${recv}.${name}(n[${i}], o[${i}], ${J(sources[i])}))`
    /** immediate 前奏：ov 此刻尚不存在，按 API 传 undefined */
    const callInit = (i: number) => `untrack(() => ${recv}.${name}(o[${i}], undefined, ${J(sources[i])}))`
    const store = idx.map((i) => `o[${i}] = n[${i}]`).join('; ')

    if (once && immediate) {
      // 创建时按源各触发一次，之后永不触发
      factories.push(
        `(rc) => { const o = ${seed}; ${idx.map(callInit).join('; ')}; return () => {} }`,
      )
    } else if (once) {
      // o 在建 effect 时播种 → 首轮判定「无变化」；f 按源各自只允许一次
      factories.push(
        `(rc) => { const o = ${seed};${sSeed} const f = ${JSON.stringify(idx.map(() => 0))}; ` +
          `return () => { const n = [${reads.join(', ')}]; ${qDecl}` +
          idx.map((i) => `if (!f[${i}] && ${changed(i)}) { f[${i}] = 1; ${call(i)} }`).join('; ') +
          `; ${store} } }`,
      )
    } else if (immediate) {
      factories.push(
        `(rc) => { const o = ${seed};${sSeed} ${idx.map(callInit).join('; ')}; ` +
          `return () => { const n = [${reads.join(', ')}]; ${qDecl}` +
          idx.map((i) => `if (${changed(i)}) { ${call(i)} }`).join('; ') +
          `; ${store} } }`,
      )
    } else {
      factories.push(
        `(rc) => { const o = ${seed};${sSeed} return () => { const n = [${reads.join(', ')}]; ${qDecl}` +
          idx.map((i) => `if (${changed(i)}) { ${call(i)} }`).join('; ') +
          `; ${store} } }`,
      )
    }
  }
  return `[${factories.join(',')}]`
}

function strOf(n: any): string | null {
  if (!n) return null
  if (n.type === 'StringLiteral') return String(n.value)
  if (n.type === 'Literal' && typeof n.value === 'string') return String(n.value)
  return null
}

function boolOf(n: any): boolean | null {
  if (!n) return null
  if (n.type === 'BooleanLiteral') return n.value === true
  if (n.type === 'Literal' && typeof n.value === 'boolean') return n.value
  return null
}

/**
 * 该组件（含**同文件内**基类链）会被建成 `__s` 信号的键集。
 *
 * `comp.fields` 只含本类**自身**成员（classInfoOf 不做基类合并），所以子类上
 * `@watch("title")`（title 来自父类 @state）会被误判为非信号。必须沿 extends 链上溯。
 *
 * 返回 null = 链上有本文件之外的基类 → 键集不可知，调用方应跳过校验（宁可放过，
 * 也不误伤）。这与「基类在别处」时组件本身通常已 D6 降级的情形一致。
 */
function signalKeysOf(
  cls: any,
  ctx: ConventionsContext,
  comp: ComponentAnalysis,
  ownFields: Set<string>,
): Set<string> | null {
  const keys = new Set<string>(ownFields)
  let cur = cls
  for (let depth = 0; depth < 8; depth++) {
    const sup = superClassName(cur)
    if (!sup) return keys
    // CompElem 是框架基类，永远在链尾且不贡献响应式字段（slots 除外）——
    // 必须当终止条件返回已知键集，不能当成「本文件外的未知基类」而放弃校验，
    // 否则所有直接继承 CompElem 的组件（也就是绝大多数）都跳过检查。
    if ([...comp.compelemImports.values()].includes(sup) && sup === 'CompElem') {
      keys.add('slots')
      return keys
    }
    const parent = ctx.localClasses.get(sup)
    if (!parent) return null // 基类在别处 → 不可知
    const info = classInfoOf(parent, new Set(comp.compelemImports.values()))
    for (const k of info.fields.keys()) keys.add(k)
    cur = parent
  }
  return null // 链过深，视为不可知
}

/** 解析 source 实参 → 路径数组；不可静态解析返回 null。（field-extract 复用） */
export function resolveSources(arg: any, ctx: ConventionsContext): string[] | null {
  const s = strOf(arg)
  if (s != null) return [s]
  if (arg?.type === 'ArrayExpression') {
    const out: string[] = []
    for (const el of arg.elements ?? []) {
      const v = strOf(el)
      if (v == null) return null
      out.push(v)
    }
    return out.length ? out : null
  }
  // 模块级 const（字符串或字符串常量的成员访问，如 EV.TITLE）
  if (arg?.type === 'Identifier') {
    const v = ctx.stringConsts.get(arg.name)
    return typeof v === 'string' ? [v] : null
  }
  if (arg?.type === 'MemberExpression' && !arg.computed) {
    let parts: string[] = []
    let node = arg
    while (node?.type === 'MemberExpression' && !node.computed) {
      const k = keyName(node.property)
      if (!k) return null
      parts.unshift(k)
      node = node.object
    }
    if (node?.type === 'Identifier') {
      const base = ctx.stringConsts.get(node.name)
      if (base && typeof base === 'object') {
        let cur: any = base
        for (const p of parts) {
          cur = cur[p]
          if (cur == null) return null
        }
        return typeof cur === 'string' ? [cur] : null
      }
    }
  }
  return null
}

/**
 * 装饰器独占一行时把删除范围扩到整行（含换行），避免留下纯缩进的空行。（field-extract 复用）
 */
export function lineSpan(code: string, start: number, end: number): { start: number; end: number } {
  const ls = code.lastIndexOf('\n', start - 1) + 1
  const leIdx = code.indexOf('\n', end)
  const lineEnd = leIdx === -1 ? code.length : leIdx
  const before = code.slice(ls, start)
  const after = code.slice(end, lineEnd)
  if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
    return { start: ls, end: Math.min(lineEnd + 1, code.length) }
  }
  return { start, end }
}

/**
 * 提取组件类上全部 @watch 配置。错误（E-WATCH-ARG / E-WATCH-SOURCE）与条目互斥：
 * 有错误时调用方应放弃删除与注入（运行时装饰器路径兜底）。
 *
 * ⚠️ **继承**：条目里会**先并入同文件基类链上的 @watch**（祖先在前），因为
 * `watchEffects` 是按 `(this.constructor).__ce_static__` 逐实例取的 —— 子类若只
 * 注入自己的 watch，父类实例上的处理器在子类实例上就完全不生效。
 * 顺序「祖先在前」使父类处理器先于子类触发。
 *
 * 只并入**条目**，不并入 removals：祖先在 analyzeFile 里是独立组件，删自己的装饰器。
 */
export function extractWatchers(
  comp: ComponentAnalysis,
  code: string,
  ctx: ConventionsContext,
): WatchExtractResult {
  const result: WatchExtractResult = { entries: [], removals: [], errors: [] }
  const cls = comp.cls ?? ctx.localClasses.get(comp.className)
  if (!cls) return result

  const aliases = new Set(comp.compelemImports.values())
  const isWatchDec = (local: string) => comp.compelemImports.get(local) === 'watch'

  /** 沿 extends 链上溯同文件基类（遇 CompElem 或文件外基类即止），返回 [最远祖先 … 直接父类] */
  const ancestorChain = (): Array<{ node: any; fields: Set<string> }> => {
    const chain: Array<{ node: any; fields: Set<string> }> = []
    let cur = cls
    for (let depth = 0; depth < 8; depth++) {
      const sup = superClassName(cur)
      if (!sup) break
      if (aliases.has(sup) && sup === 'CompElem') break
      const parent = ctx.localClasses.get(sup)
      if (!parent) break // 基类在本文件外，其 watch 由其自身所在文件处理
      chain.push({ node: parent, fields: new Set(classInfoOf(parent, aliases).fields.keys()) })
      cur = parent
    }
    return chain.reverse()
  }

  /**
   * 收集单个类的 @watch 条目。
   * @param own true = 本类（记录 removals / errors）；false = 祖先（只取条目）
   */
  const collect = (node: any, knownFields: Set<string>, own: boolean): void => {
    /** 处理单个 @watch 装饰器；出错时提前 return（不用 continue，跨函数边界非法）。 */
    const handle = (member: any, dec: any): void => {
      const memberName = keyName(member.key)
      if (!memberName) return
      const expr = dec.expression ?? dec
      // 祖先的错误在它自己被 analyzeFile 分析时上报，这里不重复报
      const fail = (msg: string) => {
        if (!own) return
        result.errors.push({ start: dec.start ?? expr.start, end: dec.end ?? expr.end, message: msg })
      }

        if (expr.type !== 'CallExpression') {
          fail(`E-WATCH-ARG: @watch 必须以调用形式使用（@watch(source, options?)），编译期无法解析`)
          return
        }
        const args = expr.arguments ?? []

        // ---- source ----
        const sources = resolveSources(args[0], ctx)
        if (!sources) {
          fail(`E-WATCH-ARG: @watch 的 source 无法静态解析（须为字符串字面量、字符串数组或模块级字符串常量）`)
          return
        }
        // source 必须是**真信号键**。生成的 effect 读 `rc.__s.<s>.value`，
        // 普通 getter / 不存在的成员会让 `__s[s]` 为 undefined → setup() 里直接抛错，
        // 组件已降级时不做此检查（基类可能在本文件外，键集不全）。
        if (own && !comp.degradeReason) {
          const signalKeys = signalKeysOf(node, ctx, comp, knownFields)
          if (signalKeys) {
            // 多级路径按**根键**判定（"a.b" 监听的是 __s.a）
            const unknown = sources.filter((s) => !signalKeys.has(s.split('.')[0]))
            if (unknown.length) {
              fail(
                `E-WATCH-SOURCE: @watch 的 source ${unknown.map((s) => `'${s}'`).join('、')} ` +
                  `不是响应式字段（@prop/@state/@computed）—— @watch 只能监听信号`,
              )
              return
            }
          }
        }

        // ---- options ----
        let deep = false
        let immediate = false
        let once = false
        const optsNode = args[1]
        if (optsNode) {
          if (optsNode.type !== 'ObjectExpression') {
            fail(`E-WATCH-ARG: @watch 的 options 无法静态解析（须为对象字面量，deep/immediate/once 须为布尔字面量）`)
            return
          }
          let bad = false
          for (const p of optsNode.properties ?? []) {
            if (p.type === 'SpreadElement' || (p as any).type === 'ExperimentalSpreadProperty') {
              // 展开使得选项不可静态枚举（运行时 get 兜底键不受影响，但无法证明）
              bad = true
              break
            }
            const k = keyName(p.key)
            if (k === 'deep' || k === 'immediate' || k === 'once') {
              const b = boolOf(p.value)
              if (b == null) {
                bad = true
                break
              }
              if (k === 'deep') deep = b
              else if (k === 'immediate') immediate = b
              else once = b
            }
            // 其余键运行时本就不读，忽略
          }
          if (bad) {
            fail(`E-WATCH-ARG: @watch options 的 deep/immediate/once 必须是布尔字面量（编译期静态解析）`)
            return
          }
        }

        result.entries.push({
          name: memberName,
          sources,
          ...(deep ? { deep: true } : {}),
          ...(immediate ? { immediate: true } : {}),
          ...(once ? { once: true } : {}),
          ...(member.static ? { isStatic: true } : {}),
        })
        if (own) result.removals.push(lineSpan(code, dec.start ?? expr.start - 1, dec.end ?? expr.end))
    }

    for (const member of node.body?.body ?? []) {
      const memberName = keyName(member.key)
      if (!memberName) continue
      for (const dec of member.decorators ?? []) {
        const dn = decoratorName(dec)
        if (!dn || !isWatchDec(dn)) continue
        handle(member, dec)
      }
    }
  }

  // 1) 祖先条目（远 → 近），使父类处理器在子类实例上同样生效
  for (const anc of ancestorChain()) collect(anc.node, anc.fields, false)
  // 2) 本类条目 + removals + errors
  collect(cls, new Set(comp.fields.keys()), true)
  return result
}
