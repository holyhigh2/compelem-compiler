/**
 * 组件识别与响应式字段提取。
 *
 * 目标：从单个 `.ts` 源文件里找出所有 compelem 组件类，并提取
 *   - 响应式字段白名单（@prop / @state / @computed）
 *   - 本类自有方法 / getter（D2 降级判定用）
 *   - render() 函数体 AST 与偏移
 *   - 从 compelem 导入的绑定名（D3 白名单）
 *
 * ⚠️ 前提：本仓库（compelem）自身 dev 用 `'../src/index'` 这种相对路径导入，
 * 因此 compelem 判定必须同时接受「包名含 compelem」与「相对路径指向 src」两种形态。
 */
import type { ComponentAnalysis, ReactiveField, ReactiveKind } from '../types'
import { keyName, topLevelReturns } from '../utils/oxc'
import type { ParsedFile } from '../utils/oxc'

/** 判断某个 import source 是否指向 compelem 本体。 */
export function isCompelemSource(source: string): boolean {
  // 1) 包名 / 路径里含 `compelem`
  if (/(^|[/@])compelem([/@]|$)|compelem\//.test(source)) return true
  if (/^@compelem\//.test(source)) return false // @compelem/* 子包不算本体
  // 2) 相对路径指向 src（本仓库 dev 形态：'../src/index'、'./src'）
  if (/^(\.\.?\/)+src(\/|$)/.test(source)) return true
  // 3) 裸相对路径也可能重导出 compelem（如 '../common'），此处不放行，交由调用方二次确认
  return false
}

/**
 * 判断某个 import source 是否指向 **myfx**。
 *
 * 编译器为方法装饰器前移注入的 `debounce/throttle/once` 走这条通道：它们是 myfx 的
 * 实现，compelem 不再为它们开出口（主项目直接依赖 myfx 即可）。
 * 接受包名（`myfx`）与仓库内常见的相对/别名形态（`../myfx/src`、`@/myfx`）。
 */
export function isMyfxSource(source: string): boolean {
  return /(^|[/@])myfx([/@]|$)|myfx\//.test(source)
}

/** 从 import 表里挑出 compelem 相关绑定：本地名 → 原始导入名。 */
export function collectCompelemImports(imports: ParsedFile['imports']): Map<string, string> {
  const out = new Map<string, string>()
  for (const [local, info] of imports) {
    if (!isCompelemSource(info.source)) continue
    out.set(local, info.imported)
  }
  return out
}

/** 收集模块级绑定名（含全部 import 本地名与顶层声明名）。 */
export function collectModuleBindings(parsed: ParsedFile): Set<string> {
  const out = new Set<string>()
  for (const local of parsed.imports.keys()) out.add(local)
  for (const stmt of parsed.program.body ?? []) {
    collectDeclNames(stmt, out)
  }
  return out
}

/** 从一条顶层语句里收集声明的名字（不进入函数体/类体）。 */
function collectDeclNames(stmt: any, into: Set<string>) {
  if (!stmt || typeof stmt.type !== 'string') return
  const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
    ? stmt.declaration
    : stmt
  if (!decl) return
  switch (decl.type) {
    case 'VariableDeclaration':
      for (const d of decl.declarations ?? []) collectPatNames(d.id, into)
      break
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      if (decl.id?.name) into.add(decl.id.name)
      break
    case 'TSEnumDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
      if (decl.id?.name) into.add(decl.id.name)
      break
  }
}

function collectPatNames(pat: any, into: Set<string>) {
  if (!pat) return
  switch (pat.type) {
    case 'Identifier':
      into.add(pat.name)
      break
    case 'ObjectPattern':
      for (const p of pat.properties ?? []) {
        if (p.type === 'RestElement') collectPatNames(p.argument, into)
        else collectPatNames(p.value ?? p.key, into)
      }
      break
    case 'ArrayPattern':
      for (const el of pat.elements ?? []) collectPatNames(el, into)
      break
    case 'AssignmentPattern':
      collectPatNames(pat.left, into)
      break
    case 'RestElement':
      collectPatNames(pat.argument, into)
      break
  }
}

/** 组件类的候选：有 decorator 或继承自 CompElem。 */
interface ClassCandidate {
  node: any
  className: string
  decorators: string[]
  isCompElemSubclass: boolean
}

function decoratorName(dec: any): string | null {
  const expr = dec?.expression ?? dec
  if (!expr) return null
  // @tag("x") / @prop({...}) → CallExpression
  if (expr.type === 'CallExpression') {
    const callee = expr.callee
    if (callee?.type === 'Identifier') return callee.name
    if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier') return callee.property.name
    return null
  }
  // @computed → Identifier
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
export { superClassName }

/** 提取 render() 方法的函数体与偏移。 */
function extractRenderBody(node: any): { body: any; start: number; end: number } | null {
  for (const member of node.body?.body ?? []) {
    if (member.type !== 'MethodDefinition' && member.type !== 'PropertyDefinition') continue
    if (keyName(member.key) !== 'render') continue
    const fn = member.value
    if (!fn || (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression')) continue
    const body = fn.body
    if (!body || body.type !== 'BlockStatement') continue
    return { body: body.body, start: body.start + 1, end: body.end - 1 }
  }
  return null
}

/**
 * U5：单 member 遍历提取类信息——原 extractReactiveFields / extractMembers /
 * extractDepBodies / extractRenderBody 各自一遍类体，现合并为一趟循环。
 * 各块语义与原独立函数逐字一致（首个合法 render 胜出、@computed 字段不看 kind 等）。
 */
export interface ClassInfo {
  fields: Map<string, ReactiveField>
  /** `@query` / `@queryAll` 字段名（非响应式 DOM 查询属性，依赖提取按死条目记录） */
  queryFields: Set<string>
  methods: Set<string>
  getters: Set<string>
  /** 方法 / getter / 箭头字段的函数体（name → BlockStatement 节点或表达式体），供依赖提取内联扫描 */
  bodies: Map<string, any>
  render: { body: any; start: number; end: number } | null
  cssVarsBody: any[] | null
  computedBodies: Map<string, any[]>
}

function extractClassInfo(node: any, aliases: Set<string>): ClassInfo {
  const fields = new Map<string, ReactiveField>()
  const queryFields = new Set<string>()
  const methods = new Set<string>()
  const getters = new Set<string>()
  const bodies = new Map<string, any>()
  let render: { body: any; start: number; end: number } | null = null
  let cssVars: any[] | null = null
  const computedBodies = new Map<string, any[]>()

  for (const member of node.body?.body ?? []) {
    const name = keyName(member.key)

    if (name) {
      // ---- 响应式字段（原 extractReactiveFields） ----
      const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
      let kind: ReactiveKind | null = null
      for (const d of decs) {
        if (!aliases.has(d)) continue
        if (d === 'prop') kind = 'prop'
        else if (d === 'state') kind = 'state'
        else if (d === 'computed') kind = 'computed'
        if (kind) break
      }
      if (kind === 'computed') {
        fields.set(name, { name, kind, init: undefined, shallow: false })
      } else if (kind) {
        const initNode = member.value
        let shallow = false
        if (initNode && (initNode.type === 'ObjectExpression' || initNode.type === 'ArrayExpression')) {
          shallow = !!((member.decorators ?? []).some((dec: any) => {
            const e = dec.expression
            if (e?.type !== 'CallExpression') return false
            return (e.arguments ?? []).some(
              (a: any) =>
                a.type === 'ObjectExpression' &&
                (a.properties ?? []).some(
                  (p: any) => keyName(p.key) === 'shallow' && p.value?.value === true,
                ),
            )
          }))
        }
        fields.set(name, { name, kind, init: undefined, shallow })
      } else if (decs.includes('query') || decs.includes('queryAll')) {
        // @query / @queryAll：非响应式 DOM 查询属性（依赖提取中按死条目记录，不参与根分级）
        queryFields.add(name)
      }

      // ---- 方法/getter 名（原 extractMembers） ----
      if (member.type === 'MethodDefinition') {
        if (member.kind === 'get') getters.add(name)
        else methods.add(name)
        const fn = member.value
        if (fn?.body) bodies.set(name, fn.body)
      } else if (member.type === 'PropertyDefinition') {
        // 箭头函数字段也算方法
        const init = member.value
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          methods.add(name)
          if (init.body) bodies.set(name, init.body)
        }
      }
    }

    // ---- render()（原 extractRenderBody；首个合法 render 胜出） ----
    if (
      !render &&
      (member.type === 'MethodDefinition' || member.type === 'PropertyDefinition') &&
      keyName(member.key) === 'render'
    ) {
      const fn = member.value
      if (fn && (fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression')) {
        const body = fn.body
        if (body && body.type === 'BlockStatement') {
          render = { body: body.body, start: body.start + 1, end: body.end - 1 }
        }
      }
    }

    // ---- cssVars / @computed getter 体（原 extractDepBodies） ----
    if (member.type === 'MethodDefinition' && name) {
      const fn = member.value
      if (fn && (fn.type === 'FunctionExpression' || fn.type === 'ArrowFunctionExpression')) {
        const body = fn.body
        if (body && body.type === 'BlockStatement') {
          if (name === 'cssVars' && member.kind === 'get') {
            cssVars = body.body
          } else if (member.kind === 'get') {
            const gdecs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
            if (gdecs.some((d) => aliases.has(d) && d === 'computed')) {
              computedBodies.set(name, body.body)
            }
          }
        }
      }
    }
  }
  return { fields, queryFields, methods, getters, bodies, render, cssVarsBody: cssVars, computedBodies }
}

/** U5：extractClassInfo 按 class 节点记忆（同文件祖先在依赖提取中被多组件复用）。 */
const INFO_CACHE = new WeakMap<object, ClassInfo>()

/** 取某 class 节点的 ClassInfo（WeakMap 记忆；aliases 为文件级常量，同文件命中安全）。 */
export function classInfoOf(node: any, aliases: Set<string>): ClassInfo {
  const hit = INFO_CACHE.get(node)
  if (hit) return hit
  const info = extractClassInfo(node, aliases)
  INFO_CACHE.set(node, info)
  return info
}

/** U5：collectLocalClasses 结果按 ParsedFile 记忆（analyzeFile 与 compile.ts 各调一次，共享同一遍结果）。 */
const LOCAL_CLASSES_CACHE = new WeakMap<object, Map<string, any>>()

/** 收集文件内全部 class 声明（本地名 → AST 节点），含 export 形态。继承链与约定检查共用。 */
export function collectLocalClasses(parsed: ParsedFile): Map<string, any> {
  const cached = LOCAL_CLASSES_CACHE.get(parsed as object)
  if (cached) return cached
  const localClasses = new Map<string, any>()
  for (const stmt of parsed.program.body ?? []) {
    if (stmt.type === 'ClassDeclaration' && stmt.id?.name) {
      localClasses.set(stmt.id.name, stmt)
    }
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration?.type === 'ClassDeclaration') {
      localClasses.set(stmt.declaration.id.name, stmt.declaration)
    }
    if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration?.type === 'ClassDeclaration') {
      const n = stmt.declaration.id?.name ?? 'default'
      localClasses.set(n, stmt.declaration)
    }
  }
  LOCAL_CLASSES_CACHE.set(parsed as object, localClasses)
  return localClasses
}

/**
 * 类体是否带 compelem 家族装饰器（`@prop/@state/@computed/@query/@queryAll`）。
 *
 * 这是「该类是不是组件」的**精确判别器**：这些装饰器在运行时全是 no-op，
 * 只在编译期有意义 ⇒ 带它们的类必然意图是组件；反之不带它们的类
 * （`class LiveFieldMap extends Map` 之类）不可能是组件。
 */
export function hasCompelemFamilyDecorator(cls: any, aliases: Set<string>): boolean {
  return (cls?.body?.body ?? []).some((m: any) =>
    (m.decorators ?? []).some((d: any) => aliases.has(decoratorName(d) ?? '')),
  )
}

/** U5：collectMixinClasses 结果按 ParsedFile 记忆。 */
const MIXIN_CLASSES_CACHE = new WeakMap<object, any[]>()

/**
 * 收集「mixin 工厂内」的 class 声明 —— **单独成列表，绝不混入 `localClasses`**。
 *
 * ## 为什么需要单独一套
 * `localClasses` 是**按类名**索引的，被 `deps-extract` / `conventions` / `component.ts`
 * 的 D0 拆分用于解析**同文件 super 继承链**。mixin 里的类既不与外部按名关联、
 * 也不在模块作用域，混进去会污染这些按名查找（同名遮蔽、深度计算偏移）。
 *
 * ## 收录条件（三者全满足，缺一不可）
 * 1. 位于**模块顶层函数**的函数体直接语句里（`export function mix(B) { class M extends B {} }`）；
 *    不递归进任意嵌套（避免把方法体内的局部类、`if`/`for` 块内的类也收进来）
 * 2. 是 `ClassDeclaration`（**不是** `ClassExpression` —— TS 禁止在 class 表达式上写
 *    装饰器 TS1206，能带 `@prop` 的形态只有 class 声明，见 DESIGN「mixin 装饰器」）
 * 3. 类体带**至少一个 compelem 家族装饰器**（`@prop/@state/@computed/@query/@queryAll`）——
 *    这是精确判别器：`class LiveFieldMap extends Map` 之类无 compelem 装饰器，自动排除
 */
export function collectMixinClasses(parsed: ParsedFile, aliases: Set<string>): any[] {
  const cached = MIXIN_CLASSES_CACHE.get(parsed as object)
  if (cached) return cached
  const out: any[] = []
  for (const stmt of parsed.program.body ?? []) {
    const decl =
      stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
        ? stmt.declaration
        : stmt
    if (decl?.type !== 'FunctionDeclaration' && decl?.type !== 'FunctionExpression') continue
    for (const inner of decl.body?.body ?? []) {
      const cls = inner?.type === 'ClassDeclaration' ? inner : undefined
      if (cls && cls.id?.name && hasCompelemFamilyDecorator(cls, aliases)) out.push(cls)
    }
  }
  MIXIN_CLASSES_CACHE.set(parsed as object, out)
  return out
}

// `classNodeOf` / `componentClassNode` 已于 2026-10-05 删除：它们是「取组件自身 class
// AST 节点」的兼容包装（优先 `comp.cls`，回退 `localClasses.get(className)`），
// 但 8 个调用点早已各自内联同一表达式（`conventions.ts:367`、`deps-extract.ts:287`、
// `field-extract.ts:141/178`、`template-rules.ts:79/111`、`watch-extract.ts:270`、
// `compile.ts:322`），全仓零调用。
//
// ⚠️ 内联时必须保留 `comp.cls ?? localClasses.get(comp.className)` 这个**双通道**：
// 只按名查 `localClasses` 只收模块顶层的 `ClassDeclaration`，mixin 工厂内的函数作用域类
// 按名查不到 → `field-extract` 等会拿到 undefined 而**静默不提取**。

/**
 * 分析单个源文件，返回所有 compelem 组件类的信息。
 *
 * `extraFields` 用于合并基类字段（编译器单文件分析，跨文件继承由调用方
 * 通过 `componentIndex` 提供；本版本仅处理同文件继承 + 无继承两种）。
 */
export function analyzeFile(code: string, id: string, parsed: ParsedFile): ComponentAnalysis[] {
  const compelemImports = collectCompelemImports(parsed.imports)
  const aliases = new Set(compelemImports.values())
  const hasCompElemAlias = aliases.has('CompElem')

  // 1) 先收集同文件里的 class 声明，建立「本地类名 → 是否 CompElem 子类」映射
  const localClasses = collectLocalClasses(parsed)
  // 1b) mixin 工厂内的 class 声明（单独列表，不进 localClasses —— 见 collectMixinClasses 注释）
  const mixinClasses = collectMixinClasses(parsed, aliases)

  const isSub = (cls: any, depth = 0): boolean => {
    if (depth > 8) return false
    const sup = superClassName(cls)
    if (!sup) return false
    if (hasCompElemAlias && sup === 'CompElem') return true
    const parent = localClasses.get(sup)
    if (parent) return isSub(parent, depth + 1)
    return false
  }

  const out: ComponentAnalysis[] = []
  const moduleBindings = collectModuleBindings(parsed)
  // 顶层 class（按名索引）+ mixin class（函数作用域，按数组）统一成一份工作表处理
  const worklist: Array<{ className: string; cls: any; isMixin: boolean }> = [
    ...[...localClasses].map(([className, cls]) => ({ className, cls, isMixin: false })),
    ...mixinClasses.map((cls) => ({ className: cls.id.name, cls, isMixin: true })),
  ]
  for (const { className, cls, isMixin } of worklist) {
    const decs: string[] = (cls.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
    // 组件准入三选一：
    //  1) `isSub` —— super 链能在**本文件**内解析到 CompElem（最常见）
    //  2) `@tag` —— 显式声明要注册自定义元素
    //  3) **类体带 compelem 家族装饰器** —— 覆盖前两者都判不出的两类：
    //     · mixin 工厂内的类（super 是形参）
    //     · **跨文件基类**（super 在别的文件，如 `class FormControl extends AppearanceElem`）
    //       这类 super 解析不出 + 无 @tag ⇒ 不被识别为组件 ⇒ 其 @prop 装饰器
    //       从不剥离，而运行时 @prop 是 no-op ⇒ prop 静默退化成普通实例字段。
    //       判别器是精确的：家族装饰器运行时全 no-op，只在编译期有意义。
    const byDecorator = hasCompelemFamilyDecorator(cls, aliases)
    const sub = isSub(cls)
    if (!sub && !decs.includes('tag') && !byDecorator) continue
    /** 仅靠「带家族装饰器」准入 ⇒ super 链不可知（mixin 形参 / 跨文件基类） */
    const unknownSuperAdmitted = !sub && !decs.includes('tag') && byDecorator

    const { fields, queryFields, methods, getters, bodies, render, cssVarsBody, computedBodies } = classInfoOf(cls, aliases)
    const tagDec = (cls.decorators ?? []).find((d: any) => decoratorName(d) === 'tag')
    let tagName: string | undefined
    if (tagDec) {
      const e = tagDec.expression
      if (e?.type === 'CallExpression' && e.arguments?.[0]) {
        const a = e.arguments[0]
        if (a.type === 'Literal' || a.type === 'StringLiteral') tagName = String(a.value)
      }
    }

    let degradeReason: string | null = null
    let noView = false
    let skipInjection = false

    if (!render) {
      // D0 拆分：无 own render() 时，沿同文件继承链向上找；
      //  - 链上有 render → skipInjection（不注入，继承父类 __ce_static__，静态字段经构造器原型链继承）
      //  - 链终于 CompElem（其 render() 返回 null）→ noView: true 注入（无视图组件）
      //  - 链终于未知跨文件基类 → D6 降级（→ 报错）
      //  - @tag 非 CompElem 类 → D0 降级
      //  - **super 链不可知者（mixin 形参 / 仅靠装饰器准入的跨文件基类）→ 一律
      //    skipInjection**（见下）
      const sup = superClassName(cls)
      if (isMixin || unknownSuperAdmitted) {
        // super 不可知 ⇒ 无法判断基类有没有 render：
        //   · 判 skipInjection：字面量 spread 继承基类视图字段。基类有视图 → 继承到（正确）；
        //     基类无视图 → spread 得到空，退化为「无静态视图」，DEV 报错，与未编译组件同路径。
        //   · **绝不能判 noView**：noView 会跳过 Shadow DOM 创建；若基类其实有 render，
        //     组件将静默白屏（无报错、无降级）——这是最坏的失败形态。
        //   · 也**不能**沿用 D6/D0 报错：跨文件基类与 mixin 在真实项目里是常态
        //     （compelem-ui 的 FormControl/BaseInput/ControlBox 即是），阻断构建等于不可用。
        skipInjection = true
      } else if (!sup) {
        degradeReason = 'D0: 无 render() 或 render 体不是 BlockStatement'
      } else if (hasCompElemAlias && sup === 'CompElem') {
        noView = true
      } else if (localClasses.has(sup)) {
        // 同文件继承链：向上找首个有 render 的祖先
        let cur: any = cls
        let found = false
        let unknownCrossFile = false
        const seen = new Set<any>()
        while (cur && !seen.has(cur)) {
          seen.add(cur)
          const curSup = superClassName(cur)
          if (!curSup) break
          if (hasCompElemAlias && curSup === 'CompElem') {
            // 链终于 CompElem：整条链上都没有 render（当前类无，祖先若有已被 break）
            // 但上面的循环没检查祖先是否有 render——重新走一遍
            found = false
            break
          }
          if (localClasses.has(curSup)) {
            const parent = localClasses.get(curSup)
            if (extractRenderBody(parent)) {
              found = true
              break
            }
            cur = parent
            continue
          }
          // 跨文件基类：无法判断是否有 render
          unknownCrossFile = true
          break
        }
        if (found) {
          skipInjection = true
        } else if (unknownCrossFile) {
          degradeReason = `D6: 跨文件继承 render（基类 ${sup} 不在本文件）`
        } else {
          // 链终于 CompElem 且整条链无 render → 无视图组件
          noView = true
        }
      } else {
        degradeReason = `D0: 无 render() 且非 CompElem 子类（基类 ${sup} 不在本文件）`
      }
    } else {
      const rets = topLevelReturns(render.body)
      if (rets.length === 0) degradeReason = 'D4: render() 内没有顶层 return'
      else if (rets.length > 1) degradeReason = `D5: render() 有 ${rets.length} 个顶层 return`
    }

    out.push({
      className,
      cls,
      start: cls.start,
      end: cls.end,
      bodyStart: cls.body?.start ?? -1,
      tagName,
      fields,
      queryFields,
      ownMethods: methods,
      ownGetters: getters,
      bodies,
      hasRender: !!render,
      renderBody: render?.body ?? null,
      renderBodyStart: render?.start ?? -1,
      renderBodyEnd: render?.end ?? -1,
      cssVarsBody,
      computedBodies,
      degradeReason,
      noView,
      skipInjection,
      isMixin: isMixin || unknownSuperAdmitted,
      compelemImports,
      moduleBindings,
    })
  }
  void code
  void id
  return out
}
