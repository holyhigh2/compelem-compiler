/**
 * 组件识别与响应式字段提取。
 */
import type { ComponentAnalysis, ReactiveField, ReactiveKind } from '../types'
import type { ParsedFile } from '../utils/ast'
import { collectPatternNames, keyName, topLevelReturns } from '../utils/ast'

/** 判断某个 import source 是否指向 compelem 本体。 */
export function isCompelemSource(source: string): boolean {
  // 1) `@compelem/*` 是独立子包，先排除——否则会被下面「路径含 compelem」的规则误判为本体
  if (/^@compelem\//.test(source)) return false // @compelem/* 子包不算本体
  // 2) 包名 / 路径里含 `compelem`
  if (/(^|[/@])compelem([/@]|$)|compelem\//.test(source)) return true
  // 3) 相对路径指向 src 入口（本仓库 dev 形态）：**精确匹配**整串——
  //    `../src/store`、`./srcfoo` 之类**不得**误判为本体（曾把相邻子目录当 compelem，
  //    触发 helper import 选错源）。
  if (
    source === './src' || source === '../src' ||
    source === './src/index' || source === '../src/index'
  ) return true
  // 4) 裸相对路径也可能重导出 compelem（如 '../common'），此处不放行，交由调用方二次确认
  return false
}

/**
 * 判断某个 import source 是否指向 **myfx**。
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
      for (const d of decl.declarations ?? []) collectPatternNames(d.id, into)
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

/**
 * 收集**模块级 `const`** 的初始化器 AST：名字 → VariableDeclarator。
 *
 * 与 {@link collectModuleBindings} 的区别：后者只收名字（用于自由标识符放行），
 * 这里收**初始化器**，供模板静态片段折叠（`${CONST}`）判定「该标识符是不是一个
 * 模块级 `h` 标签模板常量」。
 *
 * 收窄到 `const` 是刻意的：`let`/`var` 可被重新赋值，折叠会把某次运行的值固化进
 * 产物，语义与源码不符。跨文件 import 不收 —— compileFile 是单文件纯函数。
 */
export function collectModuleConstInits(parsed: ParsedFile): Map<string, any> {
  const out = new Map<string, any>()
  for (const stmt of parsed.program.body ?? []) {
    const decl = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
      ? stmt.declaration
      : stmt
    if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue
    for (const d of decl.declarations ?? []) {
      if (d.id?.type === 'Identifier' && d.id.name && d.init) out.set(d.id.name, d)
    }
  }
  return out
}

/** 装饰器本地名与基类名的统一实现见 utils/ast（此前本文件与 conventions /
 * template-rules 各抄了一份，已漂移）。这里转出以维持既有 import 路径。 */
import { decoratorName, superClassName } from '../utils/ast'
export { decoratorName, superClassName }

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
  /** render 是表达式体（`render = () => h…`）—— 当前静态路径无法剥离/编译，显式 D0。 */
  renderInvalid: boolean
  cssVarsBody: any[] | null
  computedBodies: Map<string, any[]>
}

/**
 * compelem 导入名解析器：**本地名 → 导入原名**（`import { prop as p }` ⇒ `p` ⇒ `'prop'`）。
 *
 * ⚠️ 不得再用「导入名集合 + 本地名比对」的写法（`aliases.has(localName)`）：
 * 本地名与导入原名只在**未取别名**时相等。`import { prop as p }` 下
 * `aliases.has('p')` 为假 ⇒ `@prop` 不被识别、类不被判为组件 ⇒ prop 静默退化成
 * 普通实例字段（运行时装饰器是 no-op，全程无任何报错兜底）。
 * 一律用解析器判「这个装饰器/基类名是不是 compelem 的 X」。
 */
export type ImportResolver = (local: string) => string | undefined

/** 由 `collectCompelemImports` 的结果（本地名 → 导入原名）造解析器。 */
export function compelemResolver(imports: ReadonlyMap<string, string>): ImportResolver {
  return (local: string) => imports.get(local)
}

function extractClassInfo(node: any, resolve: ImportResolver): ClassInfo {
  const fields = new Map<string, ReactiveField>()
  const queryFields = new Set<string>()
  const methods = new Set<string>()
  const getters = new Set<string>()
  const bodies = new Map<string, any>()
  let render: { body: any; start: number; end: number } | null = null
  let renderInvalid = false
  let cssVars: any[] | null = null
  const computedBodies = new Map<string, any[]>()

  for (const member of node.body?.body ?? []) {
    const name = keyName(member.key)

    if (name) {
      // ---- 响应式字段（原 extractReactiveFields） ----
      const decs: string[] = (member.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
      let kind: ReactiveKind | null = null
      for (const d of decs) {
        const imported = resolve(d)
        if (imported === 'prop') { kind = 'prop'; break }
        if (imported === 'state') { kind = 'state'; break }
        if (imported === 'computed') { kind = 'computed'; break }
      }
      if (kind) {
        fields.set(name, { name, kind })
      } else if (decs.some((d) => {
        const imported = resolve(d)
        return imported === 'query' || imported === 'queryAll'
      })) {
        // @query / @queryAll：非响应式 DOM 查询属性（依赖提取中按死条目记录，不参与根分级）
        // 必须走 resolve，别名导入（query as q）也要能识别。
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
          renderInvalid = false
        } else if (!renderInvalid) {
          // 表达式体 render 运行期不会被 setup 消费；静默判 noView 会白屏，
          // 这里记录后由 analyzeFile 报 D0。
          renderInvalid = true
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
            if (gdecs.some((d) => resolve(d) === 'computed')) {
              computedBodies.set(name, body.body)
            }
          }
        }
      }
    }
  }
  return { fields, queryFields, methods, getters, bodies, render, renderInvalid, cssVarsBody: cssVars, computedBodies }
}

/** U5：extractClassInfo 按 class 节点记忆（同文件祖先在依赖提取中被多组件复用）。 */
const INFO_CACHE = new WeakMap<object, ClassInfo>()

/** 取某 class 节点的 ClassInfo（WeakMap 记忆；resolve 为文件级常量，同文件命中安全）。 */
export function classInfoOf(node: any, resolve: ImportResolver): ClassInfo {
  const hit = INFO_CACHE.get(node)
  if (hit) return hit
  const info = extractClassInfo(node, resolve)
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
export function hasCompelemFamilyDecorator(cls: any, resolve: ImportResolver): boolean {
  return (cls?.body?.body ?? []).some((m: any) =>
    (m.decorators ?? []).some((d: any) => resolve(decoratorName(d) ?? '') !== undefined),
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
export function collectMixinClasses(parsed: ParsedFile, resolve: ImportResolver): any[] {
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
      if (cls && cls.id?.name && hasCompelemFamilyDecorator(cls, resolve)) out.push(cls)
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
  const resolve = compelemResolver(compelemImports)
  // 1) 先收集同文件里的 class 声明，建立「本地类名 → 是否 CompElem 子类」映射
  const localClasses = collectLocalClasses(parsed)
  // 1b) mixin 工厂内的 class 声明（单独列表，不进 localClasses —— 见 collectMixinClasses 注释）
  const mixinClasses = collectMixinClasses(parsed, resolve)

  const isSub = (cls: any, depth = 0): boolean => {
    if (depth > 8) return false
    const sup = superClassName(cls)
    if (!sup) return false
    // `superClassName` 给的是**本地名**，别名导入（`CompElem as CE`）须经导入表还原
    if (resolve(sup) === 'CompElem') return true
    const parent = localClasses.get(sup)
    if (parent) return isSub(parent, depth + 1)
    return false
  }

  const out: ComponentAnalysis[] = []
  const moduleBindings = collectModuleBindings(parsed)
  const moduleConstInits = collectModuleConstInits(parsed)
  // 顶层 class（按名索引）+ mixin class（函数作用域，按数组）统一成一份工作表处理
  const worklist: Array<{ className: string; cls: any; isMixin: boolean }> = [
    ...[...localClasses].map(([className, cls]) => ({ className, cls, isMixin: false })),
    ...mixinClasses.map((cls) => ({ className: cls.id.name, cls, isMixin: true })),
  ]
  for (const { className, cls, isMixin } of worklist) {
    // 装饰器本地名 → 导入原名（`@tag` 取别名时本地名不是 'tag'）
    const decs: string[] = (cls.decorators ?? []).map(decoratorName).filter(Boolean) as string[]
    const importedDecs = new Set(decs.map((d) => resolve(d)))
    // 组件准入三选一：
    //  1) `isSub` —— super 链能在**本文件**内解析到 CompElem（最常见）
    //  2) `@tag` —— 显式声明要注册自定义元素
    //  3) **类体带 compelem 家族装饰器** —— 覆盖前两者都判不出的两类：
    //     · mixin 工厂内的类（super 是形参）
    //     · **跨文件基类**（super 在别的文件，如 `class FormControl extends AppearanceElem`）
    //       这类 super 解析不出 + 无 @tag ⇒ 不被识别为组件 ⇒ 其 @prop 装饰器
    //       从不剥离，而运行时 @prop 是 no-op ⇒ prop 静默退化成普通实例字段。
    //       判别器是精确的：家族装饰器运行时全 no-op，只在编译期有意义。
    const byDecorator = hasCompelemFamilyDecorator(cls, resolve)
    const sub = isSub(cls)
    if (!sub && !importedDecs.has('tag') && !byDecorator) continue
    /**
     * super 链不可知（mixin 形参 / 跨文件基类）⇒ 无 own render() 时走 skipInjection。
     *
     * 判据分两种：
     * - 家族装饰器（prop/state/computed/...）：一定准入；
     * - @tag + super 在文件外：裸包装子类（如 `@tag("ce-editable") class Editable extends Table`）
     *   也必须能继承基类视图；本地 super 链仍走 D0/D6/noView 规则。
     * 失败形态可诊断：基类无视图时 spread 为空，运行时按“未编译”报错，不会静默白屏。
     */
    // 家族装饰器始终可准入；@tag 只在“super 在文件外、无法判断基类是否有视图”时
    // 才允许走 skipInjection（裸 @tag 包装子类），本地链仍按 D0/D6/noView 规则处理。
    const tagSuper = superClassName(cls)
    const unknownSuperAdmitted =
      !sub && (byDecorator || (!!tagSuper && !localClasses.has(tagSuper) && importedDecs.has('tag')))

    const { fields, queryFields, methods, getters, bodies, render, renderInvalid, cssVarsBody, computedBodies } = classInfoOf(cls, resolve)
    const tagDec = (cls.decorators ?? []).find((d: any) => resolve(decoratorName(d) ?? '') === 'tag')
    let tagName: string | undefined
    if (tagDec) {
      const e = tagDec.expression
      if (e?.type === 'CallExpression' && e.arguments?.[0]) {
        const a = e.arguments[0]
        if (a.type === 'Literal' || a.type === 'StringLiteral') tagName = String(a.value)
      }
    }

    let staticReason: string | null = null
    let noView = false
    let skipInjection = false

    if (!render) {
      // D0 拆分：无 own render() 时，沿同文件继承链向上找；
      //  - 链上有 render → skipInjection（不注入，继承父类 __ce_static__，静态字段经构造器原型链继承）
      //  - 链终于 CompElem（其 render() 返回 null）→ noView: true 注入（无视图组件）
      //  - 链终于未知跨文件基类 → D6 阻断（报错）
      //  - **super 链不可知者（mixin 形参 / 家族装饰器或 @tag 准入的跨文件基类）
      //    → 一律 skipInjection**（见下）
      const sup = superClassName(cls)
      if (isMixin || unknownSuperAdmitted) {
        // super 不可知 ⇒ 无法判断基类有没有 render：
        //   · 判 skipInjection：字面量 spread 继承基类视图字段。基类有视图 → 继承到（正确）；
        //     基类无视图 → spread 得到空，退化为「无静态视图」，DEV 报错，与未编译组件同路径。
        //   · **绝不能判 noView**：noView 会跳过 Shadow DOM 创建；若基类其实有 render，
        //     组件将静默白屏（无报错）——这是最坏的失败形态。
        //   · 也**不能**沿用 D6/D0 报错：跨文件基类与 mixin 在真实项目里是常态
        //     （compelem-ui 的 FormControl/BaseInput/ControlBox 即是），阻断构建等于不可用。
        skipInjection = true
      } else if (!sup) {
        staticReason = 'D0: 无 render() 或 render 体不是 BlockStatement'
      } else if (resolve(sup) === 'CompElem') {
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
          if (resolve(curSup) === 'CompElem') {
            // 链终于 CompElem：整条链上都没有 render（当前类无，祖先已在循环里逐个检查）
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
          staticReason = `D6: 跨文件继承 render（基类 ${sup} 不在本文件）`
        } else {
          // 链终于 CompElem 且整条链无 render → 无视图组件
          noView = true
        }
      } else {
        staticReason = `D0: 无 render() 且非 CompElem 子类（基类 ${sup} 不在本文件）`
      }
    } else {
      const rets = topLevelReturns(render.body)
      if (rets.length === 0) staticReason = 'D4: render() 内没有顶层 return'
      else if (rets.length > 1) staticReason = `D5: render() 有 ${rets.length} 个顶层 return`
    }
    // 表达式体 render 没有可剥离的块体，setup 也不会调用它；静默判 noView 会白屏。
    if (renderInvalid) {
      staticReason = 'D0: render 必须是带块体的方法（表达式体 render 暂不支持）'
      noView = false
      skipInjection = false
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
      staticReason,
      noView,
      skipInjection,
      isMixin: isMixin || unknownSuperAdmitted,
      compelemImports,
      moduleBindings,
      moduleConstInits,
    })
  }
  void code
  void id
  return out
}
