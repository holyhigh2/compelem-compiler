/**
 * render() 函数体的依赖提取与结构分析。
 *
 * 这是编译器最关键的一层。核心规则（已由 DEPENDENCY-MODEL.md 的 7/7 实测确认）：
 *
 *  1. 只有「响应式字段白名单」内的成员访问（`this.x`）才推入依赖收集列表。
 *     `this.someMethod` / `this.slots` / `this.inputRef` 普通访问不推入。
 *  2. 深层路径（`this.obj.deep`）推 `obj.deep`；根对象推 `obj`。
 *  3. `@computed` 只推入自身属性名，不展开其内部依赖。
 *  4. 指令实参的作用域归属：
 *     - `ifElse(cond, a, b)` 的 `cond` → 调用方作用域（主视图）
 *     - `forEach(list, keyFn, tmplFn)` 的 `list`/`keyFn` → 调用方作用域
 *     - 指令的**模板回调体**（`a` / `b` / `tmplFn`）→ 子视图（per-UpdatePoint）
 */
import type { ComponentAnalysis } from '../types'
import { isFreeIdentifierRef, keyName } from '../utils/oxc'
import { KNOWN_GLOBALS } from '../utils/globals'
import {
  collectIssuesInSubtree,
  collectTemplateTagAliases,
  d7IssuesAt,
  type TemplateIssue,
} from './template'

/** compelem 内置指令名集合（用于识别「模板回调实参」的位置）。 */
export const COMpelem_DIRECTIVES = new Set([
  'bind', 'show', 'model', 'classes', 'styles',
  'forEach', 'ifTrue', 'ifElse', 'when', 'slot', 'html',
])

/** 指令实参中，哪些下标是「模板回调」（其函数体属于子视图）。导出供 template-subs 分区。 */
export const TEMPLATE_ARG_INDEX: Record<string, number[] | 'rest-after-0'> = {
  ifTrue: [1],
  ifElse: [1, 2],
  forEach: [2],
  slot: [0],
  when: 'rest-after-0',
}

interface ScanCtx {
  comp: ComponentAnalysis
  /** 当前扫描作用域：main = 主视图，sub = 某个指令的模板回调体 */
  inSub: boolean
  /** 主视图依赖收集 */
  mainDeps: Set<string>
  /** 子视图依赖：指令「节点标识」→ 路径集合。用回调节点的 start 偏移做标识（回调唯一） */
  subDeps: Map<number, Set<string>>
  /** 子视图所属回调节点 start（inSub 时有效） */
  subKey: number
  /** 遇到的降级信号 */
  degrades: string[]
  /** 已访问节点，防止 oxc 节点上的意外回指造成无限递归 */
  seen: WeakSet<object>
  /**
   * 当前词法作用域内已绑定的标识符（形参、局部变量、模块级声明）。
   * 出现在此集合里的 Identifier 不是「自由标识符」，不触发 D3。
   */
  bound: Set<string>
  /** U5：h 标签别名（D7 检查 + 主模板命中识别） */
  hAliases: Set<string>
  /** U5：D7 违规收集（原 collectTemplateIssues 独立一遍，现并入本 scan——renderBody 单 walk） */
  issues: TemplateIssue[]
  /** 当前所在函数嵌套深度（0 = render 顶层；主模板 h`` 只在 0 层可命中） */
  fnDepth: number
  /** 可选 sink：主模板 h`` 节点（供 extractMainTemplate 免重扫） */
  sinks?: { mainHits: any[] }
}

/**
 * 把一条 `this.a.b.c` 链还原为字段路径。
 *
 * 从**最外层** MemberExpression 出发向内回溯；返回 `['a','b','c']`，
 * 非 this 起始或含 computed 访问时返回 null。
 */
function thisChain(node: any): string[] | null {
  const chain: string[] = []
  let cur: any = node
  while (cur && (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression')) {
    if (cur.computed) return null // this[x] / a[x] → 动态访问
    const name = keyName(cur.property)
    if (!name) return null
    chain.unshift(name)
    cur = cur.object
  }
  if (!cur || cur.type !== 'ThisExpression') return null
  return chain.length ? chain : null
}

/** 记录一条依赖到当前作用域。 */
function record(ctx: ScanCtx, path: string[]) {
  const target = ctx.inSub ? (ctx.subDeps.get(ctx.subKey) ?? new Set<string>()) : ctx.mainDeps
  const full = path.join('.')
  target.add(full)
  // 根对象也推入（Proxy get 会把中间层路径推入）
  if (path.length > 1) target.add(path[0])
  if (ctx.inSub) ctx.subDeps.set(ctx.subKey, target)
}

/**
 * 扫描函数体，递归处理指令。
 *
 * `nodes` 为语句数组（非单个表达式），保证只扫当前函数体的顶层内容。
 */
function scan(ctx: ScanCtx, nodes: any[]) {
  for (const stmt of nodes) scanNode(ctx, stmt, null)
}

/** 收集一个函数节点的形参名。 */
function collectParams(fn: any, into: Set<string>) {
  for (const p of fn.params ?? []) collectPatternNames(p, into)
}

/** 收集解构/简单绑定模式里的所有标识符名。 */
function collectPatternNames(pat: any, into: Set<string>) {
  if (!pat) return
  switch (pat.type) {
    case 'Identifier':
      into.add(pat.name)
      break
    case 'ObjectPattern':
      for (const prop of pat.properties ?? []) {
        if (prop.type === 'RestElement') collectPatternNames(prop.argument, into)
        else collectPatternNames(prop.value ?? prop.key, into)
      }
      break
    case 'ArrayPattern':
      for (const el of pat.elements ?? []) collectPatternNames(el, into)
      break
    case 'AssignmentPattern':
      collectPatternNames(pat.left, into)
      break
    case 'RestElement':
      collectPatternNames(pat.argument, into)
      break
    case 'TSParameterProperty':
      collectPatternNames(pat.parameter, into)
      break
  }
}

/**
 * U5：函数参数子树的 D7 扫描。
 *
 * 主 scan 的 isFn 分支只收集形参名（collectParams），不下钻 params——
 * 而原 collectTemplateIssues 是通用全量下钻（含参数默认值）。
 * 为保持 D7 覆盖对等，这里对每个 param 整棵子树跑一遍与原 visit 等价的收集。
 */
function scanParamsD7(ctx: ScanCtx, params: any[]): void {
  for (const p of params ?? []) collectIssuesInSubtree(p, ctx.hAliases, ctx.issues)
}

/** 收集函数体顶层（不下钻嵌套函数）的所有局部声明名。 */
export function collectLocals(bodyNodes: any[], into: Set<string>) {
  const stack = [...bodyNodes]
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n.type !== 'string') continue
    if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression' ||
      n.type === 'ClassDeclaration'
    ) {
      // 嵌套函数自身的名字对当前作用域可见，但其内部声明不可见
      if (n.type === 'FunctionDeclaration' && n.id?.name) into.add(n.id.name)
      continue
    }
    if (n.type === 'VariableDeclaration') {
      for (const d of n.declarations ?? []) collectPatternNames(d.id, into)
    }
    if (n.type === 'ClassDeclaration' && n.id?.name) into.add(n.id.name)
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
      const c: any = n[key]
      if (Array.isArray(c)) {
        for (const x of c) if (x && typeof x.type === 'string') stack.push(x)
      } else if (c && typeof c === 'object' && typeof c.type === 'string') {
        stack.push(c)
      }
    }
  }
}

/** 在受限的 bound 集合下执行 fn，返回后恢复原集合。 */
function withBound<T>(ctx: ScanCtx, extra: Iterable<string>, fn: () => T): T {
  const added: string[] = []
  for (const n of extra) {
    if (!ctx.bound.has(n)) {
      ctx.bound.add(n)
      added.push(n)
    }
  }
  try {
    return fn()
  } finally {
    for (const n of added) ctx.bound.delete(n)
  }
}

function scanNode(ctx: ScanCtx, node: any, parent: any) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
  // 防环：oxc 节点可能带非枚举回指；同时避免同一子树被重复扫描
  if (!ctx.seen) ctx.seen = new WeakSet<object>()
  if (ctx.seen.has(node)) return
  ctx.seen.add(node)

  // --- U5：D7 内联检查 + 主模板节点收集（原 collectTemplateIssues / extractMainTemplate 各自一遍的 walk，现并入本 scan） ---
  if (node.type === 'TaggedTemplateExpression' && node.tag?.type === 'Identifier' && ctx.hAliases.has(node.tag.name)) {
    d7IssuesAt(node, ctx.hAliases, ctx.issues)
    if (ctx.fnDepth === 0 && ctx.sinks) ctx.sinks.mainHits.push(node)
  }

  // --- 响应式字段访问：this.x / this.x.y.z ---
  // 只在「链的最外层」处理一次：多层链的内层节点（this.obj、this.obj.deep）由父节点统一记录，
  // 避免重复与路径截断。判定条件不能用 `node.object === ThisExpression`（那只覆盖单层），
  // 必须靠「父节点不是把本节点当 object 的 MemberExpression」+ 链回溯到 this。
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const parentIsMember =
      parent &&
      (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
      parent.object === node
    if (!parentIsMember) {
      // 整条链的最外层；thisChain 内部会校验链根是否为 ThisExpression
      const chain = thisChain(node)
      if (chain !== null) {
        const root = chain[0]
        const field = ctx.comp.fields.get(root)
        if (field) {
          record(ctx, chain)
        } else if (ctx.comp.ownMethods.has(root)) {
          // 自有方法值不可变 → 不推入依赖，也不降级。
        } else {
          // 普通 getter（以及跨文件基类的未知成员）。
          //
          // 普通 getter 的链按依赖记录：getter 内部可能读响应式字段，静态推不出，
          // 但取值表达式内联后每轮 effect 都会重新求值 → 依赖在执行期动态建立
          // （getter 读 `this.__s.a.value` 即建链），由动态订阅兜住正确性。
          // 派生 getter 是生态里最常见的写法，不该因静态推不出而放弃静态管线。
          record(ctx, chain)
        }
        // 自有方法调用（this.goto、this.fmt）不推入依赖，也不降级：值不可变、不影响正确性。
      } else if (node.object?.type === 'ThisExpression' && node.computed) {
        // this[expr] 动态访问：静态推不出依赖，但内联产物里表达式按源改写 this→rc
        // 后每轮 effect 求值，取值经注入访问器读 __s.*.value 动态建链（build-vars 侧
        // classifyThisChain 归入 uncertain/常脏）。静态推不出只意味着「无法预过滤」，
        // 正确性由 per-point effect 的动态 track + 求值期建链兜住。
      }
    }
  }

  // --- 调用 compelem 指令：区分「实参」与「模板回调」 ---
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier') {
    const fnName = node.callee.name
    const importedAs = ctx.comp.compelemImports.get(fnName)
    const isDirective = !!importedAs && COMpelem_DIRECTIVES.has(importedAs)

    if (isDirective) {
      const tmplIdx = TEMPLATE_ARG_INDEX[importedAs]
      const args: any[] = node.arguments ?? []
      args.forEach((arg: any, i: number) => {
        const isTemplate =
          tmplIdx === 'rest-after-0' ? i >= 1 : Array.isArray(tmplIdx) && tmplIdx.includes(i)
        if (isTemplate && (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression')) {
          const key = arg.start
          const prev = ctx.subKey
          ctx.subKey = key
          const wasSub = ctx.inSub
          ctx.inSub = true
          // 回调形参与局部变量属于子视图作用域
          const names = new Set<string>()
          collectParams(arg, names)
          scanParamsD7(ctx, arg.params)
          if (arg.body?.type === 'BlockStatement') collectLocals(arg.body.body, names)
          ctx.fnDepth++
          withBound(ctx, names, () => {
            if (arg.body?.type === 'BlockStatement') scan(ctx, arg.body.body)
            else scanNode(ctx, arg.body, arg)
          })
          ctx.fnDepth--
          ctx.inSub = wasSub
          ctx.subKey = prev
          return
        }
        // 非模板实参：属于调用方作用域
        scanNode(ctx, arg, node)
      })
      // 不继续按通用规则下钻（已手动处理实参）
      return
    }

    // 其他函数调用：若 callee 是自由标识符且不在 import/指令白名单 → D3
    if (isFreeIdentifierRef(node.callee, node)) {
      const local = node.callee.name
      if (!ctx.bound.has(local) && !ctx.comp.compelemImports.has(local) && !isKnownGlobal(local)) {
        ctx.degrades.push(`D3: render() 内调用未知自由标识符 ${local}()`)
      }
    }
  }

  // --- 自由标识符引用（非调用位）--- D3
  if (node.type === 'Identifier' && isFreeIdentifierRef(node, parent)) {
    const local = node.name
    if (!ctx.bound.has(local) && !ctx.comp.compelemImports.has(local) && !isKnownGlobal(local)) {
      ctx.degrades.push(`D3: render() 内出现未知自由标识符 ${local}`)
    }
  }

  // 通用下钻。
  //
  // 嵌套函数（非指令模板回调的那些，如 `list.find(it => it.id === this.x)` 里的箭头函数）
  // 必须继续下钻：其中的 `this.x` 读取同样会被推入依赖。这里只把它们的形参/局部变量
  // 并入 bound 作用域后递归。
  const isFn =
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  if (isFn) {
    const names = new Set<string>()
    collectParams(node, names)
    scanParamsD7(ctx, node.params)
    if (node.body?.type === 'BlockStatement') collectLocals(node.body.body, names)
    ctx.fnDepth++
    withBound(ctx, names, () => {
      if (node.body?.type === 'BlockStatement') scan(ctx, node.body.body)
      else scanNode(ctx, node.body, node)
    })
    ctx.fnDepth--
    return
  }

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

// 全局白名单见 utils/globals.ts（与 build-vars 共用同一份，避免两处名单分叉）
function isKnownGlobal(name: string): boolean {
  return KNOWN_GLOBALS.has(name)
}

/** 主视图依赖提取结果。 */
export interface RenderAnalysis {
  /** 主视图依赖路径（对应 ViewDepMap） */
  viewDeps: string[]
  /** 子视图依赖：回调节点 start 偏移 → 路径列表 */
  subViewDeps: Map<number, string[]>
  /** 降级原因列表（空表示未降级） */
  degrades: string[]
  /**
   * 硬性违规（当前只有 D7：模板内直接嵌套模板）。
   *
   * 与 degrades 的区别：degrades 是「静态推不出，放弃注入（降级）」，
   * errors 是「写法违反约束，必须改代码」——二者都导致降级，但 errors 需要在
   * 构建期报给用户，因为它是可修的、且修掉后才能启用编译期产物。
   */
  errors: TemplateIssue[]
}

/** 对单个组件的 render() 做依赖分析。 */
export function analyzeRender(comp: ComponentAnalysis, sinks?: { mainHits: any[] }): RenderAnalysis {
  const bound = new Set<string>(comp.moduleBindings ?? [])
  //render 顶层局部声明（const/let/var/function）不是「未知自由标识符」——与嵌套函数
  //（isFn 分支 collectLocals）和指令回调（collectParams/collectLocals）同规则。
  //D3 只拦真正未声明的标识符；模板插值引用到的局部变量由 filterFree
  //给出准确原因（buildvars-e2e §E 的正则已预留该分类）。
  if (Array.isArray(comp.renderBody)) collectLocals(comp.renderBody, bound)
  const ctx: ScanCtx = {
    comp,
    inSub: false,
    mainDeps: new Set<string>(),
    subDeps: new Map<number, Set<string>>(),
    subKey: -1,
    degrades: [],
    seen: new WeakSet<object>(),
    bound,
    hAliases: collectTemplateTagAliases(comp),
    issues: [],
    fnDepth: 0,
    sinks,
  }
  if (comp.renderBody) scan(ctx, comp.renderBody)

  // 去重降级原因
  const degrades = [...new Set(ctx.degrades)]
  const subViewDeps = new Map<number, string[]>()
  for (const [k, v] of ctx.subDeps) subViewDeps.set(k, [...v])

  return {
    viewDeps: [...ctx.mainDeps],
    subViewDeps,
    degrades,
    errors: ctx.issues,
  }
}
