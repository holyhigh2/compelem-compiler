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

export interface MainTemplate {
  /** quasis 的 cooked 串（长度 = 插值数 + 1） */
  strings: string[]
  vars: TemplateVarInfo[]
  start: number
  end: number
}

/** TS 专有语法检测（生成到 JS 运行时会语法错误）。导出供子模板 stripTs 后复检。 */
export const TS_SYNTAX_RE = /\b(?:as|satisfies)\s+[A-Za-z_(<]|[\w\)\]]!(?:\.|\[|\))/

export class TemplateExtractError extends Error {}

/** 仅允许出现在 TAG 位置的内置指令（其非模板实参可静态提取 this 链）。 */
const TAG_ONLY_DIRECTIVES = new Set(['bind', 'show', 'model', 'classes', 'styles', 'html'])

/**
 * 把一条 `this.a.b.c` 成员链还原为字段路径数组（最外层在前）。
 * 非 this 起始 / 含 computed 访问时返回 null。
 */
function thisChain(node: any): string[] | null {
  const chain: string[] = []
  let cur: any = node
  while (cur && (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression')) {
    if (cur.computed) return null
    const prop = cur.property
    const name = prop?.type === 'Identifier' ? prop.name : prop?.type === 'PrivateIdentifier' ? prop.name : null
    if (!name) return null
    chain.unshift(name)
    cur = cur.object
  }
  if (!cur || cur.type !== 'ThisExpression') return null
  return chain.length ? chain : null
}

/**
 * 提取 TAG 指令实参中的 this 链全前缀路径。
 *
 * 收集的路径与指令工厂调用期间运行时建立的依赖对齐：
 * `model(this.form.name)` → `['form', 'form.name']`（根 + 全路径前缀链）。
 * 仅收集可静态解析的 this 成员链；表达式中其他部分忽略。
 */
function extractThisChainPaths(args: any[]): string[] | undefined {
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
  const strings: string[] = (quasi.quasis ?? []).map((q: any) => String(q.value?.cooked ?? ''))
  const exprs: any[] = quasi.expressions ?? []

  const vars: TemplateVarInfo[] = exprs.map((e: any, index: number) => {
    const exprSource = source.slice(e.start, e.end).trim()
    if (TS_SYNTAX_RE.test(exprSource)) {
      throw new TemplateExtractError(
        `组件 ${comp.className} 模板插值 #${index} 含 TS 专有语法（as/satisfies/非空断言）：` +
          `\`${exprSource}\`；codegen 产物为纯 JS，请在模板外完成类型操作`,
      )
    }
    let isDirectiveCall = false
    let directiveName: string | undefined
    let moduleBindingName: string | undefined
    let directiveVarChain: string[] | undefined
    if (e.type === 'CallExpression' && e.callee?.type === 'Identifier') {
      const imported = comp.compelemImports.get(e.callee.name)
      if (imported && COMpelem_DIRECTIVES.has(imported)) {
        isDirectiveCall = true
        directiveName = imported
        if (TAG_ONLY_DIRECTIVES.has(imported)) {
          directiveVarChain = extractThisChainPaths(e.arguments ?? [])
        }
      } else if (comp.moduleBindings?.has(e.callee.name)) {
        // 模块绑定调用：只记名，**不在此处**判为指令。
        // 静态无法区分自定义指令（directive() 产物）与普通函数（formatter/i18n）；
        // 只有标签位才放行，见 TemplateVarInfo.moduleBindingName 的说明。
        moduleBindingName = e.callee.name
      }
    }
    return { index, exprSource, isDirectiveCall, directiveName, moduleBindingName, directiveVarChain, start: e.start, end: e.end, node: e }
  })

  return { strings, vars, start: tmpl.start, end: tmpl.end }
}
