/**
 * 模板形态分析。
 *
 * 本模块做两件事：
 *   1. **D7 违规检测**：模板插值位置不得「直接嵌套」另一个模板（禁止写法）。
 *   2. （后续 B 步骤）静态解析模板 HTML 结构，产出 html / updatePointMetas / skipVarIdx。
 *
 * ## D7 为什么必须禁（背景）
 *
 * 模板解析遇到嵌套在插值里的 Template 会**就地 splice 展开**，
 * 使 `varIndex` 编号不再与模板的 quasis 下标线性对应：
 *
 * ```ts
 * // 会 splice → 编号非线性
 * h`<div>${h`<span>${a}</span>`} ${b}</div>`
 * // 不会 splice → 编号线性
 * h`<div>${ifTrue(c, () => h`<span>${a}</span>`)} ${b}</div>`
 * ```
 *
 * 禁止前者后，`varIndex` 变纯线性递增 → 编译器可以「一个 quasis 下标 ↔ 一个更新点」
 * 直接生成扁平取值代码（C 步骤的前提）。
 *
 * ## 判定边界：为什么「指令回调里的模板」不算嵌套
 *
 * 关键在**求值时机**。模板字面量求值时，`${}` 里的插值表达式会被立刻求值并放进
 * `Template.vars`；而指令回调是**未被调用的函数**，其体内的模板要到 executor 运行时
 * 才求值，压根进不了 `vars`。因此：
 *
 *   - `${h`...`}` / `${cond ? h`...` : ''}` → 插值一求值就产生 Template 实例 → 命中
 *   - `${ifTrue(c, () => h`...`)}`          → 插值是 DirectiveInstance → 不命中
 *
 * 判定规则因此是：**从插值位置出发，不穿过任何函数边界就能到达 `h` 模板 → 违规。**
 */
import type { ComponentAnalysis } from '../types'

/** 插值位置上允许「穿透」继续向内检查的表达式类型。 */
const PASSTHROUGH = new Set([
  'ConditionalExpression', // cond ? h`` : ''
  'LogicalExpression', // cond || h``
  'SequenceExpression', // (a, h``)
])

/** 函数边界：越过它就离开了当前模板的插值结构。 */
const FN_BOUNDARY = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
])

export interface TemplateIssue {
  /** 违规模板在源码中的起始/结束偏移 */
  start: number
  end: number
  /** 违规插值表达式的偏移 */
  exprStart: number
  exprEnd: number
  message: string
}

/**
 * 从插值表达式出发，判断能否「不穿过函数边界」就到达一个 h 模板。
 * @returns 命中的 h 模板节点，无则 null
 */
export function reachesBareTemplate(node: any, hAliases: Set<string>, depth = 0): any | null {
  if (!node || typeof node.type !== 'string') return null
  if (depth > 32) return null

  // 函数边界：回调体内的模板不属于本模板的插值结构
  if (FN_BOUNDARY.has(node.type)) return null

  if (node.type === 'TaggedTemplateExpression') {
    const tag = node.tag
    if (tag?.type === 'Identifier' && hAliases.has(tag.name)) return node
    // 非 h 的标签模板（罕见）：其内部插值继续查
    for (const e of node.quasi?.expressions ?? []) {
      const hit = reachesBareTemplate(e, hAliases, depth + 1)
      if (hit) return hit
    }
    return null
  }

  // 裸模板字符串里再嵌 h 模板：`${`x${h``}`}`
  if (node.type === 'TemplateLiteral') {
    for (const e of node.expressions ?? []) {
      const hit = reachesBareTemplate(e, hAliases, depth + 1)
      if (hit) return hit
    }
    return null
  }

  // 函数调用：实参里的 h 模板会被立刻求值；
  // 指令回调由上面的 FN_BOUNDARY 拦掉，故此处下钻 arguments 不会误报。
  if (node.type === 'CallExpression' || node.type === 'NewExpression') {
    for (const a of node.arguments ?? []) {
      const hit = reachesBareTemplate(a, hAliases, depth + 1)
      if (hit) return hit
    }
    return null
  }

  if (PASSTHROUGH.has(node.type)) {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const c = node[key]
      if (Array.isArray(c)) {
        for (const x of c) {
          const hit = reachesBareTemplate(x, hAliases, depth + 1)
          if (hit) return hit
        }
      } else if (c && typeof c === 'object' && typeof c.type === 'string') {
        const hit = reachesBareTemplate(c, hAliases, depth + 1)
        if (hit) return hit
      }
    }
  }

  return null
}

/** 找出源码里 h 标签函数的全部别名（通常就是 `h`，import 时可改名）。 */
export function collectTemplateTagAliases(comp: ComponentAnalysis): Set<string> {
  const out = new Set<string>()
  for (const [local, imported] of comp.compelemImports) {
    if (imported === 'h') out.add(local)
  }
  return out
}

/** 判断节点是否是一个 h`` 模板。 */
function isHTemplate(node: any, hAliases: Set<string>): boolean {
  if (!node || node.type !== 'TaggedTemplateExpression') return false
  const tag = node.tag
  return !!tag && tag.type === 'Identifier' && hAliases.has(tag.name)
}

/**
 * U5：检查单个 h`` 模板节点的全部插值（D7），把违规追加到 out。
 * analyzeRender 内联 D7 检查（renderBody 单 walk）与 param-defaults 子树扫描共用。
 */
export function d7IssuesAt(node: any, hAliases: Set<string>, out: TemplateIssue[]): void {
  for (const expr of node.quasi?.expressions ?? []) {
    const hit = reachesBareTemplate(expr, hAliases)
    if (hit) {
      out.push({
        start: node.start,
        end: node.end,
        exprStart: expr.start,
        exprEnd: expr.end,
        message:
          'D7: 模板插值位置禁止直接嵌套另一个 h`` 模板；' +
          '请改用 ifTrue / ifElse / forEach 等指令包裹（回调内的模板不进入 vars）',
      })
    }
  }
}

/**
 * U5：在子树内收集全部 D7 违规（DFS 前序，与 collectTemplateIssues 单遍语义一致）。
 * analyzeRender 用它扫描「主 scan 不进入」的函数参数默认值区域，保持覆盖对等。
 * ⚠️ 不 return 于 h`` 节点：指令回调里的模板自身插值同样要检查（继续下钻）。
 */
export function collectIssuesInSubtree(
  node: any,
  hAliases: Set<string>,
  out: TemplateIssue[],
  seen?: WeakSet<object>,
): void {
  const s = seen ?? new WeakSet<object>()
  const visit = (n: any): void => {
    if (!n || typeof n !== 'object' || typeof n.type !== 'string') return
    if (s.has(n)) return
    s.add(n)
    if (isHTemplate(n, hAliases)) d7IssuesAt(n, hAliases, out)
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end') continue
      const c = n[key]
      if (Array.isArray(c)) for (const x of c) visit(x)
      else if (c && typeof c === 'object' && typeof c.type === 'string') visit(c)
    }
  }
  visit(node)
}

/**
 * 扫描 render() 函数体，收集全部 D7 违规。
 *
 * 每个 h 模板的每个插值表达式都会单独检查；命中的插值各自报告一次，
 * 便于一次性定位所有待改点。
 */
export function collectTemplateIssues(comp: ComponentAnalysis): TemplateIssue[] {
  const hAliases = collectTemplateTagAliases(comp)
  if (!hAliases.size) return []

  const issues: TemplateIssue[] = []
  const seen = new WeakSet<object>()
  for (const stmt of comp.renderBody ?? []) collectIssuesInSubtree(stmt, hAliases, issues, seen)
  return issues
}
