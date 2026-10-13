/**
 * Oxc AST 访问工具。
 *
 * 依赖 `rolldown/parseAst`（rolldown 自带 oxc 解析器），不额外引入 `oxc-parser`，
 * 避免版本漂移与重复依赖。
 */
import { parseAst } from 'rolldown/parseAst'

export interface ParsedFile {
  program: any
  /** 源码中所有 import 声明：本地名 → { source, imported } */
  imports: Map<string, { source: string; imported: string }>
}

/** parse 缓存 LRU 上限（dev 长会话防内存增长；驱逐仅失 memo，重 parse 结果等价）。 */
const CACHE_MAX = 512
const CACHE = new Map<string, ParsedFile>()

/**
 * FNV-1a 32 位字符串哈希（导出供 vite transform 缓存 key 用，U4）。
 *
 * ⚠️ 缓存 key 不能只用 `id + '::' + code.length`：同一路径下若源码变了但长度
 * 恰好相同（不同写法替换、测试用例复用同一 id），会命中旧 AST 返回错误结果。
 * 实测踩过：两个仅模板内容不同的 fixture 长度都是 39，V4 用例因此少报了违规。
 * 这里补一个轻量哈希（不引依赖），保证「同 id 不同源码」一定 miss。
 */
export function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/** 解析 TS/TSX 源码为 Oxc AST（带缓存，LRU：命中回尾、超限逐出最老）。 */
export function parse(code: string, id = '<anon>'): ParsedFile {
  const key = id + '::' + code.length + '::' + hash32(code)
  const hit = CACHE.get(key)
  if (hit) {
    //LRU touch：移回尾部（驱逐从头部取最久未用）
    CACHE.delete(key)
    CACHE.set(key, hit)
    return hit
  }

  const program: any = parseAst(code, { lang: 'ts', sourceType: 'module' })
  const imports = new Map<string, { source: string; imported: string }>()

  for (const node of program.body ?? []) {
    if (node.type !== 'ImportDeclaration') continue
    const source = node.source?.value
    if (typeof source !== 'string') continue
    for (const spec of node.specifiers ?? []) {
      const local = spec.local?.name
      if (!local) continue
      // ImportSpecifier 有 imported；ImportDefaultSpecifier / NamespaceSpecifier 没有
      const imported =
        spec.imported?.name ?? spec.imported?.value ?? (spec.type === 'ImportDefaultSpecifier' ? 'default' : '*')
      imports.set(local, { source, imported })
    }
  }

  const parsed: ParsedFile = { program, imports }
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, parsed)
  return parsed
}

/**
 * 深度优先遍历，遇到嵌套函数是否下钻由 `descendInto` 决定。
 *
 * `visit(node, parent)` 返回 `false` 表示「不要下钻该节点的子节点」。
 */
export function walk(
  node: any,
  visit: (node: any, parent: any | null) => boolean | void,
  parent: any = null,
  opts: { descendIntoFunctions?: boolean } = {},
): void {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') {
    if (visit(node, parent) === false) return
  }
  const isFn =
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'MethodDefinition' ||
    node.type === 'PropertyDefinition'
  if (isFn && opts.descendIntoFunctions === false) return

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit, node, opts)
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      walk(child, visit, node, opts)
    }
  }
}

/** 收集函数体顶层的 return 语句（不下钻嵌套函数，避免误计回调内 return）。 */
export function topLevelReturns(body: any): any[] {
  const out: any[] = []
  const nodes: any[] = Array.isArray(body) ? [...body] : body ? [body] : []
  // 用显式栈做「顶层」遍历：遇到块语句下钻，遇到函数停止
  const stack = [...nodes]
  while (stack.length) {
    const n = stack.pop()!
    if (!n || typeof n.type !== 'string') continue
    if (n.type === 'ReturnStatement') {
      out.push(n)
      continue
    }
    if (
      n.type === 'FunctionDeclaration' ||
      n.type === 'FunctionExpression' ||
      n.type === 'ArrowFunctionExpression'
    ) {
      continue
    }
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const child = n[key]
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === 'string') stack.push(c)
      } else if (child && typeof child === 'object' && typeof child.type === 'string') {
        stack.push(child)
      }
    }
  }
  return out
}

/** 判断节点是否为一个「自由标识符引用」（非成员访问的属性位、非声明、非标签）。 */
export function isFreeIdentifierRef(node: any, parent: any | null): boolean {
  if (!node || node.type !== 'Identifier') return false
  if (!parent) return true
  switch (parent.type) {
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      // `a.b` 里的 `b` 不是自由引用；`a` 是
      return parent.object === node
    case 'Property':
    case 'PropertyDefinition':
    case 'MethodDefinition':
      return parent.key !== node || parent.computed
    case 'VariableDeclarator':
      return parent.id !== node
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return !(parent.params ?? []).includes(node) && parent.id !== node
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return false
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return false
    case 'CallExpression':
    case 'NewExpression':
      return parent.callee === node || (parent.arguments ?? []).includes(node)
    case 'TSAsExpression':
    case 'TSTypeAssertion':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return true
    default:
      return true
  }
}

/** Oxc 的静态成员/属性 key 取名字符串。 */
export function keyName(key: any): string | null {
  if (!key) return null
  if (key.type === 'Identifier') return key.name
  if (key.type === 'PrivateIdentifier') return '#' + key.name
  if (key.type === 'Literal' || key.type === 'StringLiteral') return String(key.value)
  return null
}

/* ══════════════════ 统一 AST 语义助手 ══════════════════
 *
 * 以下助手此前在多个 analyze 模块里各抄一份，抄的过程中已经开始漂移
 * （`unwrapExpr` 四份的包装类型集合各不相同、`thisChain` 两份对 PrivateIdentifier
 * 的处理不同）。因为编译器全程不跑 TS 类型检查，漂移不会报错，只会安静地给出
 * 不同的分析结果 —— 故统一到本文件，各模块改 import。
 */

/** TS 包装/透明节点类型：解包后语义与内层表达式相同。 */
const TS_WRAPPER_TYPES = new Set([
  'TSAsExpression', //  x as T
  'TSSatisfiesExpression', //  x satisfies T
  'TSNonNullExpression', //  x!
  'TSTypeAssertion', //  <T>x（老式尖括号断言）
  'TSInstantiationExpression', //  f<T>() 的调用侧泛型
  'ParenthesizedExpression', //  (x)
])

/** 是否为 TS 包装/透明节点（`unwrapExpr` 会剥掉的那一类）。 */
export function isTsWrapper(node: any): boolean {
  return !!node && typeof node.type === 'string' && TS_WRAPPER_TYPES.has(node.type)
}

/**
 * 剥掉 TS 包装与括号节点，取可静态分析的本体。
 *
 * 类型集合取上述 6 种的**并集** —— 早期各副本只认其中一部分，导致
 * `f<T>()` / `<T>x` 这类写法在某些模块里解包失败、被误判成未知自由标识符。
 *
 * 循环守卫：只有当 `.expression` 确实是个节点时才前进，否则返回原节点。
 * （旧实现在 template-subs / template-extract 里写的是 `cur.expression ?? cur`，
 *  一旦遇到没有 `.expression` 的包装节点就会**死循环**。）
 */
export function unwrapExpr(node: any): any {
  let cur = node
  while (cur && typeof cur.type === 'string' && TS_WRAPPER_TYPES.has(cur.type)) {
    const inner = cur.expression
    if (!inner || typeof inner.type !== 'string') break
    cur = inner
  }
  return cur
}

/**
 * 装饰器的本地名：`@tag("x")` / `@prop({...})` / `@computed` → `'tag'` / `'prop'` / `'computed'`。
 * 支持 `@ns.dec(...)` 形式（取属性名）。
 */
export function decoratorName(dec: any): string | null {
  const expr = dec?.expression ?? dec
  if (!expr) return null
  if (expr.type === 'CallExpression') {
    const callee = expr.callee
    if (callee?.type === 'Identifier') return callee.name
    if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier') return callee.property.name
    return null
  }
  if (expr.type === 'Identifier') return expr.name
  return null
}

/** 类声明的基类名：`class A extends B` → `'B'`，`extends ns.B` → `'B'`；无基类返回 null。 */
export function superClassName(node: any): string | null {
  const sc = node?.superClass
  if (!sc) return null
  if (sc.type === 'Identifier') return sc.name
  if (sc.type === 'MemberExpression' && sc.property?.type === 'Identifier') return sc.property.name
  return null
}

/**
 * `this.a.b.c` → `['a','b','c']`；不是 this 链 / 含计算属性（`this[a]`）/ 属性名取不到
 * 时返回 null。空的 `this` 也返回 null（无字段可记）。
 *
 * 属性名走 `keyName`，因此 `#private` 字段带 `#` 前缀 —— 与模板侧
 * `template-extract` 的依赖键保持一致（旧实现有一份漏了前缀，会把
 * `this.#x` 与 `this.x` 混成同一个键）。
 */
export function thisChain(node: any): string[] | null {
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
