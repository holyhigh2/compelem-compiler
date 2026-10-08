/**
 * cssVars / @computed getter 的响应式依赖静态提取（编译期静态分析）。
 *
 * 语义（只收集响应式读取；宁可省略键走全根兜底，不可欠收集）：
 *
 *  1. 纯语法并集：三目/逻辑短路不裁剪，凡可达的 this 链读取一律入集。
 *  2. 依赖入口三合一：
 *     - this 链（`this.a.b`；`this.arr[i]` 取静态前缀 `arr` 并继续扫描下标表达式）
 *     - 别名等价类（`let that = this`、传递、后置赋值——预扫描 fixpoint，进箭头、不进非箭头函数体）
 *     - 解构捕获（`const {a, b: {c}} = this` → 记 `a` / `b.c`；rest/数组解构 → 放弃该键）
 *     失败入口：裸 this / 裸别名逃逸（`return that`、`f(this)`、`[...this]`）→ 该 getter 放弃（键省略）
 *  3. 链根五级分级：
 *     ① fields（prop/state/computed）→ 记录链路 + 根
 *     ② queryFields（@query/@queryAll，非响应式）→ 记录死条目
 *     ③ own bodies（方法/普通 getter/箭头字段）→ 内联扫体（不记 root，inlineDepth ≤ 8 防环）
 *     ④ 同文件祖先（localClasses + classInfoOf 记忆）→ 同级处理
 *     ⑤ 未知（跨文件基类成员、mixin 链、this.slots、super 等）→ 放弃该 getter
 *  4. 调用表达式：callee 为 this/别名链 → 按③分级；自由/模块/局部 callee → 只扫实参
 *     （模块函数的 this 非组件实例）；FunctionExpression/Declaration 体内含 this → 放弃。
 *  5. 自由/局部/形参/模块标识符一律忽略（非响应式读取不收集）。
 *  6. 嵌套箭头共享 this 等价类，词法下钻。
 *
 * 失败语义：cssVars 任一失败 → 整体 undefined（不注入，运行时全根兜底）；
 * @computed 失败键跳过（该键运行时全根兜底），全部失败 → 注入空对象；无 @computed → undefined。
 *
 * 调试：环境变量 DEPS_TRACE=1 时每次失败向 stderr 输出 `[deps-fail] <原因标签>`。
 */
import type { ComponentAnalysis } from '../types'
import { keyName } from '../utils/oxc'
import { classInfoOf, superClassName } from './component'

interface ExtractCtx {
  comp: ComponentAnalysis
  localClasses: Map<string, any>
  /** 本组件可识别的 compelem 导入原名集合（用于链终点 CompElem 判定） */
  aliases: Set<string>
  /** this 等价类：预扫描收集的别名名 */
  aliasNames: Set<string>
  /** 豁免的 ThisExpression（别名/解构声明 init 位，身份判定） */
  exemptThis: Set<object>
  deps: Set<string>
  failed: boolean
  seen: WeakSet<object>
  /** 内联扫体深度（防环） */
  depth: number
}

function record(ctx: ExtractCtx, path: string[]) {
  const full = path.join('.')
  ctx.deps.add(full)
  if (path.length > 1) ctx.deps.add(path[0])
}

/** TS 包装节点解包（`this as any` / `that!` 等） */
function isTsWrapper(node: any): boolean {
  const t = node?.type
  return (
    t === 'TSAsExpression' ||
    t === 'TSSatisfiesExpression' ||
    t === 'TSNonNullExpression' ||
    t === 'TSInstantiationExpression' ||
    t === 'ParenthesizedExpression'
  )
}
function unwrapTs(node: any): any {
  let cur = node
  while (cur && isTsWrapper(cur)) cur = cur.expression
  return cur
}

/** 置失败标记；DEPS_TRACE=1 时输出原因标签（见文件头）。 */
function failAt(ctx: ExtractCtx, where: string) {
  if (typeof process !== 'undefined' && process.env?.DEPS_TRACE) {
    console.error('[deps-fail]', where)
  }
  ctx.failed = true
}

// ---------------------------------------------------------------------------
// 预扫描：this 别名等价类 + 解构捕获
// ---------------------------------------------------------------------------

function addAlias(ctx: ExtractCtx, name: string, mark: () => void) {
  if (ctx.aliasNames.has(name)) return
  ctx.aliasNames.add(name)
  mark()
}

/** `const {a, b: {c}} = <this|别名>` 的模式绑定：成员位记依赖，rest/数组解构放弃该键 */
function bindMemberPattern(ctx: ExtractCtx, pat: any, prefix: string[], mark: () => void) {
  if (!pat) return
  switch (pat.type) {
    case 'Identifier':
      record(ctx, [...prefix, pat.name]) // 记录不触发 fixpoint（非别名变化）
      break
    case 'ObjectPattern':
      for (const p of pat.properties ?? []) {
        if (p.type === 'RestElement') {
          failAt(ctx, 'destructure-rest')
          return
        }
        const key = keyName(p.key)
        if (!key || p.computed) {
          failAt(ctx, 'destructure-key')
          return
        }
        bindMemberPattern(ctx, p.value, [...prefix, key], mark)
      }
      break
    case 'AssignmentPattern':
      bindMemberPattern(ctx, pat.left, prefix, mark)
      break
    case 'ArrayPattern':
    case 'RestElement':
      failAt(ctx, 'destructure-array')
      break
  }
}

/** 声明绑定：顶层 Identifier → 别名；ObjectPattern → 按成员捕获记依赖 */
function bindFrom(ctx: ExtractCtx, pat: any, mark: () => void) {
  if (!pat) return
  switch (pat.type) {
    case 'Identifier':
      addAlias(ctx, pat.name, mark)
      break
    case 'ObjectPattern':
      for (const p of pat.properties ?? []) {
        if (p.type === 'RestElement') {
          failAt(ctx, 'bind-rest')
          return
        }
        const key = keyName(p.key)
        if (!key || p.computed) {
          failAt(ctx, 'bind-key')
          return
        }
        bindMemberPattern(ctx, p.value, [key], mark)
      }
      break
    case 'AssignmentPattern':
      bindFrom(ctx, pat.left, mark)
      break
    case 'ArrayPattern':
      failAt(ctx, 'bind-array')
      break
  }
}

/**
 * fixpoint 预扫描：收集别名等价类与解构捕获。
 * 进入箭头（共享 this），不进入 FunctionExpression/FunctionDeclaration/Class 体。
 */
function prescanBody(ctx: ExtractCtx, nodes: any[]): void {
  const walk = (node: any, mark: () => void): void => {
    if (!node || typeof node.type !== 'string') return
    const t = node.type
    if (
      t === 'FunctionExpression' ||
      t === 'FunctionDeclaration' ||
      t === 'ClassDeclaration' ||
      t === 'ClassExpression'
    ) {
      return
    }
    if (t === 'VariableDeclarator') {
      const init = unwrapTs(node.init)
      if (init) {
        if (init.type === 'ThisExpression') {
          ctx.exemptThis.add(init)
          bindFrom(ctx, node.id, mark)
        } else if (init.type === 'Identifier' && ctx.aliasNames.has(init.name)) {
          bindFrom(ctx, node.id, mark)
        }
      }
    } else if (t === 'AssignmentExpression') {
      const right = unwrapTs(node.right)
      if (right && node.left?.type === 'Identifier') {
        if (right.type === 'ThisExpression') {
          ctx.exemptThis.add(right)
          addAlias(ctx, node.left.name, mark)
        } else if (right.type === 'Identifier' && ctx.aliasNames.has(right.name)) {
          addAlias(ctx, node.left.name, mark)
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const c of child) walk(c, mark)
      } else if (child && typeof child === 'object' && typeof child.type === 'string') {
        walk(child, mark)
      }
    }
  }

  for (let round = 0; round < 16; round++) {
    let changed = false
    const mark = () => {
      changed = true
    }
    for (const n of nodes) walk(n, mark)
    if (!changed) return
    if (round === 15) failAt(ctx, 'alias-round15') // 别名链过深未收敛 → 保守放弃
  }
}

// ---------------------------------------------------------------------------
// 链解析与根分级
// ---------------------------------------------------------------------------

/**
 * 从表达式解析「以 this/别名起始的最长静态路径」。
 * 返回 `{ path: [...] }`（可能为空 = 裸 this/别名）、`{ path: null }`（根级动态 `this[x]`）、
 * `null`（非 this/别名 起始）。遇到中间 computed 止步于前缀（更深下标由 scanChainRemainders 扫描）。
 */
function resolveChain(ctx: ExtractCtx, node: any): { path: string[] | null } | null {
  let cur = unwrapTs(node)
  if (cur.type === 'ThisExpression') return { path: [] }
  if (cur.type === 'Identifier' && ctx.aliasNames.has(cur.name)) return { path: [] }
  if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
    if (cur.computed) {
      const inner = resolveChain(ctx, cur.object)
      if (!inner || inner.path === null) return inner
      if (inner.path.length === 0) return { path: null } // this[x] 根级动态
      return inner // 前缀止于 computed；下标表达式留给 scanChainRemainders
    }
    const name = keyName(cur.property)
    const inner = resolveChain(ctx, cur.object)
    if (!inner) return null
    if (inner.path === null) return inner
    if (!name) return { path: null }
    return { path: [...inner.path, name] }
  }
  return null
}

/** 分级结果：命中（已记录/已内联）/ 未命中（继续向上找）/ 失败。 */
function applyLevel(
  ctx: ExtractCtx,
  level: {
    fields: Map<string, any>
    queryFields?: Set<string>
    bodies?: Map<string, any>
    methods?: Set<string>
    getters?: Set<string>
  },
  path: string[],
): 'hit' | 'miss' | 'fail' {
  const root = path[0]
  if (level.fields.has(root)) {
    record(ctx, path)
    return 'hit'
  }
  if (level.queryFields?.has(root)) {
    record(ctx, path) // @query 非响应式：死条目（运行时永不通知，无害）
    return 'hit'
  }
  if (level.bodies?.has(root)) {
    inlineScan(ctx, level.bodies.get(root))
    return 'hit' // 内联扫体，不记 root
  }
  if (level.methods?.has(root) || level.getters?.has(root)) return 'fail' // 有名无体 → 未知
  return 'miss'
}

/** 链根五级分级：① own → ② query → ③ own bodies → ④ 同文件祖先 → ⑤ 未知失败。 */
function classifyPath(ctx: ExtractCtx, path: string[]): void {
  const comp = ctx.comp
  const own = applyLevel(
    ctx,
    {
      fields: comp.fields,
      queryFields: comp.queryFields,
      bodies: comp.bodies,
      methods: comp.ownMethods,
      getters: comp.ownGetters,
    },
    path,
  )
  if (own !== 'miss') {
    if (own === 'fail') failAt(ctx, 'own-no-body')
    return
  }

  let node: any = comp.cls ?? ctx.localClasses.get(comp.className)
  const seenCls = new Set<any>()
  for (let i = 0; node && i < 8; i++) {
    const sup = superClassName(node)
    if (!sup) break
    if (ctx.aliases.has('CompElem') && sup === 'CompElem') break // 链终点：根未知
    const parent = ctx.localClasses.get(sup)
    if (!parent || seenCls.has(parent)) {
      if (!parent) failAt(ctx, 'cross-file') // 跨文件基类 → 未知
      break
    }
    seenCls.add(parent)
    const info = classInfoOf(parent, ctx.aliases)
    const hit = applyLevel(
      ctx,
      {
        fields: info.fields,
        queryFields: info.queryFields,
        bodies: info.bodies,
        methods: info.methods,
        getters: info.getters,
      },
      path,
    )
    if (hit !== 'miss') {
      if (hit === 'fail') failAt(ctx, 'ancestor-no-body')
      return
    }
    node = parent
  }
  failAt(ctx, 'unknown-root') // 五级尽未命中（含 this.slots / super）→ 该键省略 → 运行时全根兜底
}

// ---------------------------------------------------------------------------
// 主扫描
// ---------------------------------------------------------------------------

function subtreeHasThis(node: any): boolean {
  if (!node || typeof node.type !== 'string') return false
  if (node.type === 'ThisExpression') return true
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
    const c: any = node[key]
    if (Array.isArray(c)) {
      for (const x of c) if (subtreeHasThis(x)) return true
    } else if (c && typeof c === 'object' && typeof c.type === 'string') {
      if (subtreeHasThis(c)) return true
    }
  }
  return false
}

/** 裸别名的合法位：声明/赋值/链根。其余（实参、return、spread…）= 逃逸 → 失败。 */
function legalAliasPos(node: any, parent: any): boolean {
  if (!parent) return false
  if (parent.type === 'VariableDeclarator') return parent.id === node || parent.init === node
  if (parent.type === 'AssignmentExpression') return parent.left === node
  if (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') {
    return parent.object === node
  }
  return false
}

/** 链分类后补扫 computed 下标表达式（`this.arr[this.i]` 的 `this.i` 不可漏）。 */
function scanChainRemainders(ctx: ExtractCtx, node: any): void {
  let cur: any = node
  while (cur) {
    if (isTsWrapper(cur)) {
      cur = cur.expression
      continue
    }
    if (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression') {
      if (cur.computed) scanNode(ctx, cur.property, cur)
      cur = cur.object
      continue
    }
    break
  }
}

function toStatements(bodyNode: any): any[] {
  if (!bodyNode) return []
  if (bodyNode.type === 'BlockStatement') return bodyNode.body ?? []
  return [{ type: 'ExpressionStatement', expression: bodyNode }]
}

/** 内联扫体：方法/getter/箭头字段的函数体直接展开扫描（不记 root）。 */
function inlineScan(ctx: ExtractCtx, bodyNode: any): void {
  if (ctx.failed) return
  if (ctx.depth >= 8) {
    failAt(ctx, 'depth') // 深度超限（递归调用环）→ 保守放弃
    return
  }
  ctx.depth++
  const snapAlias = new Set(ctx.aliasNames)
  try {
    const nodes = toStatements(bodyNode)
    prescanBody(ctx, nodes)
    for (const stmt of nodes) scanNode(ctx, stmt, null)
  } finally {
    ctx.aliasNames = snapAlias
    ctx.depth--
  }
}

function scanNode(ctx: ExtractCtx, node: any, parent: any): void {
  if (ctx.failed || !node || typeof node.type !== 'string') return
  if (ctx.seen.has(node)) return
  ctx.seen.add(node)

  // --- TS 包装：透传 parent（裸 this/别名的合法位判定要看真实位置） ---
  if (isTsWrapper(node)) {
    scanNode(ctx, node.expression, parent)
    return
  }

  // --- 非箭头函数：体内含 this（含参数默认值/嵌套箭头）→ 非组件 this → 放弃 ---
  if (node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration') {
    if (subtreeHasThis(node)) {
      failAt(ctx, 'fn-this')
      return
    }
    // 无 this → 参数/体可安全下钻（通用规则）
  }

  // --- super：组件外基类成员 → 未知 ---
  if (node.type === 'Super') {
    failAt(ctx, 'super')
    return
  }

  // --- this/别名链（只在最外层分类一次） ---
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const parentIsMember =
      parent &&
      (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
      parent.object === node
    if (!parentIsMember) {
      const resolved = resolveChain(ctx, node)
      if (resolved) {
        if (resolved.path === null) {
          failAt(ctx, 'dynamic-index') // 根级动态 this[x]
          return
        }
        classifyPath(ctx, resolved.path)
        if (ctx.failed) return
        scanChainRemainders(ctx, node)
        return
      }
      // 非 this/别名 起始 → 通用下钻（object 内可能有调用包裹的 this 链）
    }
  }

  // --- 裸 this（豁免位 = 别名/解构声明 init，由预扫描记录） ---
  if (node.type === 'ThisExpression') {
    if (!ctx.exemptThis.has(node)) {
      failAt(ctx, 'bare-this')
      return
    }
    return
  }

  // --- 裸别名（链位已由 classify 消费；到这里 = 逃逸） ---
  if (node.type === 'Identifier' && ctx.aliasNames.has(node.name)) {
    if (!legalAliasPos(node, parent)) {
      failAt(ctx, 'alias-escape')
      return
    }
    return
  }

  // --- 其余标识符（自由/局部/形参/模块绑定）：一律忽略，规则5 ---
  // --- 通用下钻：三目/逻辑/嵌套箭头纯语法并集 ---
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) scanNode(ctx, c, node)
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      scanNode(ctx, child, node)
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function runExtract(
  comp: ComponentAnalysis,
  localClasses: Map<string, any> | undefined,
  body: any[],
): string[] | undefined {
  const ctx: ExtractCtx = {
    comp,
    localClasses: localClasses ?? new Map(),
    aliases: new Set(comp.compelemImports.values()),
    aliasNames: new Set<string>(),
    exemptThis: new Set<object>(),
    deps: new Set<string>(),
    failed: false,
    seen: new WeakSet<object>(),
    depth: 0,
  }
  prescanBody(ctx, body)
  for (const stmt of body) scanNode(ctx, stmt, null)
  if (ctx.failed) return undefined
  return [...ctx.deps]
}

/**
 * 提取 `get cssVars()` 的响应式依赖。无法静态化时返回 undefined（不注入，运行时全根兜底）。
 * 无 cssVars getter 或 getter 体为空 → 返回 []（合法的空依赖）。
 */
export function extractCssDeps(
  comp: ComponentAnalysis,
  localClasses?: Map<string, any>,
): string[] | undefined {
  if (!comp.cssVarsBody) return undefined // 无自有 getter（可能继承基类）→ 不注入
  if (!comp.cssVarsBody.length) return []
  return runExtract(comp, localClasses, comp.cssVarsBody)
}

/**
 * 提取各 `@computed` getter 的响应式依赖（per-key）：
 * - 失败键跳过（该键运行时全根兜底）；全部失败 → 注入空对象；
 * - 无 @computed → undefined（不注入）。
 */
export function extractComputedDeps(
  comp: ComponentAnalysis,
  localClasses?: Map<string, any>,
): Record<string, string[]> | undefined {
  if (!comp.computedBodies || comp.computedBodies.size === 0) return undefined
  const out: Record<string, string[]> = {}
  for (const [name, body] of comp.computedBodies) {
    if (!body.length) {
      out[name] = []
      continue
    }
    const deps = runExtract(comp, localClasses, body)
    if (deps === undefined) continue // 失败键省略 → 运行时全根兜底
    out[name] = deps
  }
  return out
}
