/**
 * 从 render() 函数体提取「主视图模板」：h`` 模板字面量 + 各插值的信息。
 *
 * 主视图定义：在 render() 函数体内、**不穿过任何函数边界**即可到达的 h`` 模板
 * （指令回调内的模板属于子视图，有独立的子模板 codegen）。
 * D7 已禁止「插值处直接嵌套模板」，因此主模板的 vars 编号是纯线性的。
 */
import type { ComponentAnalysis } from '../types'
import { COMpelem_DIRECTIVES } from './render-body'
import { collectTemplateTagAliases } from './template'
import { stripTsChecked } from './strip-ts'
import { blockedTsText, containsBlockedTsNode, thisChain, topLevelReturns, unwrapExpr } from '../utils/ast'

/**
 * 这些语句包住的 `return h`` `` **可能被跳过** ⇒ 条件会被整体丢弃（D8）。
 *
 * 只列"有条件语义"的语句：裸块 `{ return }` 一定执行、`try { return } finally {}`
 * 里的 return 也一定会发生，两者都不算丢条件，不进来（避免误报）。
 */
const SKIPS_RETURN_STMTS: ReadonlySet<string> = new Set([
  'IfStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
  'SwitchStatement',
])

export interface TemplateVarInfo {
  /** Template 序下标 */
  index: number
  /** 表达式源码（原样切片，可能含 TS 语法时已报错） */
  exprSource: string
  /** 是否为「直接调用 compelem 指令函数」（isDirective 的静态证明，见 B1 §3.3） */
  isDirectiveCall: boolean
  directiveName?: string
  /**
   * callee 是**模块绑定**的函数名（自定义指令 `directive()` 工厂产物，或普通格式化函数）。
   *
   * 静态上无法区分二者 —— 模块级 `pick`/`fmt`/`t` 与 `ripples`/`tooltip` 长得一样。
   * 故 extract 阶段**不**据此判定指令，只在**标签位**由 codegen 放行
   * （`<div ${ripples()}>` 是自定义指令的规范用法；文本位 `${fmt(x)}` 是取值）。
   *
   * 误判代价不对称：文本位误判成指令会生成 `get(i)[1][0]`，而该 var 的值是
   * 字符串/数字 → `undefined[0]` 在挂载时直接抛 TypeError。
   */
  moduleBindingName?: string
  /**
   * `${html(CONST)}` —— **静态 HTML 常量折叠点**。
   *
   * 实参是**同文件模块级 `const`**，初始化器是字符串字面量（无插值的模板字面量亦可），
   * 且整串**不含大写字母**。命中则把该串在编译期解析成节点、拼进建树序列 ——
   * 于是 nodeSn / paths / nodes 全部照常编号，**不产生 ups / fx / pointEffects**，
   * 运行期零开销（省掉每实例一次 `innerHTML` 解析 + 一个更新点 + 一个 effect）。
   *
   * **不含大写字母**是与运行期 `Html` 指令严格对齐的判据：`convertHTML` 在
   * `HAS_UPPER_RE.test(html)` 为假时**原样返回**（见 src/directives/Html.ts:15-16），
   * 即大小写转换（camelCase 属性 → kebab、`PascalCase` 标签 → 已注册标签名）根本不发生。
   * 故折叠子集与运行期路径**逐字节等价**；含大写则不折，落回运行期 `html()`，
   * 由它自己做转换 —— 语义零变化，只是慢。
   *
   * 不满足条件时返回 undefined：该 var 照常按 `html` 指令点编译，**不是错误**。
   * 折叠是纯优化，命中与否都不改变运行结果。跨文件常量天然落在这里
   * （compileFile 是单文件纯函数，不解析 import）。
   *
   * 存在本字段时该 var **不占用 varIndex**（build-vars 同步跳过）——
   * 两处共用同一个标记，保证 `exprs` 与 `ups` 仍 1:1。
   */
  fragment?: string
  /** TAG 指令实参中 this 链的全前缀路径（供运行时 directiveVarChain 回退） */
  directiveVarChain?: string[]
  /** 表达式在原始源码中的绝对起止偏移（子模板 wraps / prelude 切片用） */
  start?: number
  end?: number
  /**
   * 模块 AST 中的表达式节点（U2：freeIdentifiers 免重复 parse——模块已解析过，
   * 直接对该节点做自由标识符/this 链分类收集，语义与 wrapper 重解析一致）。
   * 手工构造的 vars 可不带（调用方回退字符串 parse 路径）。
   */
  node?: any
}

/**
 * 把「Template 序」的插值表压成「ups 序」（数组下标即 `UpOut.varIndex`）。
 *
 * ## 为什么两个序不一样
 * `${html(CONST)}` 静态片段在编译期就折进建树序列，**不产生 up、不占 varIndex**
 * （见 `TemplateVarInfo.fragment`）。于是 varIndex 与 quasis 下标不再线性对应：
 *
 * ```html
 * <div>${html(FRAG)}${this.n}</div>
 * ```
 *
 * 这里 `FRAG` 的 `index` 是 0 但没有 varIndex，`this.n` 的 `index` 是 1 而 varIndex 是 0。
 * 任何按 `v.index` 建表、再用 `up.varIndex` 去查的消费方，都会把 varIndex=0 解到
 * 片段 var 上 —— 取值表达式错、且读不到任何信号（该点永不更新）。
 *
 * 本函数是该对照的**唯一真相源**：与 `build-vars`（`v.fragment` 同跳）保持同一序号空间。
 * 消费方：`compile.ts`（主模板 varIndexToExpr/Range）、`codegen/render-effect.ts`
 * （`buildSubInliner`）、`codegen/template-dom.ts`（isPureTmpl 自比对）。
 */
export function varsByUpIndex(vars: readonly TemplateVarInfo[]): TemplateVarInfo[] {
  const out: TemplateVarInfo[] = []
  for (const v of vars) {
    if (v.fragment) continue
    out.push(v)
  }
  return out
}

export interface MainTemplate {
  /** quasis 的 cooked 串（长度 = 插值数 + 1） */
  strings: string[]
  vars: TemplateVarInfo[]
  start: number
  end: number
  /** prelude 为 render() 顶层、return 之前的语句切片；无则为 '' */
  preludeStart: number
  preludeEnd: number
  preludeSrc: string
}

export class TemplateExtractError extends Error {}

/** 仅允许出现在 TAG 位置的内置指令（其非模板实参可静态提取 this 链）。 */
export const TAG_ONLY_DIRECTIVES = new Set(['bind', 'show', 'model', 'classes', 'styles', 'html'])

/** 与运行期 `Html` 指令的 `HAS_UPPER_RE` 同源：含大写则不做折叠（运行期自己转）。 */
const HAS_UPPER_RE = /[A-Z]/

/**
 * 判定 `${html(CONST)}` 静态 HTML 常量折叠点，返回可折叠的 HTML 串，不满足则 undefined。
 *
 * 判据（全部满足才折）：
 *  1. 表达式是 `html(IDENT)`：`html` 解析到从 compelem 导入的 `html`，实参恰好 1 个裸标识符；
 *  2. `IDENT` 在本文件解析到**模块级 `const`**（`let`/`var` 可重新赋值，折叠会固化某次运行值）；
 *  3. 初始化器是字符串字面量，或**无插值**的模板字面量；
 *  4. 整串不含大写字母（见 TemplateVarInfo.fragment 的等价性论证）。
 */
export function staticHtmlFragmentOf(e: any, comp: ComponentAnalysis): string | undefined {
  if (e?.type !== 'CallExpression' || e.callee?.type !== 'Identifier') return undefined
  if (comp.compelemImports.get(e.callee.name) !== 'html') return undefined
  const args = e.arguments ?? []
  if (args.length !== 1 || args[0]?.type !== 'Identifier') return undefined

  const decl = comp.moduleConstInits?.get(args[0].name)
  const init = decl?.init
  if (!init) return undefined

  let html: string
  if (init.type === 'Literal' && typeof init.value === 'string') html = init.value
  else if (init.type === 'TemplateLiteral' && (init.expressions ?? []).length === 0) {
    html = init.quasis?.[0]?.value?.cooked ?? ''
  } else return undefined

  if (HAS_UPPER_RE.test(html)) return undefined
  return html
}

/** 解包 TS 包装节点 —— 统一实现在 utils/ast#unwrapExpr。 */

/**
 * 把一条 `this.a.b.c` 成员链还原为字段路径数组（最外层在前）。
 * 非 this 起始 / 含 computed 访问时返回 null。
 *
 * 统一实现在 utils/ast#thisChain（属性名走 keyName，`#private` 带 `#` 前缀，
 * 否则 `this.#x` 与 `this.x` 会混成同一个依赖键）。
 */

/**
 * 提取 TAG 指令实参中的 this 链全前缀路径。
 *
 * 收集的路径与指令工厂调用期间运行时建立的依赖对齐：
 * `model(this.form.name)` → `['form', 'form.name']`（根 + 全路径前缀链）。
 * 仅收集可静态解析的 this 成员链；表达式中其他部分忽略。
 */
export function extractThisChainPaths(args: any[]): string[] | undefined {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string) => { if (!seen.has(p)) { seen.add(p); out.push(p) } }
  const walk = (node: any) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const parentIsMember = false // 由 thisChain 从最外层回溯，内层不再单独处理
      if (!parentIsMember) {
        const chain = thisChain(node)
        if (chain) {
          let acc = ''
          for (const seg of chain) {
            acc = acc ? acc + '.' + seg : seg
            push(acc)
          }
          return // 整条链已处理
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
      const c = node[key]
      if (Array.isArray(c)) for (const x of c) walk(x)
      else if (c && typeof c === 'object' && typeof c.type === 'string') walk(c)
    }
  }
  for (const a of args) walk(a)
  return out.length ? out : undefined
}

export function extractMainTemplate(
  comp: ComponentAnalysis,
  source: string,
  /** U5：analyzeRender 单 walk 时顺带收集的 depth-0 h`` 节点；提供则免本函数重扫。 */
  preHits?: any[],
): MainTemplate | null {
  const hAliases = collectTemplateTagAliases(comp)
  if (!hAliases.size) return null
  if (!comp.renderBody) return null

  const hits: any[] = []
  if (preHits !== undefined) {
    hits.push(...preHits)
  } else {
    // 不下钻函数边界：回调内模板属于子视图
    const walk = (node: any) => {
      if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
      if (
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'FunctionExpression' ||
        node.type === 'FunctionDeclaration'
      ) {
        return
      }
      if (
        node.type === 'TaggedTemplateExpression' &&
        node.tag?.type === 'Identifier' &&
        hAliases.has(node.tag.name)
      ) {
        hits.push(node)
      }
      for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'start' || key === 'end' || key === 'parent') continue
        const c = node[key]
        if (Array.isArray(c)) for (const x of c) walk(x)
        else if (c && typeof c === 'object' && typeof c.type === 'string') walk(c)
      }
    }
    for (const stmt of comp.renderBody) walk(stmt)
  }

  if (!hits.length) return null
  if (hits.length > 1) {
    throw new TemplateExtractError(
      `组件 ${comp.className} 的 render() 中发现 ${hits.length} 个主视图 h\`\` 模板` +
        `（指令回调内的模板不计）；codegen 要求主视图模板唯一`,
    )
  }

  const tmpl = hits[0]
  const quasi: any = tmpl.quasi
  // cooked == null = 模板串含**非法转义**（如 Windows 路径 `C:\users` 里的 `\u`）：
  // tagged template 容忍非法转义（ES2018 revision），静默取 '' 会丢字，必须报错要求转义
  const strings: string[] = (quasi.quasis ?? []).map((q: any, qi: number) => {
    if (q.value?.cooked == null) {
      const raw = typeof q.start === 'number' && typeof q.end === 'number' ? source.slice(q.start, q.end) : ''
      throw new TemplateExtractError(
        `组件 ${comp.className} 的主模板第 ${qi} 段静态文本含非法转义序列（偏移 ${q.start ?? '?'}）：` +
          `\`${raw}\`；模板串里 \\u、\\x 后必须是合法转义（路径等请写 \\\\），否则该段文本无法取值`,
      )
    }
    return String(q.value.cooked)
  })
  const exprs: any[] = quasi.expressions ?? []

  const vars: TemplateVarInfo[] = exprs.map((e: any, index: number) => {
    const exprSource = source.slice(e.start, e.end).trim()
    // 顺序：stripTs → TS 复检（**不能**直接用 exprSource 判）。
    // codegen 侧（build-vars.ts / render-effect.ts）都是「stripTs → TS 复检」，
    // 此处若检查未剥离的原文，`${this.foo!}` 这类**可被安全剥掉**的写法会在分析期
    // 被拒，而同一表达式在 codegen 里本来能通过 —— 两处判定必须同序。
    // 注意 exprSource 本身仍是原样切片（start/end 供 wraps / prelude 使用），不改。
    // stripTsChecked 与 codegen 三处共用同一 memo，省同一条文本的重复全文扫描。
    if (stripTsChecked(exprSource).tsHit) {
      throw new TemplateExtractError(
        `组件 ${comp.className} 模板插值 #${index} 含 TS 专有语法（as/satisfies/非空断言）：` +
          `\`${exprSource}\`；codegen 产物为纯 JS，请在模板外完成类型操作`,
      )
    }
    // 旧式尖括号断言 `<T>x / 显式实例化 f<T>()：文本判据抓不到（会与 `a < b` 比较混淆），
    // 按 AST 判（C-G6 ①）。
    if (containsBlockedTsNode(e)) {
      throw new TemplateExtractError(
        blockedTsText(`组件 ${comp.className} 模板插值 #${index}`, exprSource),
      )
    }
    let isDirectiveCall = false
    let directiveName: string | undefined
    let moduleBindingName: string | undefined
    let directiveVarChain: string[] | undefined
    // 先做指令分类，再记录可折叠的静态 HTML 常量。
    // 折叠只发生在文本位；属性/TAG 位由 clearAttrFragments 清掉 fragment 标记后
    // 仍按 `html` 指令点编译（TAG 位是合法用法）。
    const fragment = staticHtmlFragmentOf(e, comp)
    if (e.type === 'CallExpression' && e.callee?.type === 'Identifier') {
      const imported = comp.compelemImports.get(e.callee.name)
      if (imported && COMpelem_DIRECTIVES.has(imported)) {
        isDirectiveCall = true
        directiveName = imported
        if (TAG_ONLY_DIRECTIVES.has(imported)) {
          directiveVarChain = extractThisChainPaths(e.arguments ?? [])
        }
      } else if (comp.knownDirectives?.has(e.callee.name)) {
        // 外部指令（options.knownDirectives，如 compelem-router 的 outlet）：
        // 调用返回 DirectiveInstance，按指令点编译（0.28 动态引擎的「函数值即指令」契约）
        isDirectiveCall = true
        directiveName = e.callee.name
      } else if (comp.moduleBindings?.has(e.callee.name)) {
        // 模块绑定调用：只记名，**不在此处**判为指令。
        // 静态无法区分自定义指令（directive() 产物）与普通函数（formatter/i18n）；
        // 只有标签位才放行，见 TemplateVarInfo.moduleBindingName 的说明。
        moduleBindingName = e.callee.name
      }
    }
    return { index, exprSource, isDirectiveCall, directiveName, moduleBindingName, directiveVarChain, fragment, start: e.start, end: e.end, node: e }
  })

  // prelude = return 之前的全部顶层语句（与子模板 buildCandidate 同逻辑）
  let preludeStart = tmpl.start
  let preludeEnd = tmpl.start
  let preludeSrc = ''
  const rets = topLevelReturns(comp.renderBody)
  const retNode = rets.find((r) => unwrapExpr(r.argument) === tmpl)
  const stmts = comp.renderBody
  // 拿不到 return 节点 = 唯一的那个顶层 return 的**直接参数**不是本模板
  // （`cond ? h\`\` : null` / `cond && h\`\`` / `(a, h\`\`)` / `fn(h\`\`)`）。
  // 此时下方只会静默产出「无 prelude、无条件恒渲染」的视图，条件被整体丢弃，
  // 而 compile.ts 的硬错误门只看有没有 buildTemplate，看不见这种形状 ⇒ 必须在此报。
  if (!retNode && rets.length === 1) {
    const arg = rets[0].argument
    const argSrc = arg && typeof arg.start === 'number' && typeof arg.end === 'number'
      ? source.slice(arg.start, arg.end)
      : ''
    throw new TemplateExtractError(
      `D8: 组件 ${comp.className} render() 的顶层 return 必须直接返回 h\`\` 模板` +
        `（可带 TS 包装/括号）或 null；条件/短路/逗号/函数包装会静默丢弃条件` +
        `（收到 \`${argSrc}\`）。请改用 ifTrue / ifElse / when 指令包裹模板。`,
    )
  }
  if (retNode) {
    const retIdx = stmts.indexOf(retNode)
    if (retIdx > 0) {
      preludeStart = stmts[0].start
      preludeEnd = stmts[retIdx - 1].end
      preludeSrc = source.slice(preludeStart, preludeEnd)
    } else if (retIdx < 0) {
      // return 不是 render() 的**直接**顶层语句（被 if / for / switch 包住）。
      //
      // ⚠️ 这里必须报错，不能"取前置语句当 prelude 然后继续"（2026-10-22 审查 C-4）：
      // ```ts
      // render() { if (this.n) { return h`<div>${this.n}</div>` } }
      // ```
      // `topLevelReturns` 会下钻块语句 ⇒ rets.length === 1 ⇒ 过 D5；retNode 也匹配上
      // ⇒ 过 D8。结果 buildTemplate 无条件建 `<div>`、fx 无 `if (rc.n)` 守卫 ⇒
      // **n = 0 时照样渲染**，编译零诊断。而注释明写 D8 就是要防"条件被整体丢弃"。
      //
      // 只对**能跳过 return** 的宿主语句报（条件 / 循环 / switch）：裸块 `{ return h`` }`
      // 与 try/finally 里的 return 不会丢条件，继续按老逻辑取 prelude。
      const hostIdx = stmts.findIndex(
        (s: any) => typeof s.start === 'number' && s.start <= tmpl.start && tmpl.end <= s.end,
      )
      const host = hostIdx >= 0 ? stmts[hostIdx] : null
      if (host && SKIPS_RETURN_STMTS.has(host.type)) {
        throw new TemplateExtractError(
          `D8: 组件 ${comp.className} render() 的模板 return 被包在 ${host.type} 里，` +
            `该条件会被整体丢弃（视图恒渲染）。请把 return 提到 render() 顶层，` +
            `或改用 ifTrue / ifElse / when 指令包裹模板。`,
        )
      }
      // 块内 return 之前的局部声明仍无法捕获，会由 build-vars 的 free-check 明确报错。
      if (hostIdx > 0) {
        preludeStart = stmts[0].start
        preludeEnd = stmts[hostIdx - 1].end
        preludeSrc = source.slice(preludeStart, preludeEnd)
      }
    }
  }

  // C-G6 ④：prelude（render() 顶层、return 之前的语句）同受尖括号断言 / 显式实例化门
  // 保护。复用已解析的 renderBody 语句 AST，不再二次 parse。文本判据（hasTsSyntax）
  // 抓不到 `<T>x` / `f<T>()`，但这两形态会随 prelude 原样进入取值函数与内联工厂。
  if (preludeSrc) {
    for (const s of stmts) {
      if (typeof s.start === 'number' && s.start > preludeEnd) break
      if (
        typeof s.start === 'number' &&
        typeof s.end === 'number' &&
        s.start >= preludeStart &&
        s.end <= preludeEnd &&
        containsBlockedTsNode(s)
      ) {
        throw new TemplateExtractError(
          blockedTsText(`组件 ${comp.className} render() prelude`, source.slice(s.start, s.end)),
        )
      }
    }
  }

  return { strings, vars, start: tmpl.start, end: tmpl.end, preludeStart, preludeEnd, preludeSrc }
}
