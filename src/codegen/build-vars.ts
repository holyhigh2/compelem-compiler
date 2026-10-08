/**
 * buildVars codegen：主模板插值表达式 → 运行时静态取值函数。
 *
 * 生成物形态（docs/TEMPLATE-CODEGEN.md §2 补充）：
 *
 *   function(__comp) { return [expr0, expr2, ...] }
 *
 * - 与 buildTemplate 的 varIndex 空间严格对齐。
 * - 表达式源码原样复制（module 作用域标识符、指令调用在组件源文件内可解析），
 *   仅做 `this` → `__comp` 改写（含字符串/模板字面量上下文感知的扫描）。
 * - 自由标识符校验：表达式内的自由标识符必须是模块绑定 / compelem 导入 /
 *   安全全局，否则返回 errors（组件不可编译）——
 *   render() 局部变量无法在注入的静态函数作用域内解析。
 */
import { keyName, parse } from '../utils/oxc'
import { IMPURE_GLOBALS as IMPURE_GLOBAL_SET, KNOWN_GLOBALS } from '../utils/globals'
import type { ComponentAnalysis } from '../types'
import { TS_SYNTAX_RE, type MainTemplate } from '../analyze/template-extract'
import { COMpelem_DIRECTIVES } from '../analyze/render-body'
import {
  applySubIdWraps,
  partitionDirectiveArgs,
  stripTs,
  type SubCandidate,
} from '../analyze/template-subs'

export interface BuildVarsResult {
  code: string | null
  errors: string[]
  /**
   * 表达式中用到的 `super.METHOD` 名集合：调用点已改写为
   * `__comp.__ce_s_METHOD(...)`，需在 class 体注入同名转发方法
   * （保留 home-object 的 super 绑定，供静态取值函数调用）。
   */
  superHelpers?: string[]
  /**
   * 自由标识符（解析成功但 filterFree 拒绝时）——供 C1 判断是否可闭包提升到父级。
   * 仅在 `code == null` 且因自由标识符失败时填充。
   */
  freeIds?: string[]
  /** C1：已闭包提升为回调实例 __bv（不写入 subs[]） */
  lifted?: boolean
  /**
   * 表达式脏依赖映射——根名 → 取值函数输出数组下标；特殊键 `''` 为
   * **常脏**下标（含动态 this / 未知 getter / 方法或 super 调用 / 不纯自由标识符
   * （Date/console/document/window/globalThis）/ 无法解析的表达式），任一视图
   * 更新都重算。与 guarded codegen 配对：取值函数只对 dirty 内下标求值，
   * 其余槽位返回占位值（区间扫描不读）。仅 verbose 依赖清单展示使用。
   */
  viewDepVarIndices?: Record<string, number[]>
}

/** generateBuildVars/generateSubBuildVars 可选项：C1 闭包提升 extras + 祖先形参白名单。 */
export interface BuildVarsOptions {
  /** subId → Object.assign 追加属性（`, __bv: function...`），由 applySubIdWraps 消费 */
  extras?: ReadonlyMap<number, string>
  /**
   * subId → 模块级 carrier 常量名（自洽子模板）。有 extras 的候选不消费它
   * （必须逐次新建才能捕获祖先形参）；无 extras 时直接引用常量，
   * 省掉每次更新重跑 fx 工厂里的 `Object.assign` + 新建闭包。
   */
  carriers?: ReadonlyMap<number, string>
  /** 额外允许的自由标识符（C1：祖先回调形参，生成 __bv 时闭包捕获） */
  extraAllowed?: ReadonlySet<string>
  /**
   * U2：自由标识符校验结果缓存（同一 compileFile 内 comp 相同，fnRaw → free 集合）。
   * C1 两阶段会对同一子模板多次调用 generateSubBuildVars（初试/提升/regen），
   * 免重复 hash + walk。仅 freeIdentifiersInFn 消费；调用方只读返回集合。
   */
  freeCache?: Map<string, Set<string> | null>
  /**
   * verbose 依赖展示（DepSummary 的根名→var 映射）才需要 per-var 链分类：
   * 子模板路径每插值多一次字符串 parse，默认关闭（该映射仅 verbose/CE_DEPS_DEBUG 展示用）。
   */
  depsDisplay?: boolean
}

/** 允许的自由标识符白名单（表达式求值环境 = 模块作用域 + __comp 参数）。
 *  与 analyze/render-body 的 D3 判定**共用同一份**（utils/globals.ts）：
 *  两处各持一份会导致 Map/Set/queueMicrotask 等通过 D3 却在 filterFree 被拒，
 *  且报错信息误称其为「render() 局部标识符」。 */
const SAFE_GLOBALS = KNOWN_GLOBALS

/**
 * SAFE_GLOBALS 中**不纯**的子集：值依赖外部状态/时钟，脏依赖映射无法静态归因
 * → 引用它们的表达式整体归入常脏（任一视图更新都重算，与全量求值行为一致）。
 */
const IMPURE_GLOBALS = IMPURE_GLOBAL_SET

// ---------- this 改写（字符串/模板字面量上下文感知） ----------

/**
 * 把表达式源码中的 `this` 全部改写为 `thisName`（默认 `__comp`）。
 * 引号串与模板字面量内容不改写；模板字面量内的 `${...}` 表达式属于 JS 上下文，
 * 其中的 this 一并改写（子视图模板经 tmplFn.call(component) 求值，语义等价）。
 * 返回 null 表示改写后引号不配对（不可能出现在合法 JS 中，防御性返回）。
 *
 * `thisName`：buildVars 的形参名是 `__comp`；per-point effect 的形参是 `rc`，
 * 内联表达式时传 `'rc'`（同一份扫描逻辑，两个调用点）。
 */
export function rewriteThis(src: string, thisName = '__comp'): string | null {
  let out = ''
  // 上下文栈：'code | "'" | '"' | '`'。模板内 `${` 压入 code（带独立花括号深度）。
  const stack: Array<{ t: string; brace?: number }> = [{ t: 'code', brace: 0 }]
  let i = 0
  const n = src.length
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]
    if (top.t === 'sq' || top.t === 'dq' || top.t === "'" || top.t === '"') {
      if (c === '\\') {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (top.t === c) {
        stack.pop()
      }
      out += c
      i++
      continue
    }
    if (top.t === 'tpl' || top.t === '`') {
      if (c === '\\') {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        out += c
        i++
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ t: 'code', brace: 0 })
        out += '${'
        i += 2
        continue
      }
      out += c
      i++
      continue
    }
    // code 上下文
    if (c === "'" || c === '"' || c === '`') {
      stack.push({ t: c })
      out += c
      i++
      continue
    }
    if (c === '{') {
      top.brace = (top.brace ?? 0) + 1
      out += c
      i++
      continue
    }
    if (c === '}') {
      if ((top.brace ?? 0) === 0 && stack.length > 1) {
        // 回到外层模板字面量
        stack.pop()
        out += c
        i++
        continue
      }
      top.brace = (top.brace ?? 0) - 1
      out += c
      i++
      continue
    }
    if (c === 't' && src.startsWith('this', i)) {
      const prev = i > 0 ? src[i - 1] : ''
      const next = i + 4 < n ? src[i + 4] : ''
      const isWord = (ch: string) => /[A-Za-z0-9_$]/.test(ch)
      if (!isWord(prev) && !isWord(next)) {
        out += thisName
        i += 4
        continue
      }
    }
    out += c
    i++
  }
  if (stack.length !== 1) return null
  return out
}

/**
 * 把表达式中的 `super.METHOD` 改写为 `__comp.__ce_s_METHOD`，
 * 并把 METHOD 收集进 helpers（供 class 体注入 `__ce_s_METHOD(...args){ return super.METHOD(...args) }`）。
 * 仅处理方法调用形态 `super.name(...)` / 方法引用；`super` 本身保留在
 * 原始 render() 内（本函数只用于抽出的静态表达式）。
 */
export function rewriteSuper(src: string, helpers: Set<string>): string {
  return src.replace(/\bsuper\.([A-Za-z_$][\w$]*)\s*(?=\()/g, (_m, name: string) => {
    helpers.add(name)
    return `__comp.__ce_s_${name}`
  })
}

// ---------- 自由标识符校验（oxc AST 精确解析） ----------

/** 表达式 this 链分类收集——roots 命中响应式字段的根名；uncertain 放弃静态分类。 */
interface ChainOut {
  roots: Set<string>
  uncertain: boolean
}

/**
 * 从 MemberExpression 沿非计算成员上溯分类：
 * - this 链且根 ∈ comp.fields → roots.add(根)（changed 键首段命中即重算，祖先键必达 ✓）
 * - this 链但根 ∉ fields（跨文件基类 prop/state/computed、方法、普通 getter）→ roots.add(根)
 *   同时 uncertain（内部依赖未知 → 常脏保底）：按名建键让 viewDepVarIndices/依赖清单可见，
 *   常脏保证槽位每次更新都重求值（脏集是并集）
 * - `this[expr]` 动态访问 / `super.X` → uncertain
 * - 局部/形参/自由标识符起始 → 不记录（依赖已由产生它的表达式侧覆盖）
 * 从链中段与完整链各上溯一次仅造成 roots 重复（Set 去重），无副作用。
 */
function classifyThisChain(node: any, out: ChainOut, comp?: ComponentAnalysis): void {
  const chain: string[] = []
  let cur: any = node
  while (cur && (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression')) {
    if (cur.computed) break
    const name = keyName(cur.property)
    if (!name) break
    chain.unshift(name)
    cur = cur.object
  }
  if (cur?.type === 'ThisExpression') {
    if (!chain.length) return // 裸 `this` 无依赖
    if (comp?.fields?.get(chain[0])) out.roots.add(chain[0])
    else {
      out.roots.add(chain[0])
      out.uncertain = true
    }
  } else if (cur?.type === 'Super') {
    out.uncertain = true
  } else if (node.object?.type === 'ThisExpression' && node.computed) {
    out.uncertain = true // this[expr]
  }
}

/**
 * 解析表达式并收集自由标识符（不在任何函数参数/局部声明、且非属性访问位置的）。
 * 解析失败返回 null（调用方放弃注入）。
 *
 * @param comp 提供 compelem 指令识别：模板回调实参整棵跳过（其自由标识符由子模板
 *             freeIdentifiersInFn 单独校验），避免把回调闭包误报为主表达式依赖。
 * @param chainOut 可选——同时分类收集 this 链根名（与自由标识符同一次解析）。
 */
function freeIdentifiers(expr: string, comp?: ComponentAnalysis, chainOut?: ChainOut): Set<string> | null {
  let ret: any
  try {
    const parsed = parse(`(function(){ return (${expr}) })`, 'buildvars-check.js')
    const fnBody = parsed.program?.body?.[0]?.expression?.body
    ret = Array.isArray(fnBody?.body)
      ? fnBody.body.find((s: any) => s?.type === 'ReturnStatement')?.argument
      : fnBody?.argument
  } catch {
    return null
  }
  if (!ret) return null
  return collectFreeWalk(ret, comp, chainOut)
}

/**
 * U2：对模块 AST 中已解析的表达式节点直接收集（免 wrapper 重复 parse）。
 *
 * 语义等价性：wrapper 是无参空环境函数，walk 从 ReturnStatement.argument 起步，
 * wrapper 本身不贡献任何作用域——直接以同一初始 scope walk 模块节点逐字一致。
 * `wrapperRisky` 命中（await/yield 等会让非 async wrapper parse 失败、而模块侧
 * 合法的构造）时回退字符串路径（含 parse 失败 → null）。
 *
 * @param exprSource 该节点的原始源码切片——风险回退路径用
 */
function freeIdentifiersFromNode(
  node: any,
  exprSource: string,
  comp?: ComponentAnalysis,
  chainOut?: ChainOut,
): Set<string> | null {
  if (!node || typeof node.type !== 'string' || wrapperRisky(node)) {
    return freeIdentifiers(exprSource, comp, chainOut)
  }
  return collectFreeWalk(node, comp, chainOut)
}

/**
 * 检测「wrapper parse 会失败、但模块 AST 合法」的构造：非嵌套函数内的
 * await/yield（wrapper 非 async/非 generator）。嵌套函数内部不下钻——
 * 其 await/yield 在两侧均合法（wrapper 亦然）。宁可多判：多判只回退
 * 字符串路径（行为不变），漏判会改变行为。
 */
function wrapperRisky(node: any): boolean {
  let risky = false
  const visit = (n: any): void => {
    if (!n || typeof n.type !== 'string' || risky) return
    const t = n.type
    if (t === 'AwaitExpression' || t === 'YieldExpression') {
      risky = true
      return
    }
    if (
      t === 'FunctionExpression' ||
      t === 'FunctionDeclaration' ||
      t === 'ArrowFunctionExpression' ||
      t === 'MethodDefinition'
    ) {
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue
      const v = n[k]
      if (Array.isArray(v)) {
        for (const c of v) {
          visit(c)
          if (risky) return
        }
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        visit(v)
        if (risky) return
      }
    }
  }
  visit(node)
  return risky
}

/** 自由标识符/this 链收集的共享 walk 体（string 解析路径与 node 直行走同一实现）。 */
function collectFreeWalk(ret: any, comp?: ComponentAnalysis, chainOut?: ChainOut): Set<string> {
  const free = new Set<string>()
  const scopes: Set<string>[] = [new Set()]

  const inScope = (name: string) => scopes.some((s) => s.has(name))

  const collectParams = (fn: any): Set<string> => {
    const s = new Set<string>()
    for (const p of fn.params ?? []) addPatternNames(p, s)
    return s
  }
  const addPatternNames = (pat: any, s: Set<string>) => {
    if (!pat) return
    switch (pat.type) {
      case 'Identifier':
        s.add(pat.name)
        break
      case 'ObjectPattern':
        for (const p of pat.properties ?? []) {
          if (p.type === 'RestElement') addPatternNames(p.argument, s)
          else addPatternNames(p.value ?? p.key, s)
        }
        break
      case 'ArrayPattern':
        for (const el of pat.elements ?? []) addPatternNames(el, s)
        break
      case 'AssignmentPattern':
        addPatternNames(pat.left, s)
        break
      case 'RestElement':
        addPatternNames(pat.argument, s)
        break
    }
  }

  /** 解构默认值表达式求值（绑定名本身由 addPatternNames 入作用域）。 */
  const walkPatternDefaults = (pat: any): void => {
    if (!pat) return
    switch (pat.type) {
      case 'AssignmentPattern':
        walkPatternDefaults(pat.left)
        walk(pat.right, false)
        break
      case 'ObjectPattern':
        for (const p of pat.properties ?? []) {
          if (p.type === 'RestElement') walkPatternDefaults(p.argument)
          else walkPatternDefaults(p.value ?? p.key)
        }
        break
      case 'ArrayPattern':
        for (const el of pat.elements ?? []) walkPatternDefaults(el)
        break
      case 'RestElement':
        walkPatternDefaults(pat.argument)
        break
    }
  }

  const isDirectiveCallee = (node: any): string | null => {
    if (!comp) return null
    if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') return null
    const imported = comp.compelemImports.get(node.callee.name)
    if (imported && COMpelem_DIRECTIVES.has(imported)) return imported
    // 自定义指令（moduleBindings 内的模块级函数调用）
    if (comp.moduleBindings?.has(node.callee.name)) return node.callee.name
    return null
  }

  const walk = (node: any, isPropPos: boolean): void => {
    if (!node || typeof node.type !== 'string') return
    switch (node.type) {
      case 'Identifier':
        if (!isPropPos && !inScope(node.name)) free.add(node.name)
        return
      case 'ThisExpression':
      case 'Super':
        return
      case 'MemberExpression':
        if (chainOut) classifyThisChain(node, chainOut, comp)
        walk(node.object, false)
        walk(node.property, !node.computed)
        return
      case 'Property':
        walk(node.key, !node.computed)
        walk(node.value, false)
        return
      case 'FunctionExpression':
      case 'FunctionDeclaration':
      case 'ArrowFunctionExpression': {
        const s = collectParams(node)
        // 参数默认值在参数作用域内求值
        for (const p of node.params ?? []) walkIn(p, s)
        scopes.push(s)
        walk(node.body, false)
        scopes.pop()
        return
      }
      case 'CatchClause': {
        const s = new Set<string>()
        if (node.param) addPatternNames(node.param, s)
        scopes.push(s)
        walk(node.body, false)
        scopes.pop()
        return
      }
      case 'VariableDeclaration': {
        const scope = scopes[scopes.length - 1]
        for (const d of node.declarations ?? []) {
          addPatternNames(d.id, scope)
          walkPatternDefaults(d.id)
          walk(d.init, false)
        }
        return
      }
      case 'CallExpression': {
        const directive = isDirectiveCallee(node)
        if (directive) {
          const args: any[] = node.arguments ?? []
          const flags = partitionDirectiveArgs(directive, args)
          walk(node.callee, true)
          args.forEach((arg, i) => {
            const isTmpl = flags[i]
            const isFn =
              arg && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')
            if (isTmpl && isFn) return
            walk(arg, false)
          })
          return
        }
        break
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'parent') continue
      const v = (node as any)[k]
      if (Array.isArray(v)) for (const c of v) walk(c, false)
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, false)
    }
  }
  const walkIn = (node: any, s: Set<string>) => {
    scopes.push(s)
    walk(node, false)
    scopes.pop()
  }

  walk(ret, false)
  return free
}

/**
 * 对完整子模板函数源码做自由标识符校验（params/prelude 入 scope 后检查 exprs）。
 * U2：`cache`（同一 compileFile 内 comp 恒定）命中时免重复 hash+walk——C1 两阶段
 * 对同一 fnRaw 多次调用（初试/提升/regen）全部命中。缓存与返回值互不共享可变引用。
 */
function freeIdentifiersInFn(
  fnSrc: string,
  comp: ComponentAnalysis,
  cache?: Map<string, Set<string> | null>,
): Set<string> | null {
  if (!cache) return freeIdentifiers(fnSrc, comp)
  const hit = cache.get(fnSrc)
  if (hit !== undefined) return hit === null ? null : new Set(hit)
  const r = freeIdentifiers(fnSrc, comp)
  cache.set(fnSrc, r === null ? null : new Set(r))
  return r
}

function filterFree(
  free: Set<string> | null,
  comp: ComponentAnalysis,
  label: string,
  extraAllowed?: ReadonlySet<string>,
): string[] | null {
  if (free == null) return [`${label} 无法解析为 AST，放弃 buildVars 注入`]
  for (const name of free) {
    if (comp.moduleBindings.has(name) || comp.compelemImports.has(name) || SAFE_GLOBALS.has(name))
      continue
    if (extraAllowed?.has(name)) continue
    return [
      `${label} 引用了 render() 局部标识符 '${name}'，无法在静态 buildVars 作用域内解析`,
    ]
  }
  return null
}

/** filterFree 失败时收集未通过的名字（C1 闭包提升判定用）。 */
function collectRejectedFree(
  free: Set<string> | null,
  comp: ComponentAnalysis,
): string[] {
  if (!free) return []
  const out: string[] = []
  for (const name of free) {
    if (comp.moduleBindings.has(name) || comp.compelemImports.has(name) || SAFE_GLOBALS.has(name))
      continue
    out.push(name)
  }
  return out
}

/**
 * 生成 buildVars 函数源码。任一插值无法安全静态化 → 返回 errors（调用方放弃注入）。
 *
 * @param source 原始源文件全文（子模板 wraps 用；缺省时跳过 wraps）
 * @param candidates 子模板候选（与 source 配对）
 */
export function generateBuildVars(
  tmpl: MainTemplate,
  comp: ComponentAnalysis,
  source?: string,
  candidates?: SubCandidate[],
  opts?: BuildVarsOptions,
): BuildVarsResult {
  const exprs: string[] = []
  const superHelpers = new Set<string>()
  const hasWraps = source != null && !!candidates?.length
  const extras = opts?.extras
  // 根名/'' → 输出下标脏映射；'' 收集常脏（uncertain/不纯）表达式
  const biMap: Record<string, number[]> = {}
  const alwaysDirty: number[] = []
  for (const v of tmpl.vars) {
    const label = `插值 #${v.index}`
    // 顺序：raw free-check（跳过模板回调）→ wraps → stripTs → TS 复检 → super 改写 → this 改写
    const chainOut: ChainOut = { roots: new Set(), uncertain: false }
    // U2：模块 AST 节点直达（免 wrapper 重 parse）；节点缺失（手工构造 vars）回退字符串路径
    const free = v.node
      ? freeIdentifiersFromNode(v.node, v.exprSource, comp, chainOut)
      : freeIdentifiers(v.exprSource, comp, chainOut)
    const freeErr = filterFree(free, comp, label, opts?.extraAllowed)
    if (freeErr) {
      return { code: null, errors: freeErr, freeIds: collectRejectedFree(free, comp) }
    }
    // 自由标识符纯度——不纯全局（Date.now/document/window 等）→ 常脏
    let impureFree = false
    if (free) {
      for (const name of free) {
        if (IMPURE_GLOBALS.has(name)) {
          impureFree = true
          break
        }
      }
    }

    let src = v.exprSource
    if (hasWraps && typeof v.start === 'number' && typeof v.end === 'number') {
      src = applySubIdWraps(v.start, v.end, source!, candidates!, extras, opts?.carriers)
    }
    src = stripTs(src)
    if (TS_SYNTAX_RE.test(src)) {
      return { code: null, errors: [`${label} 含 TS 专有语法（as/satisfies/非空断言），放弃注入`] }
    }
    src = rewriteSuper(src, superHelpers)
    const rw = rewriteThis(src)
    if (rw == null) {
      return { code: null, errors: [`${label} 的 this 改写失败（引号上下文异常）`] }
    }
    const outIdx = exprs.length
    if (chainOut.uncertain || impureFree) {
      alwaysDirty.push(outIdx)
    }
    // 按名映射与常脏**双写**（脏集是并集，行为不变）：uncertain 表达式里的已知/未声明根
    // 同样建键 → 依赖清单能按变量展示其槽位与 updater（'' 常脏仅作保底）。
    if (chainOut.roots.size) {
      for (const r of chainOut.roots) {
        let arr = biMap[r]
        if (!arr) biMap[r] = arr = []
        arr.push(outIdx)
      }
    }
    exprs.push(rw)
  }
  // guarded codegen——取值函数只对 __d 内下标求值，干净槽位返回占位 0
  // （区间扫描不读）；无 __d 即全量求值。
  const guarded = exprs.map((e, i) => `__d&&!__d.has(${i})?0:${e}`)
  const code = `function(__comp, __d) { return [${guarded.join(', ')}] }`
  if (alwaysDirty.length) biMap[''] = alwaysDirty
  const hasBi = Object.keys(biMap).length > 0
  return {
    code,
    errors: [],
    superHelpers: superHelpers.size ? [...superHelpers] : [],
    viewDepVarIndices: hasBi ? biMap : undefined,
  }
}

/**
 * 生成子模板 buildVars：`function(__comp, ...params) { prelude; return [exprs] }`。
 * prelude 与 exprs 均做 wraps（嵌套回调标 __subId）→ stripTs → TS 复检 → this 改写。
 */
export function generateSubBuildVars(
  cand: SubCandidate,
  source: string,
  comp: ComponentAnalysis,
  allCandidates: readonly SubCandidate[],
  opts?: BuildVarsOptions,
): BuildVarsResult {
  const label = `子模板 sub#${cand.subId}`
  const paramsCode = cand.params.length ? `, ${cand.params.join(', ')}` : ''
  const superHelpers = new Set<string>()
  const extras = opts?.extras

  // ---- raw free-check（wraps 前，带指令模板回调跳过）----
  const rawPrelude = cand.preludeSrc
  const rawExprs = cand.vars.map((v) => v.exprSource)
  // prelude 与 return 之间必须有换行：prelude 可能以 `!`（非空断言）结尾，
  // 同行 `return` 不会触发 ASI，直接语法错误。
  const fnRaw = `function(__comp${paramsCode}) { ${rawPrelude}\nreturn [${rawExprs.join(', ')}] }`
  const free = freeIdentifiersInFn(fnRaw, comp, opts?.freeCache)
  const freeErr = filterFree(free, comp, label, opts?.extraAllowed)
  if (freeErr) {
    return { code: null, errors: freeErr, freeIds: collectRejectedFree(free, comp) }
  }

  // ---- prelude：wraps → stripTs → TS 复检 → super 改写 ----
  let preludeOut = ''
  if (rawPrelude) {
    preludeOut = applySubIdWraps(cand.preludeStart, cand.preludeEnd, source, allCandidates, extras, opts?.carriers)
    preludeOut = stripTs(preludeOut)
    if (TS_SYNTAX_RE.test(preludeOut)) {
      return { code: null, errors: [`${label} prelude 含 TS 专有语法，放弃注入`] }
    }
    preludeOut = rewriteSuper(preludeOut, superHelpers)
  }

  // ---- exprs ----
  // 展示用根名分类：子模板取值函数恒全量求值，此映射仅供依赖清单的更新映射展示
  // —— 默认跳过（省每插值一次字符串 parse + 链分类），仅 depsDisplay（verbose）时计算
  const depsDisplay = opts?.depsDisplay === true
  const biMap: Record<string, number[]> = {}
  const alwaysDirty: number[] = []
  const exprsOut: string[] = []
  for (const v of cand.vars) {
    let src =
      typeof v.start === 'number' && typeof v.end === 'number'
        ? applySubIdWraps(v.start, v.end, source, allCandidates, extras, opts?.carriers)
        : v.exprSource
    let chainOut: ChainOut | null = depsDisplay ? { roots: new Set(), uncertain: false } : null
    if (chainOut) freeIdentifiers(src, comp, chainOut)
    src = stripTs(src)
    if (TS_SYNTAX_RE.test(src)) {
      return { code: null, errors: [`${label} 插值 #${v.index} 含 TS 专有语法，放弃注入`] }
    }
    src = rewriteSuper(src, superHelpers)
    const rw = rewriteThis(src)
    if (rw == null) {
      return { code: null, errors: [`${label} 插值 #${v.index} 的 this 改写失败`] }
    }
    exprsOut.push(rw)
    if (chainOut) {
      const outIdx = exprsOut.length - 1
      if (chainOut.uncertain) alwaysDirty.push(outIdx)
      // 与主 buildVars 同构：按名映射与常脏双写（sub 运行时恒全量求值，纯展示）
      if (chainOut.roots.size) {
        for (const r of chainOut.roots) {
          let arr = biMap[r]
          if (!arr) biMap[r] = arr = []
          arr.push(outIdx)
        }
      }
    }
  }
  if (alwaysDirty.length) biMap[''] = alwaysDirty

  const code = `function(__comp${paramsCode}) { ${preludeOut}\nreturn [${exprsOut.join(', ')}] }`
  return {
    code,
    errors: [],
    superHelpers: superHelpers.size ? [...superHelpers] : [],
    viewDepVarIndices: depsDisplay && Object.keys(biMap).length ? biMap : undefined,
  }
}
