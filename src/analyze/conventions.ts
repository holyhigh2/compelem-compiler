/**
 * 约定错误静态检查（对应运行时 showError/showTagError 中「可静态判定」的调用点）。
 *
 * 设计原则（对齐 docs/TEMPLATE-CODEGEN.md §5「仅静态编译」）：
 *   运行时用 DEV 断言兜底的「约定违规」，编译期能证明的直接在构建期报错；
 *   编译期为唯一入口。
 *
 * 检查项 → 运行时调用点映射：
 *   E-EMIT-ARG          this.emit(实参无法静态解析)        ← CompElem.ts emit()
 *   E-EMIT-UNDECLARED   emit 事件名未在 @emits 声明        ← CompElem.ts:1273 / event.ts matchEmit
 *   E-EMITS-ARG         @emits(...) 实参无法静态解析       ← 装饰期静默收 Set，无法校验
 *   E-PROP-TYPE         @prop 无默认值且未声明 type        ← CompElem.ts（编译期唯一入口）
 *   W-PROP-CUSTOM-CTOR  @prop type 含自定义构造器且无 converter ← utils.ts convertValue 的 DEV 提示（已删）
 *   W-PROP-CASE         @prop 字段名非 lowerCamelCase（运行期按 kebabCase 映射，功能正常，仅风格提示）；
 *                       只有与另一 prop 撞同一属性名时才升为 E-PROP-CASE（真的互相覆盖）
 *   E-PROP-ASSIGN       组件内对 this.<非model prop> 赋值  ← 单向数据流约定（非运行时约束，见检查点注释）
 *   W-FIELD-OPT-DEAD    @prop/@state 的 shallow|hasChanged 运行期零消费点（声明在，实现不在）
 *   W-LIFECYCLE-TYPO    与基类生命周期名只差一字符、且本文件内无任何引用的方法（拼错的静默失效）
 *   E-COMPUTED-NOT-GETTER @computed 用在非 getter 上       ← computed.ts（编译期唯一入口）
 *   E-CSSCOPE-TARGET    @csscope 用在非 static getter 上   ← csscope.ts（编译期唯一入口）
 *
 * 静态字符串解析：除字符串字面量外，还支持解析模块级 const 常量
 * （`const EV = 'x'`、`const EVS = { Ready: 'x', G: { A: 'y' } }`），
 * 以及对它们的成员访问（`EVS.Ready`、`EVS.G.A`）—— 对齐真实代码库的枚举式写法。
 *
 * 不可静态判定的调用点（转换器报错、required 缺失、forEach 重复 key 等）不在此处。
 */
import type { ComponentAnalysis } from '../types'
// unwrapTsExpr 是 unwrapExpr 的历史名（field-extract / method-deco-extract /
// template-rules / literal-meta 仍在用），在此转出以免改动那些 import 路径。
// 实现已统一到 utils/ast 的 unwrapExpr，认 TSTypeAssertion（`<T>x`）。
import { decoratorName, keyName, superClassName, unwrapExpr } from '../utils/ast'
export { decoratorName, unwrapExpr as unwrapTsExpr }

export interface ConventionError {
  start: number
  end: number
  message: string
  /** 'warn'：提示级（合法但易踩坑），恒走 console.warn，不随 conventions 档位阻断构建。缺省 error。 */
  severity?: 'warn'
}

export interface ConventionsContext {
  /** 本文件内全部类声明（含非组件类），继承链解析用 */
  localClasses: Map<string, any>
  /** 模块级字符串常量表（collectStringConsts 产物），emit/@emits 实参解析用 */
  stringConsts: Map<string, any>
  /** 本文件全部 import 本地名。导入常量（跨文件）无法解析值 → 按「不透明」放行 */
  importedLocals: Set<string>
  /**
   * 模块级 `const NAME = <init>` 的 init 节点表（collectModuleConsts 产物）。
   * 五族访问器前移（field-extract）用：`@prop(OPTS)` 等 options 标识符
   * 只支持**文件内静态分析**——inline init 源码到注入字面量（同模块作用域等价求值）。
   */
  moduleConsts?: Map<string, any>
  /**
   * 模块级函数表（collectModuleFunctions 产物）：顶层 `function NAME() {}` 与
   * `const NAME = 箭头/函数表达式`。用于模板约定检查 E-TEMPLATE-INTERP 判定
   * 「插值位调用的本地函数是否返回 Template（子视图）」。不收类方法。
   */
  moduleFunctions?: Map<string, { node: any; annotatedTemplate: boolean }>
  /**
   * U5：本文件源码（compileFile 注入，测试可缺省）。
   * collectThisUsage 的预筛依据——函数体切片不含 `this` 字面量即可跳过深度 walk
   * （emit/propAssign 赋值模式都要求 ThisExpression，源码必含 `this`）。
   */
  code?: string
}

/** isStringLiteral：覆盖 `Literal` / `StringLiteral` 两种形态（estree / babel 原生）。 */
function isStringLiteral(n: any): boolean {
  return !!n && (n.type === 'StringLiteral' || (n.type === 'Literal' && typeof n.value === 'string'))
}

/** 对象属性节点：estree 形态产出 `Property`，兼容 babel 原生 `ObjectProperty`。 */
function isObjectProp(p: any): boolean {
  return !!p && (p.type === 'Property' || p.type === 'ObjectProperty') && !p.computed
}

/**
 * 收集模块级字符串常量：`const X = 'str'`、`const X = { K: 'v', N: { K: 'v' } }`。
 * 值必须是纯静态字符串（对象允许嵌套一层对象），动态初始化不收录。
 */
export function collectStringConsts(program: any): Map<string, any> {
  const out = new Map<string, any>()
  const strOf = (n: any): string | null => (isStringLiteral(n) ? String(n.value) : null)
  for (const stmt of program?.body ?? []) {
    const decl = stmt?.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
    if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue
    for (const d of decl.declarations ?? []) {
      if (d.id?.type !== 'Identifier' || !d.init) continue
      const name = d.id.name
      const sv = strOf(d.init)
      if (sv != null) {
        out.set(name, sv)
        continue
      }
      if (d.init.type === 'ObjectExpression') {
        const obj: Record<string, any> = {}
        let ok = true
        for (const p of d.init.properties ?? []) {
          if (!isObjectProp(p)) { ok = false; break }
          const k = keyName(p.key)
          if (!k) { ok = false; break }
          const v = strOf(p.value)
          if (v != null) { obj[k] = v; continue }
          if (p.value?.type === 'ObjectExpression') {
            const inner: Record<string, any> = {}
            let ok2 = true
            for (const ip of p.value.properties ?? []) {
              if (!isObjectProp(ip)) { ok2 = false; break }
              const ik = keyName(ip.key)
              const iv = strOf(ip.value)
              if (!ik || iv == null) { ok2 = false; break }
              inner[ik] = iv
            }
            if (ok2) { obj[k] = inner; continue }
          }
          ok = false
          break
        }
        if (ok) out.set(name, obj)
      }
    }
  }
  return out
}

/**
 * 收集模块级 `const NAME = <init>` 的 init 节点（含 `export const`）。
 * 五族 options 标识符解析用（field-extract.ts）：不做内容校验——init 源码
 * 原样内联进同文件的 `__ce_static__` 字面量，模块作用域下等价求值。
 * 仅收 `const`（import / 运行时拼接 / `let` 不支持 → 调用方报 E-PROP-ARG 等）。
 */
export function collectModuleConsts(program: any): Map<string, any> {
  const out = new Map<string, any>()
  for (const stmt of program?.body ?? []) {
    const decl = stmt?.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
    if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue
    for (const d of decl.declarations ?? []) {
      if (d.id?.type !== 'Identifier' || !d.init) continue
      out.set(d.id.name, d.init)
    }
  }
  return out
}

/**
 * 收集模块级函数：顶层 `function NAME() {}` 与 `const NAME = (...) => ...` / `function`。
 * 返回 名字 → { node, annotatedTemplate }，`annotatedTemplate` 表示返回类型注解为 `Template`。
 * 用途：E-TEMPLATE-INTERP 判定插值位调用的本地函数是否产出子视图。
 * 不收类方法（方法返回值无法在模块级静态证明）。
 */
export function collectModuleFunctions(
  program: any,
): Map<string, { node: any; annotatedTemplate: boolean }> {
  const out = new Map<string, { node: any; annotatedTemplate: boolean }>()
  const visit = (decl: any) => {
    if (!decl) return
    if (decl.type === 'FunctionDeclaration' && decl.id?.name) {
      out.set(decl.id.name, { node: decl, annotatedTemplate: returnTypeIsTemplate(decl) })
    }
    if (decl.type === 'VariableDeclaration' && decl.kind === 'const') {
      for (const d of decl.declarations ?? []) {
        if (d.id?.type !== 'Identifier' || !d.init) continue
        const init = d.init
        if (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') {
          out.set(d.id.name, { node: init, annotatedTemplate: returnTypeIsTemplate(init) })
        }
      }
    }
  }
  for (const stmt of program?.body ?? []) {
    const decl = stmt?.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt
    visit(decl)
  }
  return out
}

/** 函数返回类型注解是否为 `Template`（`function f(): Template` / `const f = (): Template =>`）。 */
function returnTypeIsTemplate(fnNode: any): boolean {
  const rt = fnNode.returnType
  if (!rt) return false
  const ann = rt.type === 'TSTypeAnnotation' ? rt.typeAnnotation : rt
  if (ann?.type === 'TSTypeReference') {
    const tn = ann.typeName
    if (tn?.type === 'Identifier' && tn.name === 'Template') return true
  }
  return false
}

/**
 * 函数体是否「返回 h`` 模板」（简写箭头 `() => h\`...\`` 或块体内任一 `return h\`...\``）。
 * `hAliases` 来自 collectTemplateTagAliases(comp)，对齐 template-extract 的别名识别。
 */
export function bodyReturnsTemplate(fnNode: any, hAliases: Set<string>): boolean {
  const body = fnNode.body
  if (!body) return false
  if (body.type !== 'BlockStatement') return isHCall(body, hAliases)
  let found = false
  const walk = (n: any) => {
    if (!n || typeof n.type !== 'string' || found) return
    if (n.type === 'ReturnStatement' && n.argument && isHCall(n.argument, hAliases)) {
      found = true
      return
    }
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'type' || k === 'parent') continue
      const v = n[k]
      if (Array.isArray(v)) for (const x of v) walk(x)
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v)
    }
  }
  walk(body)
  return found
}

function isHCall(node: any, hAliases: Set<string>): boolean {
  const n = unwrapExpr(node)
  return (
    n?.type === 'TaggedTemplateExpression' &&
    n.tag?.type === 'Identifier' &&
    hAliases.has(n.tag.name)
  )
}

/**
 * 静态解析字符串表达式：字面量 / 常量标识符 / 常量成员访问（两级对象）。
 * 返回：
 *   { ok: true, value }            解析成功
 *   { ok: true, opaque: true }     根标识符是跨文件导入（值不可知），跳过校验
 *   { ok: false, unknownKey }      表达式形态可静态分析，但常量 key 不存在（unknownKey 形如 'EVS.Other'）
 *   { ok: false }                  标识符不在常量表（可能是运行期变量）
 *   null                           完全无法静态分析（动态表达式）
 */
type ResolveResult =
  | { ok: true; value: string; opaque?: boolean }
  | { ok: false; unknownKey?: string }
  | null

function resolveStaticString(n: any, consts: Map<string, any>, importedLocals: Set<string>): ResolveResult {
  if (isStringLiteral(n)) return { ok: true, value: String(n.value) }
  if (n?.type === 'Identifier') {
    if (importedLocals.has(n.name)) return { ok: true, value: '', opaque: true }
    const v = consts.get(n.name)
    if (typeof v === 'string') return { ok: true, value: v }
    return { ok: false }
  }
  if (n?.type === 'MemberExpression' && !n.computed) {
    // A.B / A.B.C：沿常量表下钻
    const parts: string[] = []
    let cur = n
    while (cur?.type === 'MemberExpression' && !cur.computed && keyName(cur.property)) {
      parts.unshift(keyName(cur.property)!)
      cur = cur.object
    }
    if (cur?.type !== 'Identifier') return null
    if (importedLocals.has(cur.name)) return { ok: true, value: '', opaque: true }
    const root = consts.get(cur.name)
    if (root == null) return { ok: false }
    let v: any = root
    let path = cur.name
    for (const p of parts) {
      path += '.' + p
      if (v == null || typeof v !== 'object') return { ok: false, unknownKey: path }
      v = v[p]
      if (v === undefined) return { ok: false, unknownKey: path }
    }
    return typeof v === 'string' ? { ok: true, value: v } : { ok: false, unknownKey: path }
  }
  return null
}

/** 复刻 matchEmit（event.ts:274-287）的匹配语义：精确命中或 'prefix:*' 通配。 */
function matchEmits(declared: Set<string>, evName: string): boolean {
  if (declared.has(evName)) return true
  for (const n of declared) {
    if (n.endsWith(':*') && evName.startsWith(n.slice(0, -1))) return true
  }
  return false
}

/**
 * 收集一个类（含同文件基类链）的 @emits 声明。
 * 实参无法静态解析为字符串 → E-EMITS-ARG 编译错误。
 * 实参是跨文件导入常量 → 记入 hasOpaque（声明集不完整，后续放弃 UNDECLARED 校验）。
 */
function collectDeclaredEmits(
  cls: any,
  ctx: ConventionsContext,
  isEmitsDec: (localName: string) => boolean,
  isCompElem: (localName: string) => boolean,
  errs: ConventionError[],
): { declared: Set<string>; hasOpaque: boolean } {
  const out = new Set<string>()
  let hasOpaque = false
  const seen = new Set<any>()
  const visit = (node: any) => {
    if (!node || seen.has(node)) return
    seen.add(node)
    for (const dec of node.decorators ?? []) {
      const name = decoratorName(dec)
      if (!name || !isEmitsDec(name)) continue
      const expr = dec.expression ?? dec
      for (const arg of expr.arguments ?? []) {
        if (arg.type === 'SpreadElement') {
          errs.push({ start: arg.start, end: arg.end, message: 'E-EMITS-ARG: @emits 不支持展开实参（无法静态解析）' })
          continue
        }
        const r = resolveStaticString(arg, ctx.stringConsts, ctx.importedLocals)
        if (r?.ok && r.opaque) hasOpaque = true
        else if (r?.ok) out.add(r.value)
        else if (r?.unknownKey) errs.push({ start: arg.start, end: arg.end, message: `E-CONST-KEY: 常量成员 '${r.unknownKey}' 不存在` })
        else errs.push({ start: arg.start, end: arg.end, message: 'E-EMITS-ARG: @emits 实参必须是字符串字面量或可静态解析的常量（编译期静态校验）' })
      }
    }
    const sup = superClassName(node)
    if (!sup || isCompElem(sup)) return
    const parent = ctx.localClasses.get(sup)
    if (parent) visit(parent)
    else {
      // 跨文件基类可能声明了 @emits；看不到就标记声明集不完整，
      // 放弃 UNDECLARED 校验，避免把继承事件误报成未声明。
      hasOpaque = true
    }
  }
  visit(cls)
  return { declared: out, hasOpaque }
}

/**
 * 遍历成员函数体，收集 `this.emit(...)` 调用与 `this.<name> = ...` 赋值。
 *
 * `this` 绑定规则：箭头函数继承外层 this；非箭头函数（function/方法内的 function 声明）
 * 重新绑定 this —— 进入非箭头函数后收集到的 this.* 不再属于组件实例，跳过。
 */
interface ThisUsage {
  emitCalls: Array<{ node: any; arg: any }>
  propAssignments: Array<{ node: any; propName: string }>
}

function collectThisUsage(memberFn: any, code?: string): ThisUsage {
  const usage: ThisUsage = { emitCalls: [], propAssignments: [] }
  // U5 预筛：emit/propAssign 匹配都要求 ThisExpression → 函数体源码必含字面 `this`。
  // 无则直接返回空（slice+includes 的原生扫描比递归 Object.keys walk 便宜一个量级）。
  const body = memberFn.body
  if (
    code &&
    body &&
    typeof body.start === 'number' &&
    typeof body.end === 'number' &&
    !code.slice(body.start, body.end).includes('this')
  ) {
    return usage
  }
  const rec = (n: any, fnBarrier: boolean) => {
    if (!n || typeof n.type !== 'string') return
    if (!fnBarrier && n.type === 'CallExpression') {
      const c = n.callee
      if (
        c?.type === 'MemberExpression' &&
        !c.computed &&
        c.object?.type === 'ThisExpression' &&
        keyName(c.property) === 'emit' &&
        n.arguments?.length
      ) {
        usage.emitCalls.push({ node: n, arg: n.arguments[0] })
      }
    }
    if (!fnBarrier && n.type === 'AssignmentExpression') {
      const l = n.left
      if (
        l?.type === 'MemberExpression' &&
        !l.computed &&
        l.object?.type === 'ThisExpression' &&
        keyName(l.property)
      ) {
        // 任何赋值运算符都算：=、+=、??=、||= ……
        usage.propAssignments.push({ node: n, propName: keyName(l.property)! })
      }
    }
    if (!fnBarrier && n.type === 'UpdateExpression' && (n.operator === '++' || n.operator === '--')) {
      const l = n.argument
      if (
        l?.type === 'MemberExpression' &&
        !l.computed &&
        l.object?.type === 'ThisExpression' &&
        keyName(l.property)
      ) {
        usage.propAssignments.push({ node: n, propName: keyName(l.property)! })
      }
    }
    // 进入非箭头函数（function 声明/表达式）后 this 重绑 → 后代 this.* 不再属于组件实例
    const childBarrier = fnBarrier || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration'
    for (const k of Object.keys(n)) {
      if (k === 'start' || k === 'end' || k === 'type') continue
      const v = (n as any)[k]
      if (Array.isArray(v)) {
        for (const c of v) rec(c, childBarrier)
      } else if (v && typeof v === 'object' && typeof v.type === 'string') {
        rec(v, childBarrier)
      }
    }
  }
  // 从函数体开始遍历：成员函数自身（MethodDefinition.value 是 FunctionExpression）不算「嵌套函数」
  rec(memberFn.body, false)
  return usage
}

/** 提取装饰器实参里的 options 对象节点（无参形态返回 null；Identifier 经 moduleConsts 内联解析）。 */
function decoratorOptionsNode(member: any, isDec: (n: string) => boolean, ctx?: ConventionsContext): any | null {
  for (const dec of member.decorators ?? []) {
    const dn = decoratorName(dec)
    // 必须按 isDec(local) 匹配：import { prop as p } 时本地名是 p，不是 prop。
    if (!dn || !isDec(dn)) continue
    const expr = dec.expression ?? dec
    if (expr.type === 'CallExpression') {
      const a0 = expr.arguments?.[0]
      if (a0?.type === 'ObjectExpression') return a0
      if (a0?.type === 'Identifier' && ctx?.moduleConsts?.has(a0.name)) {
        const init = unwrapExpr(ctx.moduleConsts.get(a0.name))
        if (init?.type === 'ObjectExpression') return init
      }
      return null
    }
    return null // 无参形态
  }
  return null
}

/** 展开后的 options 序列：对象字面量属性与“无法静态解析的 spread”占位。 */
export type OptionEntry = { kind: 'prop'; node: any } | { kind: 'opaque' }

/**
 * 展开 options 对象（含同文件 const 对象与可解析的 spread）。
 *
 * 无法解析的 spread 记为 opaque：调用方既不能假设某个 key 不存在，也不能
 * 假设其值；需要精确语义（model setter / type）时必须保守处理。
 */
export function flattenOptionProps(
  node: any,
  ctx?: ConventionsContext,
  depth = 0,
  seen: Set<any> = new Set(),
): OptionEntry[] {
  const obj = unwrapExpr(node)
  if (!obj || obj.type !== 'ObjectExpression' || depth > 8 || seen.has(obj)) {
    return [{ kind: 'opaque' }]
  }
  const nextSeen = new Set(seen).add(obj)
  const out: OptionEntry[] = []
  for (const p of obj.properties ?? []) {
    if (p.type === 'SpreadElement' || p.type === 'ExperimentalSpreadProperty') {
      const arg = unwrapExpr(p.argument)
      let init: any
      if (arg?.type === 'ObjectExpression') init = arg
      else if (arg?.type === 'Identifier' && ctx?.moduleConsts?.has(arg.name)) {
        init = unwrapExpr(ctx.moduleConsts.get(arg.name))
      }
      if (init?.type === 'ObjectExpression') {
        out.push(...flattenOptionProps(init, ctx, depth + 1, nextSeen))
      } else {
        out.push({ kind: 'opaque' })
      }
      continue
    }
    if (p.computed && !(p.key?.type === 'Literal' || p.key?.type === 'StringLiteral')) {
      out.push({ kind: 'opaque' })
      continue
    }
    out.push({ kind: 'prop', node: p })
  }
  return out
}

/** 某个 key 在展开序列里的“最后一次赋值”状态。 */
export function finalOption(
  entries: OptionEntry[],
  key: string,
): { known: boolean; node?: any } {
  let known = false
  let node: any
  for (const e of entries) {
    if (e.kind === 'opaque') {
      // opaque spread 可能覆盖任意 key；只有其后的显式属性才能恢复“已知”
      known = false
      node = undefined
      continue
    }
    if (keyName(e.node.key) === key) {
      known = true
      node = e.node.value
    }
  }
  return { known, node }
}

/** 展开序列中是否存在无法静态解析的 spread。 */
export function hasOpaqueOption(entries: OptionEntry[]): boolean {
  return entries.some((e) => e.kind === 'opaque')
}

/** convertValue 内建处理的构造器名（其余构造器走 new t(字符串) 路径）。 */
const BUILTIN_TYPE_NAMES: ReadonlySet<string> = new Set([
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Date', 'Function',
])

/**
 * type 选项里的自定义构造器标识符名。仅识别 Identifier 与全 Identifier 的
 * ArrayExpression；其它形态（成员访问、表达式、变量引用）无法静态判定 → 返回空（宁漏勿误报）。
 */
function customCtorTypeNames(node: any): string[] {
  const v = unwrapExpr(node)
  const one = (n: any): string | undefined => {
    if (n?.type !== 'Identifier') return undefined
    return BUILTIN_TYPE_NAMES.has(n.name) ? undefined : n.name
  }
  if (v?.type === 'Identifier') {
    const n = one(v)
    return n ? [n] : []
  }
  if (v?.type === 'ArrayExpression') {
    const out: string[] = []
    for (const el of v.elements ?? []) {
      if (el?.type !== 'Identifier') return []
      const n = one(el)
      if (n && !out.includes(n)) out.push(n)
    }
    return out
  }
  return []
}

/**
 * prop / state 声明名 → 运行期 HTML attribute 名。
 *
 * 对齐 myfx `kebabCase` 的 camelCase 分词（`Foo` → `foo`、`fooBar` → `foo-bar`）。
 * 只用于「两个 prop 是否撞同一属性」的判定 —— 不需要与 myfx 在缩写词（`getMyURL`）上
 * 逐字节一致，撞名关系的判定结果一致即可。
 */
function attrNameOf(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}

/** CompElem 基类的公开方法 / 生命周期名（手工镜像 `F:\github\compelem\src\CompElem.ts`）。 */
const COMPELEM_MEMBERS: ReadonlySet<string> = new Set([
  'setup', 'propsReady', 'render', 'beforeMount', 'mounted', 'slotChange', 'afterUpdate',
  'beforeDestroyed', 'destroyed', 'destroy', 'forceUpdate', 'updateProps', 'nextTick', 'emit',
  'insertStyleSheet', 'getSubViewNodes', 'defineSignalField',
  'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback',
])

/** 运行期已无消费点的 field option（`shallow` / `hasChanged`：全仓 grep 零命中）。 */
const DEAD_FIELD_OPTIONS = ['shallow', 'hasChanged'] as const

/** 编辑距离是否恰好 ≤ 1（增/删/改一个字符）。 */
function editDistanceLe1(a: string, b: string): boolean {
  const la = a.length
  const lb = b.length
  if (Math.abs(la - lb) > 1) return false
  let i = 0
  while (i < la && i < lb && a[i] === b[i]) i++
  if (la === lb) return i === la || a.slice(i + 1) === b.slice(i + 1)
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}

/** 与给定方法名只差一字符的基类成员（无则 null）。短名（<5）不参与，避免噪音。 */
function nearestMemberName(name: string): string | null {
  if (name.length < 5) return null
  for (const m of COMPELEM_MEMBERS) {
    if (m.length >= 5 && editDistanceLe1(name, m)) return m
  }
  return null
}

/** 全文件里该标识符出现的次数（含声明本身）。 */
function countIdent(code: string, name: string): number {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`, 'g')
  let n = 0
  while (re.exec(code)) n++
  return n
}

/**
 * W-FIELD-OPT-DEAD：`@prop` / `@state` 的 options 里出现了运行期没有消费点的键。
 *
 * 这类选项「写了不报错、也不生效」，比直接报错更难发现 —— 使用者会以为它在起作用。
 * 只在 options 完全可静态展开（无 spread）时判断，否则可能误伤。
 */
function warnDeadOptions(
  errs: ConventionError[],
  entries: ReturnType<typeof flattenOptionProps>,
  member: any,
  memberName: string,
  familyLabel: string,
): void {
  if (!entries.length || hasOpaqueOption(entries)) return
  for (const key of DEAD_FIELD_OPTIONS) {
    const opt = finalOption(entries, key)
    if (!opt.known || !opt.node) continue
    errs.push({
      start: opt.node.start ?? member.start,
      end: opt.node.end ?? member.end,
      severity: 'warn',
      message:
        `W-FIELD-OPT-DEAD: ${familyLabel}('${memberName}') 的选项 '${key}' 运行期没有任何消费点` +
        `（信号相等性恒为 Object.is）—— 该选项不会生效，可删除`,
    })
  }
}

/**
 * 对单个组件执行全部约定检查。返回错误列表（可为空）。
 * 注意：约定检查独立于模板 codegen 与静态分析闸门 —— 二者都会执行，不短路。
 */
export function checkConventions(
  comp: ComponentAnalysis,
  ctx: ConventionsContext,
): ConventionError[] {
  const errs: ConventionError[] = []
  const cls = comp.cls ?? ctx.localClasses.get(comp.className)
  if (!cls) return errs

  // 装饰器判定：按「本地名 → imported 名」精确解析（兼容 import { emits as e }）
  const isEmitsDec = (local: string) => comp.compelemImports.get(local) === 'emits'
  const isPropDec = (local: string) => comp.compelemImports.get(local) === 'prop'
  const isStateDec = (local: string) => comp.compelemImports.get(local) === 'state'
  const isComputedDec = (local: string) => comp.compelemImports.get(local) === 'computed'
  const isCsscopeDec = (local: string) => comp.compelemImports.get(local) === 'csscope'

  // ---- 1. @emits 声明收集（含继承链） ----
  const { declared, hasOpaque } = collectDeclaredEmits(
    cls,
    ctx,
    isEmitsDec,
    (local) => comp.compelemImports.get(local) === 'CompElem',
    errs,
  )

  // ---- 2. 遍历类成员：emit 调用 / prop 赋值 / 装饰器目标检查 ----
  const propFields = new Map<string, any>() // name → PropertyDefinition 节点
  for (const member of cls.body?.body ?? []) {
    const name = keyName(member.key)
    if (!name || member.type !== 'PropertyDefinition') continue
    const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
    if (decs.some((d) => isPropDec(d))) propFields.set(name, member)
  }

  /**
   * E-PROP-ASSIGN 专用的**同文件继承链合并** prop 集：子类方法里对基类声明的
   * prop 赋值，只查本类 propFields 会漏报。沿 extends 链上溯同文件基类
   * （跨文件基类不可知，保持漏报不误报），浅替换语义——子类同名字段的选项
   * 对象整体覆盖祖先（先放本类，祖先仅在无同名时补入）。
   * ⚠️ 只用于 propAssignments 判定；成员级检查（E-PROP-CASE/TYPE 等）仍用
   * 本类 propFields——那是按「本类成员自带 @prop」遍历的，混入祖先字段会
   * 把子类同名的普通字段误当 prop 检查。
   */
  const propFieldsChain = new Map<string, any>(propFields)
  {
    const isCompElemBase = (name: string) => comp.compelemImports.get(name) === 'CompElem'
    let cur = cls
    for (let depth = 0; depth < 8; depth++) {
      const sup = superClassName(cur)
      if (!sup || isCompElemBase(sup)) break
      const parent = ctx.localClasses.get(sup)
      if (!parent) break // 基类在本文件外：其 prop 集不可知
      for (const member of parent.body?.body ?? []) {
        const name = keyName(member.key)
        if (!name || member.type !== 'PropertyDefinition') continue
        const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
        if (decs.some((d) => isPropDec(d)) && !propFieldsChain.has(name)) propFieldsChain.set(name, member)
      }
      cur = parent
    }
  }

  for (const member of cls.body?.body ?? []) {
    const memberName = keyName(member.key)

    // 装饰器目标检查（与成员是否有函数体无关）
    const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
    if (memberName && decs.some((d) => isComputedDec(d)) && member.kind !== 'get') {
      errs.push({
        start: member.start,
        end: member.end,
        message: `E-COMPUTED-NOT-GETTER: @computed 只能用于非静态 getter（'${memberName}' 是 ${member.kind ?? 'member'}）`,
      })
    }
    if (memberName && decs.some((d) => isCsscopeDec(d))) {
      if (!member.static || member.kind !== 'get') {
        errs.push({
          start: member.start,
          end: member.end,
          message: `E-CSSCOPE-TARGET: @csscope 只能用于 static getter（'${memberName}' ${member.static ? '非 getter' : '非 static'}）`,
        })
      }
    }

    // ---- 内置装饰器目标校验（E-DECO-TARGET）----
    // 内置装饰器 targets：
    //   debounced / onced / throttled → METHOD（编译期前移，见 analyze/method-deco-extract.ts）
    //   query / queryAll → FIELD
    // 自定义装饰器在编译期不可知 → 放行
    // targets 校验完全由编译期负责 —— 这是唯一的校验点。
    if (memberName) {
      const checkTarget = (importedName: string, allowed: string[]) => {
        // compelemImports 是 local→imported，需按 imported 值反查 local 名
        const hasDec = decs.some((d) => comp.compelemImports.get(d) === importedName)
        if (!hasDec) return
        const isMethodDeco = importedName === 'debounced' || importedName === 'onced' || importedName === 'throttled'
        if (isMethodDeco) {
          // 方法装饰器只包装“非 static、非 private 的普通实例方法”；
          // getter/static/private 会生成 `this.getter = …` / `this.#x_$__` 等坏代码。
          const ok =
            member.type === 'MethodDefinition' &&
            member.kind === 'method' &&
            member.static !== true &&
            !String(memberName).startsWith('#')
          if (!ok) {
            errs.push({
              start: member.start,
              end: member.end,
              message:
                `E-DECO-TARGET: @${importedName} 只能用于非 static、非 private 的普通实例方法（'${memberName}' 是 ` +
                `${member.static ? 'static ' : ''}${String(memberName).startsWith('#') ? 'private ' : ''}${member.kind ?? member.type}）`,
            })
          }
          return
        }
        let actual = 'unknown'
        if (member.type === 'MethodDefinition') actual = 'METHOD'
        else if (member.type === 'PropertyDefinition') actual = 'FIELD'
        if (!allowed.includes(actual)) {
          errs.push({
            start: member.start,
            end: member.end,
            message: `E-DECO-TARGET: @${importedName} 只能用于 ${allowed.join('/')}（'${memberName}' 是 ${actual}）`,
          })
        }
      }
      checkTarget('debounced', ['METHOD'])
      checkTarget('onced', ['METHOD'])
      checkTarget('throttled', ['METHOD'])
      checkTarget('query', ['FIELD'])
      checkTarget('queryAll', ['FIELD'])
    }

    // @prop 约定
    if (memberName && propFields.has(memberName)) {
      if (!/^[a-z]/.test(memberName)) {
        // 运行期把 prop 名按 kebabCase 映射成 HTML 属性（utils.ts `_observedAttrs`）：
        // `Foo` → `foo`，`this.Foo` 访问器与属性通道都照常工作 ⇒ 大写开头**本身不是语法错误**，
        // 只有与另一个 prop 撞同一个属性名（`Foo` + `foo`）时才会真的互相覆盖。
        const attr = attrNameOf(memberName)
        const clash = [...propFields.keys()].find(
          (n) => n !== memberName && attrNameOf(n) === attr,
        )
        if (clash) {
          errs.push({
            start: member.start,
            end: member.end,
            message:
              `E-PROP-CASE: Prop '${memberName}' 与 '${clash}' 会映射到同一个 HTML 属性 '${attr}'` +
              `（运行期 kebabCase 归一）——两者互相覆盖，请改用 lowerCamelCase 区分`,
          })
        } else {
          errs.push({
            start: member.start,
            end: member.end,
            severity: 'warn',
            message:
              `W-PROP-CASE: Prop '${memberName}' 不是 lowerCamelCase —— 运行期按 kebabCase 映射为属性 '${attr}'，` +
              `功能正常，仅提示统一风格`,
          })
        }
      }
      const opts = decoratorOptionsNode(member, isPropDec, ctx)
      const entries = opts ? flattenOptionProps(opts, ctx) : []
      const typeOpt = finalOption(entries, 'type')
      const hasInit = member.value != null // PropertyDefinition 的初始化表达式
      if (!hasInit && !typeOpt.known && !hasOpaqueOption(entries)) {
        errs.push({
          start: member.start,
          end: member.end,
          message: `E-PROP-TYPE: Prop '${memberName}' 没有默认值也没有声明 type，运行时无法做类型推断`,
        })
      }
      // W-PROP-CUSTOM-CTOR：type 含内置以外的构造器、又没配 converter 且属性通道未关时，
      // 属性字符串会以「原始字符串作单参」传给 new Ctor(...)。合法但易踩坑，提示级。
      if (typeOpt.known && typeOpt.node && !hasOpaqueOption(entries)) {
        const convOpt = finalOption(entries, 'converter')
        const attrOpt = finalOption(entries, 'attribute')
        const attrOff =
          attrOpt.known &&
          ((attrOpt.node?.type === 'Literal' && attrOpt.node.value === false) ||
            attrOpt.node?.type === 'BooleanLiteral' && attrOpt.node?.value === false)
        if (!convOpt.known && !attrOff) {
          const custom = customCtorTypeNames(typeOpt.node)
          if (custom.length) {
            errs.push({
              start: typeOpt.node.start,
              end: typeOpt.node.end,
              severity: 'warn',
              message:
                `W-PROP-CUSTOM-CTOR: Prop '${memberName}' 声明了自定义构造器 [${custom.join(', ')}]：` +
                `HTML 属性反序列化会把原始字符串作单参传给 new ${custom[0]}(...)；` +
                `如需其它解析请配 converter，或 attribute:false 关闭属性通道`,
            })
          }
        }
      }
      // W-FIELD-OPT-DEAD：运行期已无消费点的选项（全仓 grep 零命中）——留着会让人误以为生效。
      warnDeadOptions(errs, entries, member, memberName, '@prop')
    }

    // @state 约定：只关心 options（成员合法性由 field-extract 全量校验）
    if (memberName && decs.some((d) => isStateDec(d))) {
      const opts = decoratorOptionsNode(member, isStateDec, ctx)
      const entries = opts ? flattenOptionProps(opts, ctx) : []
      warnDeadOptions(errs, entries, member, memberName, '@state')
    }

    // ---- W-LIFECYCLE-TYPO：与基类生命周期只差一字符、且全文件无人引用的方法 ----
    // 拼错的生命周期方法运行期永不调用（基类空实现，不报错），是最难查的一类静默失效。
    // 「全文件无人引用」是关键的降噪条件：真正的工具方法（renderTo / mountedAll）一定被调。
    if (
      memberName &&
      member.type === 'MethodDefinition' &&
      member.kind === 'method' &&
      !member.static &&
      !COMPELEM_MEMBERS.has(memberName) &&
      ctx.code
    ) {
      const near = nearestMemberName(memberName)
      if (near && countIdent(ctx.code, memberName) <= 1) {
        errs.push({
          start: member.start,
          end: member.end,
          severity: 'warn',
          message:
            `W-LIFECYCLE-TYPO: '${memberName}' 与基类方法 '${near}' 只差一个字符，且本文件内没有任何引用 —— ` +
            `运行期不会调用它；若不是拼写错误请忽略本条`,
        })
      }
    }

    // 函数体内的 this 使用
    const fn =
      member.type === 'MethodDefinition' || member.type === 'PropertyDefinition' ? member.value : null
    if (!fn || (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression')) continue
    // static 成员里的 this 是类本身，不是组件实例；emit/propAssign 规则不适用。
    if (member.static) continue

    const usage = collectThisUsage(fn, ctx.code)
    for (const { arg } of usage.emitCalls) {
      const r = resolveStaticString(arg, ctx.stringConsts, ctx.importedLocals)
      if (r?.ok && r.opaque) {
        // 跨文件导入常量：值不可知，跳过校验（跨文件常量表是 vite 插件的后续工作）
        continue
      }
      if (r?.ok) {
        if (hasOpaque) continue // 声明集不完整 → 放弃 UNDECLARED 校验，避免误报
        if (!matchEmits(declared, r.value)) {
          errs.push({
            start: arg.start,
            end: arg.end,
            message: `E-EMIT-UNDECLARED: '${r.value}' was not declared in @emits`,
          })
        }
      } else if (r?.unknownKey) {
        errs.push({
          start: arg.start,
          end: arg.end,
          message: `E-CONST-KEY: 常量成员 '${r.unknownKey}' 不存在`,
        })
      } else {
        errs.push({
          start: arg.start,
          end: arg.end,
          message: 'E-EMIT-ARG: this.emit 实参必须是字符串字面量或可静态解析的常量（编译期静态校验）',
        })
      }
    }
    for (const { node, propName } of usage.propAssignments) {
      // 沿同文件继承链查（含基类 prop）；model 选项解析用的字段节点即声明处
      const field = propFieldsChain.get(propName)
      if (!field) continue
      // model:true 的 prop 运行时开放 set 通道（双向绑定），允许组件内赋值。
      // spread 无法解析时不能证明“非 model”，跳过以免误报；已知 model:false 才报。
      const opts = decoratorOptionsNode(field, isPropDec, ctx)
      const entries = opts ? flattenOptionProps(opts, ctx) : []
      const modelOpt = finalOption(entries, 'model')
      if (modelOpt.known) {
        const v = modelOpt.node
        const isBool =
          v?.type === 'BooleanLiteral' || (v?.type === 'Literal' && typeof v.value === 'boolean')
        if (!isBool) continue // 值不可静态判定 → 宁漏勿误报
        if (v.value === true) continue
      } else if (hasOpaqueOption(entries)) continue
      // E-PROP-ASSIGN 是**单向数据流约定**，不是运行时约束：注入的 setter 会直接写信号
      // （`set x(__v) { this.__s.x.value = __v }`），`model` prop 更是开放写回的。
      // 之所以在编译期拦，是因为「子组件悄悄改父组件传入值」在反应式链路里必然出现
      // 双源真相；写法上应改用 model 或 updateProps 让改动走事件回到父端。
      errs.push({
        start: node.start,
        end: node.end,
        message: `E-PROP-ASSIGN: 不能在组件内对 prop '${propName}' 赋值（props 由外部单向传入；双向请用 model 或 updateProps）`,
      })
    }
  }

  // 按位置排序，稳定输出
  errs.sort((a, b) => a.start - b.start)
  return errs
}
