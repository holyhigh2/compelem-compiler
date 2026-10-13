/**
 * 子模板提取：结构指令回调内的 h`` → 独立 buildTemplate + 内联 fx codegen。
 *
 * 产出 `__ce_static__.subViews[subId] = { buildTemplate, pointEffects, fx }`，并在回调函数上
 * 标注 `__subId`（Object.assign 包装，不改指令公开签名）。运行时结构指令消费静态 subs。
 *
 * 准入约束：
 * - 每个模板回调内恰好 1 个 h``（块体须为顶层 return 的直接参数）；
 * - 回调形参 / prelude / 插值中的自由标识符必须可在静态作用域解析；
 * - 模板位必须是 render() 内**字面量书写的**箭头函数/函数表达式（when 的 cases
 *   必须是对象/数组字面量且分支值均为字面量函数）。变量引用、展开、条件表达式
 *   都无法枚举出分支，拿不到 __subId；
 * - 任一回调提取失败 → SubExtractError → 整组件报错阻断构建。
 */
import type { ComponentAnalysis } from '../types'
import { COMpelem_DIRECTIVES, TEMPLATE_ARG_INDEX } from './render-body'
import {
  TAG_ONLY_DIRECTIVES,
  TS_SYNTAX_RE,
  TemplateExtractError,
  extractThisChainPaths,
  staticHtmlFragmentOf,
  type MainTemplate,
  type TemplateVarInfo,
} from './template-extract'
import { collectTemplateTagAliases } from './template'
import { stripTs } from './strip-ts'
import { topLevelReturns, unwrapExpr } from '../utils/oxc'

export class SubExtractError extends Error {}

/** 指令实参分区：与 render-body 的 TEMPLATE_ARG_INDEX 同语义。 */
export function partitionDirectiveArgs(directive: string, args: any[]): boolean[] {
  const tmplIdx = TEMPLATE_ARG_INDEX[directive]
  return args.map((_, i) => {
    if (tmplIdx === 'rest-after-0') return i >= 1
    if (Array.isArray(tmplIdx)) return tmplIdx.includes(i)
    return false
  })
}

const FN_TYPES = new Set(['ArrowFunctionExpression', 'FunctionExpression'])

function isFnNode(n: any): boolean {
  return !!n && FN_TYPES.has(n.type)
}

/** 一个被提取的模板回调子模板。start/end 为回调函数节点的绝对偏移 */
export interface SubCandidate {
  /** 按绝对 start 升序分配的稳定编号（0..n-1），写入 __subId */
  subId: number
  start: number
  end: number
  /** 形参源码片段（已去类型标注） */
  params: string[]
  /** prelude 为回调体顶层、return 之前的语句切片；表达式体为 '' */
  preludeStart: number
  preludeEnd: number
  preludeSrc: string
  /** 唯一 h`` 的 quasis cooked 串 */
  strings: string[]
  /** h`` 插值的绝对偏移与源码 */
  vars: TemplateVarInfo[]
  /**
   * 拥有本回调的结构指令的「集合实参」源码（仅 forEach；其余 undefined）。
   * 例：`forEach(this.rows, ...)` → `'this.rows'`。
   *
   * 用途：子模板 per-point effect 需要一个**信号**依赖。item 形参本身不是信号
   * （`${cell}` 的 cell 是普通参数），只有集合信号可订阅——没有它，整表替换
   * 集合不会通知任何 <td> 的文本点。嵌套子模板（`forEach(r.cells, ...)`）的
   * 集合是 `r.cells`，`r` 也是形参，故须沿 enclosingCandidates 上溯到最外层
   * 可解析为 `this.x` 的集合（见 subCollectionRoot）。
   */
  collectionExpr?: string
}

// ---------- TS 剥离（prelude / 回调体常见 `x!` 后缀非空断言） ----------
// 实现已移到零依赖模块 ./strip-ts：`template-extract` 也要用它（分析期须
// stripTs → TS 复检，与 codegen 同序），而本文件已 import 了 template-extract，
// 反向 import 会形成模块环。这里保留同名再导出，现有调用方无需改动。
export { stripTs }

/**
 * 在绝对区间 [absStart, absEnd) 内为候选回调插入 Object.assign(..., {__subId: N}) 包装。
 *
 * 回调体（`h\`...\`` 模板源码）是**死代码**：运行时对第三参只读 `__subId` / `__fx` / `__bv`
 * （`resolveSubTemplateMeta` / `buildSubTemplate` / `getSubFx`），子视图 DOM 一律来自
 * `__ce_static__.subViews[N].buildTemplate`。故包装体改发 `function(){}`。
 *
 * `carriers` 提供时更进一步：**自洽子模板**（自身 fx 已落在 `subs[N].fx`，回调不携带
 * extras）的 carrier 是编译期常量，直接引用即可 —— 该包装原本写在 fx 工厂体内，
 * 每次更新都会重跑一遍 `Object.assign` + 新建闭包；提到模块级后更新路径零分配。
 * 携带 extras（`__fx` / `__bv`，必须逐次求值以捕获祖先形参）的候选仍走每次新建。
 *
 * @param extras subId → 追加属性源码片段（如 `, __fx: function(__comp){...}`，C1 闭包提升）
 */
export function applySubIdWraps(
  absStart: number,
  absEnd: number,
  source: string,
  candidates: readonly SubCandidate[],
  extras?: ReadonlyMap<number, string>,
  carriers?: ReadonlyMap<number, string>,
): string {
  const inside = candidates.filter(
    (c) =>
      typeof c.start === 'number' &&
      typeof c.end === 'number' &&
      c.start >= absStart &&
      c.end <= absEnd &&
      c.end > c.start,
  )
  if (!inside.length) return source.slice(absStart, absEnd)

  // start ASC, end DESC：父在前，同区间不交叠（函数区间只嵌套）
  const sorted = [...inside].sort((a, b) => a.start - b.start || b.end - a.end)

  const render = (lo: number, hi: number, list: SubCandidate[]): string => {
    let out = ''
    let pos = lo
    for (const c of list) {
      if (c.start < pos) continue
      if (c.start > pos) out += source.slice(pos, c.start)
      const children = list.filter((x) => x !== c && x.start >= c.start && x.end <= c.end)
      const extra = extras?.get(c.subId) ?? ''
      const carRef = carriers?.get(c.subId)
      if (carRef && !extra) {
        // 自洽子模板：模块级常量 carrier，一次创建、全局共享
        out += carRef
      } else if (carRef) {
        // 需要逐次求值的 extras（__fx/__bv）：新建载体但不带死体
        out += `Object.assign(function(){}, {__subId: ${c.subId}${extra}})`
      } else if (extra) {
        out += `Object.assign(function(){}, {__subId: ${c.subId}${extra}})`
      } else {
        // 无 carriers（未启用提升）：保留原回调源码形态
        out += `Object.assign(${render(c.start, c.end, children)}, {__subId: ${c.subId}})`
      }
      pos = c.end
    }
    if (pos < hi) out += source.slice(pos, hi)
    return out
  }
  return render(absStart, absEnd, sorted)
}

/** 从 params 源码片段提取形参基名（`item = 1` → `item`；`...rest` → `rest`；解构取标识符）。 */
export function paramBaseNames(params: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const p of params) {
    let s = p.trim()
    if (s.startsWith('...')) s = s.slice(3)
    const eq = s.indexOf('=')
    if (eq >= 0) s = s.slice(0, eq)
    const idents = s.match(/[A-Za-z_$][\w$]*/g)
    if (idents) for (const id of idents) out.add(id)
  }
  return out
}

/** cand 的嵌套祖先（由外到内：start 升序、end 降序，严格包含）。 */
export function enclosingCandidates(
  cand: SubCandidate,
  all: readonly SubCandidate[],
): SubCandidate[] {
  const parents = all.filter(
    (o) =>
      o !== cand &&
      typeof o.start === 'number' &&
      typeof o.end === 'number' &&
      o.start <= cand.start &&
      cand.end <= o.end &&
      (o.start < cand.start || cand.end < o.end),
  )
  parents.sort((a, b) => a.start - b.start || b.end - a.end)
  return parents
}

// ---------- 形参源码 ----------

function paramsSource(fn: any): string[] {
  const out: string[] = []
  for (const p of fn.params ?? []) {
    const t = p.type
    if (t === 'Identifier') {
      out.push(p.name)
    } else if (t === 'AssignmentPattern') {
      const left = paramsPattern(p.left)
      out.push(p.init ? `${left} = ${sliceNode(p.init)}` : left)
    } else if (t === 'RestElement') {
      out.push('...' + paramsPattern(p.argument))
    } else {
      const s = sliceNode(p)
      const stripped = stripTs(s)
      if (TS_SYNTAX_RE.test(stripped)) throw new SubExtractError(`回调形参含 TS 语法：${s}`)
      out.push(stripped)
    }
  }
  return out
}

function paramsPattern(pat: any): string {
  if (!pat) return ''
  switch (pat.type) {
    case 'Identifier':
      return pat.name
    case 'ObjectPattern':
    case 'ArrayPattern': {
      const s = sliceNode(pat)
      const stripped = stripTs(s)
      if (TS_SYNTAX_RE.test(stripped)) throw new SubExtractError(`回调解构形参含 TS 语法：${s}`)
      return stripped
    }
    case 'AssignmentPattern': {
      const left = paramsPattern(pat.left)
      return pat.init ? `${left} = ${sliceNode(pat.init)}` : left
    }
    case 'RestElement':
      return '...' + paramsPattern(pat.argument)
    default:
      throw new SubExtractError(`不支持的形参模式：${pat.type}`)
  }
}

// SOURCE 注入：切片依赖完整源码；collect 时通过 withSource 设置
let __source: string = ''
function sliceNode(n: any): string {
  if (typeof n?.start !== 'number' || typeof n?.end !== 'number') {
    throw new SubExtractError('AST 节点缺少偏移，无法切片')
  }
  return __source.slice(n.start, n.end)
}

// ---------- 收集候选 ----------

interface CollectCtx {
  comp: ComponentAnalysis
  hAliases: Set<string>
  candidates: any[] // 未赋 subId 的裸 fn 节点
  seen: WeakSet<object>
  /** fn 节点 → 拥有它的 forEach 的集合实参源码 */
  collections: Map<object, string>
}

function isDirectiveCall(node: any, comp: ComponentAnalysis): string | null {
  if (node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') return null
  const imported = comp.compelemImports.get(node.callee.name)
  if (imported && COMpelem_DIRECTIVES.has(imported)) return imported
  // 外部指令（options.knownDirectives，如 outlet）：同指令点语义
  if (comp.knownDirectives?.has(node.callee.name)) return node.callee.name
  return null
}

function collectFromArgs(ctx: CollectCtx, directive: string, args: any[]): void {
  const flags = partitionDirectiveArgs(directive, args)
  // forEach 的 arg0 = 集合实参：记录源码供子模板 effect 建立信号依赖
  let collectionExpr: string | undefined
  if (directive === 'forEach' && args[0] && typeof args[0].type === 'string') {
    collectionExpr = __source.slice(args[0].start, args[0].end).trim()
  }
  args.forEach((arg, i) => {
    if (!arg || typeof arg.type !== 'string') return
    const isTemplate = flags[i]
    if (isTemplate && isFnNode(arg)) {
      if (collectionExpr !== undefined && !ctx.collections.has(arg)) {
        ctx.collections.set(arg, collectionExpr)
      }
      if (!ctx.candidates.includes(arg)) ctx.candidates.push(arg)
      walkCollect(ctx, arg)
      return
    }
    if (isTemplate && directive === 'when') {
      collectWhenCases(ctx, arg)
      return
    }
    // 模板位但不是字面量箭头（Identifier 引用 / 调用结果 / 条件表达式等）：
    // 无法静态定位回调，也就无法分配 __subId。**构建期阻断** —— 旧实现静默放过，
    // 产物里该回调没有 __subId，运行时 resolveSubTemplateMeta 返回 undefined，
    // 分支悄悄渲染成空白。此处不报，等到运行期只会看到无源的空白区域。
    if (isTemplate) {
      throw new SubExtractError(
        `@${directive} 的第 ${i + 1} 个模板实参不是字面量函数（实参类型 ${arg.type}）。` +
          `结构指令的模板回调必须是 render() 内直接书写的箭头函数/函数表达式：` +
          `变量引用、调用结果、条件表达式等都无法静态提取子模板。`,
      )
    }
    // 非模板实参：继续下钻找嵌套指令
    walkCollect(ctx, arg)
  })
}

function collectWhenCases(ctx: CollectCtx, cases: any): void {
  if (!cases || typeof cases.type !== 'string') return
  if (cases.type === 'ObjectExpression') {
    for (const prop of cases.properties ?? []) {
      if (prop.type === 'SpreadElement') {
        throw new SubExtractError(
          `when 的 cases 含展开运算符（…${prop.argument?.type ?? '未知'}）。` +
            `展开进来的分支编译器看不到，无法分配 __subId；请把各分支改为显式键值对。`,
        )
      }
      const val = prop.value
      if (!isFnNode(val)) {
        throw new SubExtractError(
          `when 的 cases 键「${prop.key?.name ?? prop.key?.value ?? '?'}」的值不是字面量函数（${val?.type ?? '未知'}）。` +
            `每个分支必须是 render() 内直接书写的箭头函数/函数表达式。`,
        )
      }
      if (!ctx.candidates.includes(val)) ctx.candidates.push(val)
      walkCollect(ctx, val)
    }
    return
  }
  if (cases.type === 'ArrayExpression') {
    for (const el of cases.elements ?? []) {
      if (!el) continue
      if (isFnNode(el)) {
        if (!ctx.candidates.includes(el)) ctx.candidates.push(el)
        walkCollect(ctx, el)
        continue
      }
      if (el.type === 'ArrayExpression') {
        // [condFn, tmplFn]
        const els = el.elements ?? []
        if (els[0]) walkCollect(ctx, els[0])
        const tmpl = els[1]
        if (!tmpl) continue
        if (!isFnNode(tmpl)) {
          throw new SubExtractError(
            `when 的 [条件, 模板] 数对里模板位不是字面量函数（${tmpl.type}）。` +
              `模板回调必须是 render() 内直接书写的箭头函数/函数表达式。`,
          )
        }
        if (!ctx.candidates.includes(tmpl)) ctx.candidates.push(tmpl)
        walkCollect(ctx, tmpl)
        continue
      }
      throw new SubExtractError(
        `when 的 cases 数组元素既不是函数也不是 [条件, 模板] 数对（${el.type}）。`,
      )
    }
    return
  }
  // 非字面量（Identifier / 条件表达式 / 调用结果等）→ 无法枚举分支，构建期阻断
  throw new SubExtractError(
    `when 的 cases 不是字面量（${cases.type}）。` +
      `编译器必须看到完整的分支列表才能逐个分配 __subId；` +
      `变量引用、条件表达式、调用结果都无法静态提取，请改为内联对象/数组字面量。`,
  )
}

function walkCollect(ctx: CollectCtx, node: any): void {
  if (!node || typeof node.type !== 'string') return
  if (ctx.seen.has(node)) return
  ctx.seen.add(node)

  const directive = isDirectiveCall(node, ctx.comp)
  if (directive) {
    collectFromArgs(ctx, directive, node.arguments ?? [])
    return
  }

  // 普通嵌套继续下钻（含非指令回调体内的指令）
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
    const c = node[key]
    if (Array.isArray(c)) for (const x of c) walkCollect(ctx, x)
    else if (c && typeof c === 'object' && typeof c.type === 'string') walkCollect(ctx, c)
  }
}

// ---------- 回调解析：唯一 h`` + prelude + vars ----------

function findTemplateHits(ctx: CollectCtx, fn: any): any[] {
  const hits: any[] = []
  const walk = (node: any): void => {
    if (!node || typeof node.type !== 'string') return
    if (
      node.type === 'TaggedTemplateExpression' &&
      node.tag?.type === 'Identifier' &&
      ctx.hAliases.has(node.tag.name)
    ) {
      hits.push(node)
      return
    }
    // 不把嵌套 h`` 的内部表达式算作额外命中（D7 已禁插值处嵌套模板）
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
      const c = node[key]
      if (Array.isArray(c)) for (const x of c) walk(x)
      else if (c && typeof c === 'object' && typeof c.type === 'string') walk(c)
    }
  }
  walk(fn.body)
  return hits
}

function buildCandidate(ctx: CollectCtx, fn: any): SubCandidate {
  const body = fn.body
  const isBlock = body?.type === 'BlockStatement'
  let hit: any
  let preludeStart = fn.start
  let preludeEnd = fn.start
  let preludeSrc = ''

  if (!isBlock) {
    const hits = findTemplateHits(ctx, fn)
    const bare = unwrapExpr(body)
    if (hits.length !== 1 || bare !== hits[0]) {
      throw new SubExtractError(
        `回调 @${fn.start} 需要唯一 h\`\` 模板（命中 ${hits.length} 个，表达式体须直接返回模板）`,
      )
    }
    hit = hits[0]
  } else {
    const rets = topLevelReturns(body.body)
    const retHits: any[] = []
    for (const r of rets) {
      const arg = unwrapExpr(r.argument)
      if (
        arg?.type === 'TaggedTemplateExpression' &&
        arg.tag?.type === 'Identifier' &&
        ctx.hAliases.has(arg.tag.name)
      ) {
        retHits.push(arg)
      }
    }
    const allHits = findTemplateHits(ctx, fn)
    if (allHits.length === 0) {
      throw new SubExtractError(`回调 @${fn.start} 内未找到 h\`\` 模板`)
    }
    if (allHits.length > 1) {
      throw new SubExtractError(`回调 @${fn.start} 内发现 ${allHits.length} 个 h\`\` 模板，codegen 要求唯一`)
    }
    if (retHits.length !== 1 || retHits[0] !== allHits[0]) {
      throw new SubExtractError(`回调 @${fn.start} 的 h\`\` 必须是函数体顶层 return 的直接参数`)
    }
    hit = retHits[0]
    // prelude = return 之前的全部顶层语句
    const retNode = rets.find((r) => unwrapExpr(r.argument) === hit)
    const stmts = body.body
    const retIdx = stmts.indexOf(retNode)
    if (retIdx > 0) {
      preludeStart = stmts[0].start
      preludeEnd = stmts[retIdx - 1].end
      preludeSrc = __source.slice(preludeStart, preludeEnd)
    }
  }

  const quasi: any = hit.quasi
  const strings: string[] = (quasi.quasis ?? []).map((q: any) => String(q.value?.cooked ?? ''))
  const exprs: any[] = quasi.expressions ?? []
  const vars: TemplateVarInfo[] = exprs.map((e: any, index: number) => {
    const exprSource = __source.slice(e.start, e.end).trim()
    // `${html(CONST)}` 静态 HTML 常量：与主模板同一套判据（staticHtmlFragmentOf）。
    // 子模板的取值同样走 generateSubBuildVars，跳过规则一致 ⇒ 参数/取值下标对齐。
    const fragment = staticHtmlFragmentOf(e, ctx.comp)
    let isDirectiveCallFlag = false
    let directiveName: string | undefined
    let moduleBindingName: string | undefined
    // TAG 位指令（bind/show/model/classes/styles/html）需要 this 链供运行期回退：
    // 如 `model(this.foo,'select')` → directiveVarChain ['foo']，`model` 指令靠它算出
    // 回写路径（缺少时 path=undefined ⇒ 值写到 ctx['undefined']，双向绑定上行静默失效）。
    // 子模板必须与主模板（template-extract 同名逻辑）保持一致。
    let directiveVarChain: string[] | undefined
    if (e.type === 'CallExpression' && e.callee?.type === 'Identifier') {
      const imported = ctx.comp.compelemImports.get(e.callee.name)
      if (imported && COMpelem_DIRECTIVES.has(imported)) {
        isDirectiveCallFlag = true
        directiveName = imported
        if (TAG_ONLY_DIRECTIVES.has(imported)) {
          directiveVarChain = extractThisChainPaths(e.arguments ?? [])
        }
      } else if (ctx.comp.knownDirectives?.has(e.callee.name)) {
        // 外部指令（options.knownDirectives，如 outlet）：同指令点语义
        isDirectiveCallFlag = true
        directiveName = e.callee.name
      } else if (ctx.comp.moduleBindings?.has(e.callee.name)) {
        // 同 template-extract：模块绑定只记名，指令判定交由标签位 codegen 放行
        moduleBindingName = e.callee.name
      }
    }
    return {
      index,
      exprSource,
      isDirectiveCall: isDirectiveCallFlag,
      directiveName,
      directiveVarChain,
      moduleBindingName,
      fragment,
      start: e.start,
      end: e.end,
    }
  })

  return {
    subId: -1,
    start: fn.start,
    end: fn.end,
    params: paramsSource(fn),
    preludeStart,
    preludeEnd,
    preludeSrc,
    strings,
    vars,
  }
}

/**
 * 收集组件 render() 内全部结构指令模板回调，按绝对 start 排序分配 subId。
 * 无主模板 / 无回调时返回 []。
 */
export function collectSubCandidates(comp: ComponentAnalysis, source: string): SubCandidate[] {
  if (!comp.renderBody) return []
  const hAliases = collectTemplateTagAliases(comp)
  if (!hAliases.size) return []

  const prevSource = __source
  __source = source
  try {
    const ctx: CollectCtx = {
      comp,
      hAliases,
      candidates: [],
      seen: new WeakSet<object>(),
      collections: new Map<object, string>(),
    }
    const body = Array.isArray(comp.renderBody) ? comp.renderBody : [comp.renderBody]
    for (const stmt of body) walkCollect(ctx, stmt)
    if (!ctx.candidates.length) return []

    // 绝对 start 升序 → 稳定 subId
    const nodes = [...ctx.candidates].sort(
      (a, b) => (a.start ?? 0) - (b.start ?? 0) || (b.end ?? 0) - (a.end ?? 0),
    )
    return nodes.map((fn, i) => {
      const cand = buildCandidate(ctx, fn)
      cand.subId = i
      const coll = ctx.collections.get(fn)
      if (coll !== undefined) cand.collectionExpr = coll
      return cand
    })
  } catch (e) {
    if (e instanceof SubExtractError || e instanceof TemplateExtractError) throw e
    throw new SubExtractError(e instanceof Error ? e.message : String(e))
  } finally {
    __source = prevSource
  }
}

/** 从 MainTemplate 提取失败时的兼容出口（D7 等在 extractMainTemplate 抛 TemplateExtractError）。 */
export type { MainTemplate }
