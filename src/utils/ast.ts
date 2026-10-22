/**
 * AST 访问工具。
 *
 * 依赖 `@babel/parser`（纯 JS 解析器）：零原生依赖，安装无需平台二进制
 * （rolldown/parseAst 虽是 oxc 原生解析，但原生 AST → JS 对象的全量物化成本
 * 反超 babel；compelem-ui 语料实测 babel 快 ~1.6x，且免去 @rolldown/binding-*
 * 的安装问题）。
 *
 * babel 对类成员不做 estree 转换（尤其有 decorators 时），故 parse 后统一做
 * 类成员归一化（见 `normalizeAst`），下游仍按 estree 词汇表
 * （PropertyDefinition / MethodDefinition / PrivateIdentifier）消费。
 * `decorators-legacy` 对应 TS experimentalDecorators 语义。
 */
import { parse as babelParse } from '@babel/parser'

export interface ParsedFile {
  program: any
  /** 源码中所有 import 声明：本地名 → { source, imported } */
  imports: Map<string, { source: string, imported: string }>
}

/**
 * 合法 JS 标识符全匹配（成员名/路径段的统一判据）。
 * 产物用 `rc.<name>` / `this.<name>` 点访问前移，非标识符名会拼出非法 JS，
 * 校验（E 码上报）与 `?.[JSON.stringify]` 降级分派都以此处为唯一定义。
 */
export const IDENT_RE = /^[A-Za-z_$][\w$]*$/

/**
 * 源码字面量序列化（JSON.stringify 绑定固定 receiver）。
 * codegen/analyze 各产物拼接统一引用此处，勿再就地 `const J = JSON.stringify`。
 */
export const stringify = (v: unknown): string => JSON.stringify(v)

/**
 * 把一条依赖路径写入依赖集合：完整路径 + （长度 >1 时）根对象名。
 * 根对象一并记录，是因为 Proxy get 会把中间层路径推入，失效判定需按根收敛。
 * deps-extract 与 render-body 两处扫描共用此内核。
 */
export function addDepPath(target: Set<string>, path: string[]): void {
  target.add(path.join('.'))
  if (path.length > 1) target.add(path[0])
}

/**
 * `this.<成员名>` 整体匹配（group1 = 成员名）。
 * E-EVENT-FN / E-REF-TYPE 的处理器与 ref 表达式解析共用此判定。
 */
export const THIS_MEMBER_RE = new RegExp(`^this\\.(${IDENT_RE.source.slice(1, -1)})$`)

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

/** 解析 TS 源码为 AST 的核心（babel → normalizeAst → imports 收集），不查/不写缓存。 */
function doParse(code: string): ParsedFile {
  const ast: any = babelParse(code, {
    sourceType: 'module',
    plugins: ['typescript', 'decorators-legacy', 'estree'],
    errorRecovery: false,
  })
  const program = ast.program
  // babel 对类成员不做 estree 转换（尤其带 decorators 时整个类体保持 babel
  // 形态：ClassProperty / ClassMethod / PrivateName），而下游 10+ 个消费文件
  // 全按 estree 词汇表（PropertyDefinition / MethodDefinition / value 包装 /
  // PrivateIdentifier）编写。在此统一归一化，差异收口于本文件一处。
  normalizeAst(program)
  const imports = new Map<string, { source: string, imported: string }>()

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

  return { program, imports }
}

/** 解析 TS 源码为 AST（带缓存，LRU：命中回尾、超限逐出最老）。 */
export function parse(code: string, id = '<anon>'): ParsedFile {
  const key = id + '::' + code.length + '::' + hash32(code)
  const hit = CACHE.get(key)
  if (hit) {
    //LRU touch：移回尾部（驱逐从头部取最久未用）
    CACHE.delete(key)
    CACHE.set(key, hit)
    return hit
  }

  const parsed = doParse(code)
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, parsed)
  return parsed
}

export function parseUncached(code: string): ParsedFile {
  return doParse(code)
}

/**
 * 旧式尖括号类型断言 `<T>x`（Babel TS 插件解析成 `TSTypeAssertion`）与显式泛型实例化
 * 调用 `f<T>(x)`（`TSInstantiationExpression`）——**都不允许进产物文本**。
 *
 * 文本判据抓不到它们：`TS_SYNTAX_RE` 里没有 `<T>` 形态，因为任何能抓住它的正则都会
 * 同时误伤 `a < b ? c : d` 这类合法比较 —— 只能按 AST 判。而 `f<T>()` 与 `<T>x` 原样
 * 进入 codegen 产物（产物按纯 JS 契约生成，且在 build-vars 里被 `(expr)` 包裹后重解析）
 * 是**语法错误**。故所有把插值/形参/prelude 文本复制进产物的出口都要过这道门（C-G6）。
 */
export function containsBlockedTsNode(node: any): boolean {
  if (!node || typeof node.type !== 'string') return false
  if (node.type === 'TSTypeAssertion' || node.type === 'TSInstantiationExpression') return true
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'parent') continue
    const c = (node as any)[key]
    if (Array.isArray(c)) {
      for (const x of c) if (containsBlockedTsNode(x)) return true
    } else if (c && typeof c === 'object' && typeof c.type === 'string' && containsBlockedTsNode(c)) {
      return true
    }
  }
  return false
}

/** blocked 节点的统一诊断文案（各出口共用，措辞一致）。 */
export function blockedTsText(label: string, exprText: string): string {
  return (
    `${label} 含旧式尖括号断言 <T>x / 显式实例化 f<T>(x)，不被支持，` +
    `请改用 as / 去掉显式类型参数：\`${exprText}\`；codegen 产物为纯 JS，请在模板外完成类型操作`
  )
}

/**
 * 跨包组件降级（连字符）的统一判据：登记过 / 标签名含 `-`（customElements.define 硬约束）/
 * `<slot>` 都算「自定义/组件标签」。knownTags 只需传入 `has` 能力（Set 或等价对象）。
 */
export function isCustomTag(tagLower: string, knownTags: { has(name: string): boolean }): boolean {
  return knownTags.has(tagLower) || tagLower.includes('-') || tagLower === 'slot'
}

/**
 * babel → estree 类成员归一化（就地改写）。
 *
 * 背景：babel 的 `estree` 插件遇到 decorators（legacy 与 TC39 皆然）时**不转换
 * 类成员**，即使无装饰器的字段也保持 babel 形态；而编译器下游全按 estree
 * 词汇表编写。三处结构差异：
 * 1. `ClassProperty` / `ClassPrivateProperty` → `PropertyDefinition`（字段形状
 *    本就同构：key / value / static，直接改 type）。
 * 2. `ClassMethod` / `ClassPrivateMethod` → `MethodDefinition`：babel 把
 *    params / body 直接放在成员上，estree 则包装在 `.value`（FunctionExpression）
 *    里，下游有 `member.value.body` 与按 `value` 的遍历。包装节点的 start 取
 *    参数区起点（value 整体不会被切片，方法体切片走 `value.body`，位置精确）。
 * 3. `PrivateName` → `PrivateIdentifier`：estree 名字在 `key.name`，babel 在
 *    `key.id.name`（类字段 key 与 `#x in obj`、成员访问统一处理）。
 *
 * 改写幂等，同一节点被重复访问（如包装后 params 被两处引用）安全。
 */
function normalizeAst(node: any): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) normalizeAst(item)
    return
  }
  if (typeof node.type !== 'string') return

  switch (node.type) {
    case 'ClassProperty':
      node.type = 'PropertyDefinition'
      break
    case 'ClassPrivateProperty':
      node.type = 'PropertyDefinition'
      break
    case 'ClassMethod':
    case 'ClassPrivateMethod': {
      node.value = {
        type: 'FunctionExpression',
        id: null,
        params: node.params,
        body: node.body,
        generator: node.generator,
        async: node.async,
        start: node.params?.[0]?.start ?? node.body?.start ?? node.start,
        end: node.body?.end ?? node.end,
      }
      node.computed = node.computed ?? false
      node.type = 'MethodDefinition'
      break
    }
    case 'PrivateName':
      node.type = 'PrivateIdentifier'
      node.name = node.id?.name
      // 必须删除遗留的 id 子节点：名字已折叠进 node.name，若保留，下游
      // render-body 的 D3 扫描会递归进入这个幽灵 Identifier，其 parent 是
      // PrivateIdentifier（isFreeIdentifierRef 无此 case → default 放行），
      // 私有字段/方法访问（this.#x）被误判为「未知自由标识符」。
      delete node.id
      break
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const item of child) if (item && typeof item === 'object') normalizeAst(item)
    } else if (child && typeof child === 'object') {
      normalizeAst(child)
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
    // 私有名节点（normalizeAst 后 key.name 形如 '#x'）不是自由标识符；
    // 防御 case：即使其子树残留 Identifier 也不应按自由引用判定。
    case 'PrivateIdentifier':
      return false
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

/**
 * 收集绑定模式（形参 / 解构 / `const` 声明左侧）里的**全部标识符名**。
 *
 * 单一实现：历史上 compile.ts / component.ts / render-body.ts 各抄一份，
 * 抄的过程已经开始漂移 —— 只有 render-body 那份处理 `TSParameterProperty`
 * （`constructor(private readonly x)`），其余两份会漏掉这类绑定名，
 * 漏掉的绑定在 D3 自由标识符判定里被当成「未知自由标识符」。
 * `TSParameterProperty` 分支对纯 JS 模式无害（该节点类型只可能来自 TS 形参）。
 */
export function collectPatternNames(pat: any, into: Set<string>): void {
  if (!pat) return
  switch (pat.type) {
    case 'Identifier':
      into.add(pat.name)
      break
    case 'ObjectPattern':
      for (const p of pat.properties ?? []) {
        if (p.type === 'RestElement') collectPatternNames(p.argument, into)
        else collectPatternNames(p.value ?? p.key, into)
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

/** 静态成员/属性 key 取名字符串。 */
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
 * `f<T>()` / `<T>x` 这类写法在某些模块里解包失败、被误判为未知自由标识符。
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
