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
 *   E-PROP-CASE         @prop 字段名非 lowerCamelCase      ← prop.ts:35
 *   E-PROP-ASSIGN       组件内对 this.<非model prop> 赋值  ← prop.ts:105-113（set 通道仅 model 开放）
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
import { keyName } from '../utils/oxc'

export interface ConventionError {
  start: number
  end: number
  message: string
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
   * U5：本文件源码（compileFile 注入，测试可缺省）。
   * collectThisUsage 的预筛依据——函数体切片不含 `this` 字面量即可跳过深度 walk
   * （emit/propAssign 赋值模式都要求 ThisExpression，源码必含 `this`）。
   */
  code?: string
}

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

function superClassName(node: any): string | null {
  const sc = node.superClass
  if (!sc) return null
  if (sc.type === 'Identifier') return sc.name
  if (sc.type === 'MemberExpression' && sc.property?.type === 'Identifier') return sc.property.name
  return null
}

/** isStringLiteral：覆盖 oxc 的 Literal / StringLiteral 两种形态。 */
function isStringLiteral(n: any): boolean {
  return !!n && (n.type === 'StringLiteral' || (n.type === 'Literal' && typeof n.value === 'string'))
}

/** 对象属性节点：oxc 产出 `Property`（ESTree 形态），兼容 `ObjectProperty`。 */
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

/** 剥掉 TS 包装节点（as / satisfies / 括号），取可静态分析的本体。 */
export function unwrapTsExpr(n: any): any {
  let cur = n
  while (
    cur &&
    (cur.type === 'TSAsExpression' ||
      cur.type === 'TSSatisfiesExpression' ||
      cur.type === 'TSNonNullExpression' ||
      cur.type === 'ParenthesizedExpression')
  ) {
    cur = cur.expression
  }
  return cur
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
    if (sup && ctx.localClasses.has(sup)) visit(ctx.localClasses.get(sup))
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
    if (!fnBarrier && n.type === 'AssignmentExpression' && n.operator === '=') {
      const l = n.left
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
function decoratorOptionsNode(member: any, decName: string, isDec: (n: string) => boolean, ctx?: ConventionsContext): any | null {
  for (const dec of member.decorators ?? []) {
    if (decoratorName(dec) !== decName || !isDec(decName)) continue
    const expr = dec.expression ?? dec
    if (expr.type === 'CallExpression') {
      const a0 = expr.arguments?.[0]
      if (a0?.type === 'ObjectExpression') return a0
      if (a0?.type === 'Identifier' && ctx?.moduleConsts?.has(a0.name)) {
        const init = unwrapTsExpr(ctx.moduleConsts.get(a0.name))
        if (init?.type === 'ObjectExpression') return init
      }
      return null
    }
    return null // 无参形态
  }
  return null
}

function objectHasTrueProp(optsNode: any, key: string): boolean {
  if (!optsNode) return false
  for (const p of optsNode.properties ?? []) {
    if (keyName(p.key) === key && p.value?.value === true) return true
  }
  return false
}

/**
 * 对单个组件执行全部约定检查。返回错误列表（可为空）。
 * 注意：约定检查独立于模板 codegen 与降级判定 —— 降级组件同样检查。
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
  const isComputedDec = (local: string) => comp.compelemImports.get(local) === 'computed'
  const isCsscopeDec = (local: string) => comp.compelemImports.get(local) === 'csscope'

  // ---- 1. @emits 声明收集（含继承链） ----
  const { declared, hasOpaque } = collectDeclaredEmits(cls, ctx, isEmitsDec, errs)

  // ---- 2. 遍历类成员：emit 调用 / prop 赋值 / 装饰器目标检查 ----
  const propFields = new Map<string, any>() // name → PropertyDefinition 节点
  for (const member of cls.body?.body ?? []) {
    const name = keyName(member.key)
    if (!name || member.type !== 'PropertyDefinition') continue
    const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
    if (decs.some((d) => isPropDec(d))) propFields.set(name, member)
  }

  for (const member of cls.body?.body ?? []) {
    const memberName = keyName(member.key)

    // 装饰器目标检查（与成员是否有函数体无关）
    const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
    if (memberName && isComputedDec('computed') && decs.includes('computed') && member.kind !== 'get') {
      errs.push({
        start: member.start,
        end: member.end,
        message: `E-COMPUTED-NOT-GETTER: @computed 只能用于非静态 getter（'${memberName}' 是 ${member.kind ?? 'member'}）`,
      })
    }
    if (memberName && isCsscopeDec('csscope') && decs.includes('csscope')) {
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
        const hasDec = [...comp.compelemImports.values()].includes(importedName) &&
          decs.some((d) => comp.compelemImports.get(d) === importedName)
        if (!hasDec) return
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
        errs.push({
          start: member.start,
          end: member.end,
          message: `E-PROP-CASE: Prop '${memberName}' 必须是 lowerCamelCase`,
        })
      }
      const opts = decoratorOptionsNode(member, 'prop', isPropDec, ctx)
      const hasInit = member.value != null // PropertyDefinition 的初始化表达式
      if (!hasInit && !(opts && (opts.properties ?? []).some((p: any) => keyName(p.key) === 'type'))) {
        errs.push({
          start: member.start,
          end: member.end,
          message: `E-PROP-TYPE: Prop '${memberName}' 没有默认值也没有声明 type，运行时无法做类型推断`,
        })
      }
    }

    // 函数体内的 this 使用
    const fn =
      member.type === 'MethodDefinition' || member.type === 'PropertyDefinition' ? member.value : null
    if (!fn || (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression')) continue

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
      const field = propFields.get(propName)
      if (!field) continue
      // model:true 的 prop 运行时开放 set 通道（双向绑定），允许组件内赋值
      const opts = decoratorOptionsNode(field, 'prop', isPropDec, ctx)
      if (objectHasTrueProp(opts, 'model')) continue
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
