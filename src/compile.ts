/**
 * 编译器主流程：单文件 → 注入 `__ce_static__` 后的源码。
 */
import { analyzeFile, collectLocalClasses, collectModuleBindings, isCompelemSource, isMyfxSource } from './analyze/component'
import { checkConventions, collectModuleConsts, collectModuleFunctions, collectStringConsts } from './analyze/conventions'
import { extractComputedDeps, extractCssDeps } from './analyze/deps-extract'
import { extractFieldAccessors, RUNTIME_HELPERS } from './analyze/field-extract'
import { inlineTemplateMethodsWithEdits, type Edit as InlineEdit } from './analyze/inline-template-methods'
import { extractMethodDecos } from './analyze/method-deco-extract'
import { analyzeRender } from './analyze/render-body'
import { assertStaticAnalysis, StaticAnalysisError } from './analyze/static-gate'
import { extractMainTemplate, TemplateExtractError, varsByUpIndex } from './analyze/template-extract'
import { checkDirectiveArgs, checkTemplateRules } from './analyze/template-rules'
import { collectSubCandidates, enclosingCandidates, paramBaseNames, stripTsChecked, SubExtractError } from './analyze/template-subs'
import { buildTemplateHTML, clearAttrFragments, parseTemplateTree, TemplateParseError } from './analyze/template-tree'
import { extractWatchers, generateWatchEffects, type WatchEntry } from './analyze/watch-extract'
import { generateBuildVars, generateSubBuildVars, rewriteThis, type BuildVarsOptions } from './codegen/build-vars'
import { buildStaticLiteral, emitFamily, emitWatchEffects, injectInto, planCtorInsert, type CtorInsertPlan } from './codegen/inject'
import { buildSubInliner, generateRenderEffect, generateSubInlinedEffect } from './codegen/render-effect'
import { generateBuildTemplate, type UpOut } from './codegen/template-dom'
import type { CompilerOptions, ComponentAnalysis } from './types'
import { DEBUG_DIV } from './types'
import { collectPatternNames, parse, parseUncached, unwrapExpr } from './utils/ast'
import { degradePrivateNames } from './utils/js-text'

/** 方法装饰器（@debounced/@throttled/@onced）前移所需的 myfx helper，与 RUNTIME_HELPERS 共用别名机制。 */
const MYFX_HELPERS = ['debounce', 'throttle', 'once'] as const

/**
 * 收集 prelude 里**在函数作用域内可见**的声明名
 */
function collectPreludeDeclNames(rawPrelude: string, out: Set<string>): void {
  if (!rawPrelude) return
  let body: any
  try {
    const parsed = parseUncached(`(function(){ ${degradePrivateNames(rawPrelude)} })`)
    body = parsed.program?.body?.[0]?.expression?.body
  } catch {
    return
  }
  if (!body) return

  /**
   * @param top 是否处于函数体顶层（顶层 let/const/function/class 才可见）
   */
  const walkStmts = (stmts: any[] | undefined, top: boolean): void => {
    for (const stmt of stmts ?? []) if (stmt) walkStmt(stmt, top)
  }

  const walkStmt = (stmt: any, top: boolean): void => {
    switch (stmt.type) {
      case 'VariableDeclaration': {
        // var 提升到函数作用域（任意深度可见）；let/const 只有顶层那份可见。
        if (stmt.kind === 'var' || top) {
          for (const d of stmt.declarations ?? []) collectPatternNames(d.id, out)
        }
        return
      }
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        // 严格模式下块级函数是块级作用域 ⇒ 只收顶层。
        if (top && stmt.id?.name) out.add(stmt.id.name)
        return
      case 'BlockStatement':
        walkStmts(stmt.body, false)
        return
      case 'IfStatement':
        walkStmt(stmt.consequent, false)
        if (stmt.alternate) walkStmt(stmt.alternate, false)
        return
      case 'ForStatement':
        // `for (var i = 0; …)` 的 i 也是函数作用域（init 是表达式时 walkStmt 落到 default 直接返回）
        if (stmt.init) walkStmt(stmt.init, false)
        walkStmt(stmt.body, false)
        return
      case 'ForInStatement':
      case 'ForOfStatement':
        if (stmt.left?.type === 'VariableDeclaration') walkStmt(stmt.left, false)
        walkStmt(stmt.body, false)
        return
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'LabeledStatement':
      case 'WithStatement':
        walkStmt(stmt.body, false)
        return
      case 'TryStatement':
        walkStmt(stmt.block, false)
        if (stmt.handler) walkStmt(stmt.handler.body, false)
        if (stmt.finalizer) walkStmt(stmt.finalizer, false)
        return
      case 'SwitchStatement':
        for (const c of stmt.cases ?? []) walkStmts(c.consequent, false)
        return
      default:
        return
    }
  }

  walkStmts(body.body, true)
}

/**
 * inline 预变换后的 offset → 原始源码 offset。
 *
 * 偏移落在替换文本内部时只能映射到替换起点（无法精确还原），用于诊断/sourcemap
 * 足够；替换区间边界映射到原区间端点。
 */
function mapInlineOffset(offset: number, edits: readonly InlineEdit[]): number {
  if (!edits.length) return offset
  let cum = 0
  for (const e of edits) {
    const tStart = e.start + cum
    const tEnd = tStart + e.text.length
    if (offset < tStart) break
    if (offset < tEnd) return e.start
    if (offset === tEnd) return e.end
    cum += e.text.length - (e.end - e.start)
  }
  return offset - cum
}

/** 把最终产物里的 edit 描述整体映射回原始源码坐标。 */
function mapEditToOriginal(edit: any, inlineEdits: readonly InlineEdit[]): any {
  const map = (n: number) => mapInlineOffset(n, inlineEdits)
  return {
    ...edit,
    comp: {
      ...edit.comp,
      start: map(edit.comp.start),
      end: map(edit.comp.end),
      bodyStart: map(edit.comp.bodyStart),
      renderBodyStart: map(edit.comp.renderBodyStart),
      renderBodyEnd: map(edit.comp.renderBodyEnd),
    },
    removals: edit.removals?.map((r: { start: number; end: number }) => ({ start: map(r.start), end: map(r.end) })),
    ctor: edit.ctor ? { ...edit.ctor, pos: map(edit.ctor.pos) } : undefined,
  }
}

/** 静态编译完成后的组件依赖清单（`options.verbose` 时打印；结构化字段供工具/survey 消费）。 */
export interface DepSummary {
  kind: 'normal' | 'noView' | 'skipInjection'
  /** 主视图响应式依赖（仅 verbose 依赖清单展示，不注入产物） */
  viewDeps: string[]
  /** cssVars getter 依赖；undefined = 未提取到 */
  cssDeps?: string[]
  /** @computed getter 依赖；undefined = 未提取到（该类全部 key 由运行时全根兜底） */
  computedDeps?: Record<string, string[]>
  /** 结构指令子视图依赖（subId → 路径）；undefined = 未提取到 */
  subViewDeps?: Record<number, string[]>
  /** @watch 编译期解析产物（sources 即监视依赖） */
  watchers?: Array<{ name: string; sources: string[] }>
  /** 主视图更新映射：每根变量 → 取值槽位 → 更新点下标 → DOM 点位（normal 组件且 verbose 展示时） */
  varMap?: VarMapEntry[]
  /** 子视图更新映射：subId → 每根路径的槽位/updater/DOM */
  subVarMap?: Record<number, VarMapEntry[]>
}

export interface CompileResult {
  code: string
  map: any
  /** 本次编译的诊断信息（组件级） */
  diagnostics: Array<{
    className: string
    viewDeps: number
    /**
     * 约定错误（emit/@prop/@computed/@csscope 静态校验）。
     */
    conventionErrors: Array<{ start: number; end: number; message: string; severity?: 'warn' }>
    /** 静态依赖清单（每组件无条件填充；options.verbose 时输出人类可读格式） */
    deps?: DepSummary
  }>
  /** 是否发生了源码改动 */
  changed: boolean
  /** 本次编译从源码删除的 span（装饰器/字段成员/静态准入组件的 render 体，原始偏移；供最小侵入校验还原比对） */
  removals?: Array<{ start: number; end: number }>
  /** 本次编译新增的源码片段（注入的 import 片段 / 构造体写入语句；供最小侵入校验剥离） */
  additions?: string[]
}

/** 单个根变量的更新映射（依赖清单展示）：根 → 取值槽位 → 更新点下标 → DOM 点位。 */
export interface VarMapEntry {
  /** 根名（`''` = 常脏：动态 this / 不纯 / 未分类表达式） */
  root: string
  /** 根类别：已知字段 kind / 自有 getter / 自有方法 / 跨文件未声明（基类 prop、state、@computed 等） */
  kind?: 'prop' | 'state' | 'computed' | 'getter' | 'method' | 'unknown'
  /** 该根驱动的取值槽位下标（脏集，仅对脏槽求值） */
  vars: number[]
  /** 消费这些槽位的更新点：updater = ups 数组下标（与 ups 同序），dom = 节点名 + 点位 */
  updates: Array<{ updater: number; dom: string }>
}

/** 编译期更新映射（debug 依赖清单展示用，注入产物中不出现）。 */
interface UpdateMeta {
  varMap?: VarMapEntry[]
  subVarMap?: Record<number, VarMapEntry[]>
}

/** up 描述符 → 人可读 DOM 点位：`<span class>` / `<ce-button @click>` / `#text [dir:text]`。 */
function domLabel(up: UpOut, nodeNames: string[] | undefined): string {
  const node = (nodeNames && nodeNames[up.nodeSn]) || `#${up.nodeSn}`
  if (up.isEvent) return `<${node} @${up.attrName}>`
  if (up.isRef) return `<${node} ref>`
  if (up.isProp) return `<${node} .${up.attrName}>`
  if (up.isToggleProp) return `<${node} ?${up.attrName}>`
  if (up.isRefAttr) return `<${node} *${up.attrName}>`
  if (up.isDirective) {
    return up.directiveType === 'tag' ? `<${node} [dir]>` : `${node} [dir:${up.directiveType}]`
  }
  if (up.isText) return node
  if (up.attrName) return `<${node} ${up.attrName}>`
  return `<${node}>`
}

/** biMap + ups → 每根变量的 vars/updater/DOM 映射（无 biMap 或无更新点返回 undefined）。 */
function makeVarMap(
  comp: ComponentAnalysis,
  biMap: Record<string, number[]> | undefined,
  ups: UpOut[] | undefined,
  nodeNames: string[] | undefined,
): VarMapEntry[] | undefined {
  if (!biMap || !ups?.length) return undefined
  const entries: VarMapEntry[] = []
  for (const root of Object.keys(biMap)) {
    const vars = biMap[root]
    const varSet = new Set(vars)
    const updates: VarMapEntry['updates'] = []
    for (let i = 0; i < ups.length; i++) {
      if (varSet.has(ups[i].varIndex)) updates.push({ updater: i, dom: domLabel(ups[i], nodeNames) })
    }
    const kind: VarMapEntry['kind'] =
      root === ''
        ? undefined
        : comp.fields.get(root)?.kind ??
        (comp.ownGetters.has(root) ? 'getter' : comp.ownMethods.has(root) ? 'method' : 'unknown')
    entries.push({ root, kind, vars, updates })
  }
  return entries
}

/**
 * 默认的参与编译判定：`.ts` 且源码里出现 `extends CompElem` 或 `@tag`
 */
export function defaultInclude(id: string, code: string): boolean {
  const clean = id.split('?')[0]
  if (!/\.tsx?$/.test(clean)) return false
  if (clean.endsWith('.d.ts')) return false
  if (clean.includes('node_modules')) return false
  if (code.includes('extends CompElem') || /@tag\s*\(/.test(code)) return true
  return /@(prop|state|computed|query|queryAll)\b/.test(code)
}

/** 无 import 时插入 helper/carrier 的锚点：跳过 'use client' 等指令序言。 */
function firstCodeStart(program: any): number {
  const body = program?.body ?? []
  let i = 0
  while (i < body.length) {
    const s = body[i]
    const e = s?.expression
    if (
      s?.type === 'ExpressionStatement' &&
      e?.type === 'Literal' &&
      typeof e.value === 'string'
    ) {
      i++
      continue
    }
    break
  }
  return body[i]?.start ?? 0
}

/** 构建组件依赖清单（4 处 diagnostics.push 统一入口）。 */
function buildDeps(
  kind: DepSummary['kind'],
  ra: { viewDeps: string[] },
  cssDeps: string[] | undefined,
  computedDeps: Record<string, string[]> | undefined,
  subViewDeps: Record<number, string[]> | undefined,
  watchEntries: WatchEntry[] | undefined,
  meta?: UpdateMeta,
): DepSummary {
  const deps: DepSummary = { kind, viewDeps: ra.viewDeps }
  if (cssDeps !== undefined) deps.cssDeps = cssDeps
  if (computedDeps !== undefined) deps.computedDeps = computedDeps
  if (subViewDeps !== undefined && Object.keys(subViewDeps).length) deps.subViewDeps = subViewDeps
  if (watchEntries?.length) deps.watchers = watchEntries.map((w) => ({ name: w.name, sources: w.sources }))
  if (meta?.varMap) deps.varMap = meta.varMap
  if (meta?.subVarMap && Object.keys(meta.subVarMap).length) deps.subVarMap = meta.subVarMap
  return deps
}

/** 根类别 → 展示标签。 */
/** 模板方法内联预变换的快速门控：文件里没有 render( 就不必做预扫描 */
const hRenderRe = /\brender\s*\(/

// own 静态对象会遮蔽父类整个 __ce_static__；normal/noView 子类没有 own cssVars 时
// 必须显式别名父类 cssEffect，否则继承来的 CSS 变量永远不会被写。
const PARENT_CSS_EFFECT = 'Reflect.getPrototypeOf(this).__ce_static__?.cssEffect'

const KIND_LABEL: Record<string, string> = {
  prop: 'prop',
  state: 'state',
  computed: 'computed',
  getter: 'getter',
  method: 'method',
  unknown: '跨文件/未声明',
}

/** 一行一个根变量：`'x' (kind) vars[槽位] → up[下标] → DOM 点位`。 */
function formatVarLines(entries: VarMapEntry[], indent: string): string[] {
  return entries.map((e) => {
    const label = e.root === '' ? `'' (常脏)` : `'${e.root}' (${KIND_LABEL[e.kind ?? 'unknown'] ?? e.kind})`
    const vars = `vars[${e.vars.join(',')}]`
    const ups = e.updates.length
      ? `up[${e.updates.map((u) => u.updater).join(',')}] → ${e.updates.map((u) => u.dom).join(', ')}`
      : '—'
    return `${indent}${label} ${vars} → ${ups}`
  })
}

/** deps → 人类可读多行文本（单次 console.log，便于测试拦截）。 */
function formatDeps(id: string, d: CompileResult['diagnostics'][number]): string {
  const deps = d.deps!
  const tag = deps.kind === 'skipInjection' ? 'skipInjection（继承父类）' : deps.kind
  const head = `[compelem/compiler] ${id} :: ${d.className} 依赖清单 [${tag}]`
  const lines = [head]
  lines.push(`    viewDeps(${deps.viewDeps.length}): ${JSON.stringify(deps.viewDeps)}`)
  // 主视图更新映射：每变量 → 取值槽位 → 更新点下标 → DOM 点位
  if (deps.varMap) {
    lines.push('    updates:')
    lines.push(...formatVarLines(deps.varMap, '      '))
  } else if (deps.kind === 'normal') {
    lines.push('    updates: —')
  }
  lines.push(`    cssDeps: ${deps.cssDeps !== undefined ? JSON.stringify(deps.cssDeps) : '—'}`)
  lines.push(`    computedDeps: ${deps.computedDeps !== undefined ? JSON.stringify(deps.computedDeps) : '—'}`)
  if (deps.subViewDeps) lines.push(`    subViewDeps: ${JSON.stringify(deps.subViewDeps)}`)
  if (deps.subVarMap) {
    for (const subId of Object.keys(deps.subVarMap)) {
      lines.push(`    sub#${subId} updates:`)
      lines.push(...formatVarLines(deps.subVarMap[Number(subId)], '      '))
    }
  }
  if (deps.watchers) lines.push(`    watchers: ${JSON.stringify(deps.watchers)}`)
  return lines.join('\n')
}

/** 编译单个文件。解析失败时原样返回；静态分析/模板 codegen 失败会抛 StaticAnalysisError。 */
export function compileFile(code: string, id: string, options: CompilerOptions = {}): CompileResult {
  const include = options.include ?? defaultInclude
  if (!include(id, code)) return { code, map: null, diagnostics: [], changed: false }

  // verbose 依赖展示开关（显式 options.verbose 或环境变量 CE_DEPS_DEBUG）：
  // 开启时才做 per-var 根名分类（DepSummary 映射），关闭时省去该开销
  const envDebug = typeof process !== 'undefined' ? process.env?.CE_DEPS_DEBUG : undefined
  const depsDisplay = options.verbose === true || (envDebug !== undefined && envDebug !== '' && envDebug !== '0')

  let parsed
  try {
    parsed = parse(code, id)
  } catch {
    return { code, map: null, diagnostics: [], changed: false }
  }

  // 模板方法内联预变换：`r => this.renderRow(r)` / `ifTrue(c, this.header())` 
  const originalCode = code
  let inlineEdits: InlineEdit[] = []
  if (hRenderRe.test(code)) {
    try {
      const inlined = inlineTemplateMethodsWithEdits(code, parsed)
      if (inlined.code !== code) {
        inlineEdits = inlined.edits
        code = inlined.code
        parsed = parse(code, id)
      }
    } catch {
      /* 预变换失败不阻断：交由主管线对原始源码给出原有诊断 */
    }
  }

  const comps = analyzeFile(code, id, parsed)
  // 外部指令注册表：options.knownDirectives 注入到每个组件分析对象，
  // 供 template-extract / template-subs 把「模块绑定指令调用」分类为指令点
  const fileDirectives = options.knownDirectives ? new Set<string>(options.knownDirectives) : undefined
  if (fileDirectives) for (const c of comps) c.knownDirectives = fileDirectives
  if (!comps.length) return { code, map: null, diagnostics: [], changed: false }

  const edits: Array<{
    comp: ComponentAnalysis
    literal: string
    removals?: Array<{ start: number; end: number }>
    /** prop/state 初始值 → 构造体写入（字段已整体删除） */
    fieldInits?: Array<{ name: string; initText: string; computed?: boolean }>
    /** 构造体插入点计划（无初始值时缺省） */
    ctor?: CtorInsertPlan
    /** 方法装饰器（@debounced/@throttled/@onced）构造体注入语句 */
    methodDecoCtor?: string
    /** 方法装饰器 destroy 注入语句 */
    methodDecoDestroy?: string
    /** 本组件访问器所需的运行时函数（已定名）——文件级 import 注入取并集 */
    helpers?: string[]
    /** 本组件方法装饰器所需的 myfx 函数（debounce/throttle/once）——走 myfx 通道注入 */
    myfxHelpers?: string[]
  }> = []
  // per-point 写入器：emit 成 compelem 的模块级自由函数（`render/write.ts`），而不是
  // `rc._wText(...)` 实例方法 —— 作者的组件类型面上不留任何内部 writer。
  // 收集文件内实际用到的名字，随 compelem helper 通道做文件级 import 注入。
  const writers = new Set<string>()
  const diagnostics: CompileResult['diagnostics'] = []
  // render 体清空候选（静态准入组件的 render 是死代码 —— 静态路径下无任何运行时消费）。
  const renderStrips: Array<{ edit: (typeof edits)[number]; start: number; end: number }> = []

  // 标签注册表：同文件 @tag + options.knownTags（跨文件由 vite 插件累积注入，见 TEMPLATE-CODEGEN.md §4）
  const fileTags = new Set<string>()
  for (const c of comps) if (c.tagName) fileTags.add(c.tagName.toLowerCase())
  if (options.knownTags) for (const t of options.knownTags) fileTags.add(t.toLowerCase())

  // 约定检查上下文（emit 校验 / @prop / @computed / @csscope 目标检查）
  const convCtx = {
    localClasses: collectLocalClasses(parsed),
    stringConsts: collectStringConsts(parsed.program),
    moduleConsts: collectModuleConsts(parsed.program),
    moduleFunctions: collectModuleFunctions(parsed.program),
    importedLocals: new Set(parsed.imports.keys()),
    code,
  }

  // 运行时函数（RUNTIME_HELPERS）的模块定名：默认原名，与模块既有绑定冲突时
  // 改用 __ce_ 前缀别名（文件级统一，访问器与 import 注入共用）
  const moduleBindings = collectModuleBindings(parsed)
  const helperBindings: Record<string, string> = {}
  // compelem 的访问器 helper 与方法装饰器注入的 myfx helper 共用同一套
  // “模块绑定冲突 → __ce_ 别名”机制。别名必须同时记录原始导出名，
  // 注入 import 时生成 `signal as __ce_signal`，否则会 import 一个不存在的名字。
  for (const canon of [...RUNTIME_HELPERS, ...MYFX_HELPERS]) {
    if (!moduleBindings.has(canon)) continue
    let alias = '__ce_' + canon
    let n = 1
    while (moduleBindings.has(alias)) alias = `__ce${n++}_${canon}`
    helperBindings[canon] = alias
  }

  // 文件级累加器：类名 → 该类实际生成的访问器行。供 extractFieldAccessors 剔除
  // 「同文件祖先已提供、且逐字节相同」的行（子类重新声明同名 prop/state/computed
  // 只为覆盖默认值时，访问器与祖先完全相同）。同文件内 super 必须先于子类声明
  // （否则运行时 TDZ），故单趟前向即可；祖先若因族级 all-or-nothing 失败则没有条目，
  // 此时不剔除 —— 最坏只是多留一行死代码。
  // 必须建在**组件循环之外**：每个组件一份 Map 等于完全不共享。
  const inheritedAccessors = new Map<string, string[]>()
  /**
   * 文件级 carrier 常量声明（模块级 `const __ce_tN = Object.assign(function(){}, {__subId: N})`）。
   * 子视图回调体是死代码（运行时只读 __subId/__fx/__bv，DOM 来自 subs[N].buildTemplate），
   * 而原包装写在 fx 工厂体内 —— 每次更新都要重跑一次 Object.assign + 新建闭包。
   * 自洽子模板（无 extras）的 carrier 提到模块级，更新路径变为单次绑定读取。
   */
  const carrierDecls: string[] = []
  let carrierSeq = 0

  for (const comp of comps) {
    // 约定检查独立于静态分析闸门与模板 codegen，三者都执行、不短路。
    // 错误经 `compileResult.diagnostics` 的 `conventionErrors` 出口，由 vite 插件按
    // `conventions` 力度上报。
    let conventionErrors = checkConventions(comp, convCtx)

    // @watch 编译期解析（watch 前移）：解析成功 → 删装饰器 + 注入 watchers；
    // 有 E-WATCH-ARG → 整体放弃（不删不注），运行时装饰器路径兜底。
    // watch 前移产物与模板加速字段不同：与视图无关，必须注入。
    const watchRes = extractWatchers(comp, code, convCtx)
    conventionErrors.push(...watchRes.errors)
    let watchEffectsCode: string | undefined
    let watchRemovals: Array<{ start: number; end: number }> = []
    if (!watchRes.errors.length && watchRes.entries.length) {
      watchRemovals = watchRes.removals
      watchEffectsCode = generateWatchEffects(watchRes.entries)
      // watch 回调 emit 成 `untrack(() => this.m(...))`（作者方法体对 codegen 是
      // 黑盒，只能在调用点整体关闭依赖收集，否则方法体里的读会被误收成本 watch 的
      // 依赖）。`untrack` 是 compelem 的模块级函数 —— 走同一条 compelem 注入通道。
      if (watchEffectsCode.includes('untrack(')) writers.add('untrack')
    }

    // 五族访问器前移（@prop/@state/@computed/@query/@queryAll）：逐族 all-or-nothing，
    // 与 @watch 同构（装饰器删除 + 访问器/元数据注入）。任一成员不可静态解析 →
    // E-XXX-ARG / E-DECO-COEXIST 报错（error 级阻断；@prop 运行时已无定义路径）。
    // skipInjection 类照常参与——其注入字面量在下方以
    // `...父类.__ce_static__` spread 继承视图字段 + own 家族覆盖。
    const fieldRes = extractFieldAccessors(comp, code, convCtx, helperBindings, inheritedAccessors)
    conventionErrors.push(...fieldRes.errors)

    // 方法装饰器前移（@debounced/@throttled/@onced）：直接生成构造体直线注入语句
    // （`this.onScroll = throttle(this.onScroll, 100)` 形态），**不引入计划表**。
    // 与五族同规格：逐族 all-or-nothing，失败即 E 码阻断。装饰器只删前缀、方法体保留。
    const mdRes = extractMethodDecos(comp, code, convCtx)
    conventionErrors.push(...mdRes.errors)
    const mdHelpers = mdRes.runtimeHelpers.map((n) => helperBindings[n] ?? n)

    const allRemovals: Array<{ start: number; end: number }> = [
      ...watchRemovals,
      ...fieldRes.removals,
      ...mdRes.removals,
    ]
    const fieldCodes = {
      props: fieldRes.propsCode,
      states: fieldRes.statesCode,
      computedGetters: fieldRes.computedCode,
      accessors: fieldRes.accessors || undefined,
    }
    // prop/state 初始值构造写入 + 访问器所需运行时函数（并集供文件级 import 注入）
    const needCtor = fieldRes.fieldInits.length > 0 || !!mdRes.ctorStmts
    const ctorPlan = needCtor
      ? planCtorInsert(comp, comp.cls ?? convCtx.localClasses.get(comp.className), code)
      : undefined
    // super 在分支/嵌套结构内 → 初始值写入退到构造体末尾，走 W 通道提示时序取舍
    if (ctorPlan?.warn) {
      conventionErrors.push({ start: comp.start, end: comp.end, message: ctorPlan.warn, severity: 'warn' })
    }
    const fieldHelpers = fieldRes.runtimeHelpers.map((n) => helperBindings[n] ?? n)
    const fieldExtras = {
      fieldInits: fieldRes.fieldInits.length ? fieldRes.fieldInits : undefined,
      ctor: ctorPlan ?? undefined,
      // 方法装饰器需要构造体插入点（无 fieldInits 时也可能需要）——单独算一份
      methodDecoCtor: mdRes.ctorStmts || undefined,
      methodDecoDestroy: mdRes.destroyStmts || undefined,
      // 五族访问器要的是 **compelem** 的运行时函数；per-point 写入器（`wText`/`wAttr`…）
      // 同样是 compelem 的模块级自由函数 —— 走同一通道，文件级取并集。
      //
      // ⚠️ 用 **getter** 而非快照：`writers` 要到后面的模板 codegen 才被填上
      // （generateRenderEffect / generateSubInlinedEffect 跑完才有名字），而本对象
      // 在 noView / skipInjection 分支是**提前** spread 走的。取快照会永远拿到空集
      // → 产物 emit 了 `wText(...)` 却没有 import → 运行期 ReferenceError。
      // getter 在 `...fieldExtras` 展开（即 edits.push）时才求值，那时 codegen 已完成。
      get helpers() {
        const all = [...fieldHelpers, ...writers]
        return all.length ? [...new Set(all)] : undefined
      },
      // 方法装饰器前移要的是 **myfx** 的 debounce/throttle/once —— 走 myfx 通道，
      // 不塞进 compelem 的 import（compelem 不为它们开出口）。
      myfxHelpers: mdHelpers.length ? [...mdHelpers] : undefined,
    }

    // U5：单 walk——analyzeRender 顺带收集主模板 h`` 节点（免 extractMainTemplate 重扫）
    const mainHits: any[] = []
    const ra = analyzeRender(comp, { mainHits })
    // 闸门：命中即抛 StaticAnalysisError（不合规就报错，无产物可接）
    assertStaticAnalysis(comp, ra)

    // ---- cssDeps / computedDeps 静态提取（候选4/候选3，无视图也尝试）----
    const cssDeps = extractCssDeps(comp, convCtx.localClasses)
    // computedDeps 只进 verbose 依赖清单；默认不算（避免每个 getter 一次 alias fixpoint）。
    const computedDeps = depsDisplay ? extractComputedDeps(comp, convCtx.localClasses) : undefined
    let cssEffectCode: string | undefined
    // 空依赖也要生成 effect：cssVars 可能只返回常量，首轮仍需 wCssVars 落盘。
    if (cssDeps !== undefined && comp.cssVarsBody && comp.cssVarsBody.length) {
      /**
       * `__s` **只按信号根键存放**（`CompElem.ts` `#slotsSig()` / 各 `__s[key]` 访问），
       * 故这里必须做两件事：
       *
       * 1. **只取根**。`deps-extract.record` 会同时记下完整链与根
       *    （`this.list.length` → `'list.length'` + `'list'`），完整链只供 verbose
       *    依赖清单展示。把完整链当 `__s` 下标会得到 `rc.__s.list.length.value` ——
       *    `SignalNode` 只有 `value`/`peek`（`signal.ts:8-12`），`.length` 是 undefined，
       *    再取 `.value` **首轮即 TypeError**。
       * 2. **可选链**。`@query`/`@queryAll` 字段不是信号，不落在 `__s` 上
       *    （`deps-extract.ts` ② 级把它们记为「死条目」），直取同样 TypeError。
       *    `?.` 使其退化为 `undefined`：`Object.is(undefined, undefined)` 为真 ⇒
       *    永不触发，符合「非响应式本就无依赖可订阅」的语义。
       */
      const roots = [...new Set(cssDeps.map((d) => d.split('.')[0]))]
      const signalReads = roots.map((r) => `rc.__s.${r}?.value`).join(', ')
      // cssDeps 是已知信号根的扁平数组：逐元素 Object.is 比较，免去每次触发
      // 两侧各一次 JSON.stringify（序列化整个依赖数组）
      // `wCssVars` 是 compelem 的模块级自由函数（首参 rc）：作者可见的 CompElem
      // 类型面上不留这批「产物专用」成员。
      writers.add('wCssVars')
      cssEffectCode = `(rc) => { let ov; return () => { const nv = [${signalReads}]; let changed = ov === undefined; if (!changed) { for (let i = 0; i < nv.length; i++) { if (!Object.is(nv[i], ov[i])) { changed = true; break } } } if (changed) { wCssVars(rc); ov = nv } } }`
    } else if (cssDeps === undefined && comp.cssVarsBody && comp.cssVarsBody.length) {
      /**
       * ⚠️ **依赖提取失败 ⇒ 「全根兜底」，而不是「什么都不生成」。**

       */
      writers.add('wCssVars')
      cssEffectCode =
        `(rc) => { let ov, ks; return () => { const s = rc.__s; if (!ks) ks = Object.keys(s); const nv = []; ` +
        `for (let i = 0; i < ks.length; i++) { const c = s[ks[i]]; if (c) nv.push(c.value) } ` +
        `let changed = ov === undefined || nv.length !== ov.length; ` +
        `if (!changed) { for (let i = 0; i < nv.length; i++) { if (!Object.is(nv[i], ov[i])) { changed = true; break } } } ` +
        `if (changed) { wCssVars(rc); ov = nv } } }`
    }
    // subViewDeps：ra.subViewDeps 的 key 是回调 start 偏移，需映射为 subId
    // （collectSubCandidates 在 codegen 分支内执行；有主模板时才有 subId）
    // 仅用于 debug 依赖清单输出（不注入 __ce_static__）
    let subViewDepsRec: Record<number, string[]> | undefined

    // ---- 无视图组件（noView）：无 render / render 返回 null / 继承链终点 CompElem ----
    if (comp.noView) {
      edits.push({
        comp,
        literal: buildStaticLiteral({ noView: true }, {
          ...fieldCodes,
          cssEffect: cssEffectCode ?? PARENT_CSS_EFFECT,
          watchEffects: watchEffectsCode,
          inlinedWatchAncestors: watchRes.inlinedAncestors,
        }),
        removals: allRemovals,
        ...fieldExtras,
      })
      diagnostics.push({
        className: comp.className,
        viewDeps: 0,
        conventionErrors,
        deps: buildDeps('noView', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries),
      })
      continue
    }

    // ---- 跳过注入（同文件继承链上有 render 的祖先，继承其 __ce_static__）----
    if (comp.skipInjection) {
      // 五族前移照常参与（必须注入访问器/元数据），watchEffects 同前。
      // 视图字段整体 spread 继承祖先（buildTemplate/subs/…——本类无 render，
      // 视图即祖先的视图）。视图字段是**整体继承**语义（own 一律覆盖，不参与合并）；
      // 家族字段则相反 —— 必须逐张表浅替换叠加，见 inject.ts emitFamily。
      const hasOwnField =
        !!fieldRes.accessors ||
        fieldRes.propsCode !== undefined ||
        fieldRes.statesCode !== undefined ||
        fieldRes.computedCode !== undefined ||
        // 只有 cssVars 覆写、没有其他家族成员的中间类也必须注入自己的 cssEffect
        !!cssEffectCode
      if (hasOwnField || watchEffectsCode) {
        // super 表达式改由 emitFamily 内部的 `Reflect.getPrototypeOf(this)` 解析：
        // 原先 `code.slice(superNode.start, superNode.end)` 重放 extends 子句源码，
        // 遇到 `extends Mixin(CompElem)` 会**二次调用 mixin 工厂**取到另一个类。
        const mk = (label: string, body: string) => `${DEBUG_DIV} ${label}\n${body}`
        const parts = [
          mk('inherits', `...Reflect.getPrototypeOf(this).__ce_static__`),
          mk('props', `props: ${emitFamily('props', fieldRes.propsCode)}`),
          mk('states', `states: ${emitFamily('states', fieldRes.statesCode)}`),
          mk('computedGetters', `computedGetters: ${emitFamily('computedGetters', fieldRes.computedCode)}`),
        ]
        // watchEffects 必须注入：@watch 装饰器已随 watchRemovals 被删，不注入即彻底丢失。
        // 语义是**拼接**不是覆盖 —— own 数组把父类那份接在前面（ancestors-first），
        // 否则本类自带 @watch 时会把祖先的执行序列整段盖掉（`emitWatchEffects`）。
        if (watchEffectsCode) {
          parts.push(mk('watchEffects', `watchEffects: ${emitWatchEffects(watchEffectsCode, watchRes.inlinedAncestors)}`))
        }
        if (cssEffectCode) parts.push(mk('cssEffect', `cssEffect: ${cssEffectCode}`))
        // 本分支（继承链上有 render 祖先 ⇒ skipInjection）与 `codegen/inject.ts` 同为
        // 注入路径，产物里同样只留运行时需要的东西。
        edits.push({
          comp,
          literal:
            `static __ce_static__ = {\n${parts.join(',\n')}\n};\n` + (fieldRes.accessors || ''),
          removals: allRemovals,
          ...fieldExtras,
        })
      }
      diagnostics.push({
        className: comp.className,
        viewDeps: ra.viewDeps.length,
        conventionErrors,
        deps: buildDeps('skipInjection', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries),
      })
      continue
    }

    // ---- 模板诊断（约定错误 E-*）无条件执行 ----
    let buildTemplateCode: string | undefined
    let subsCode: string | undefined
    let pointEffectsCode: string | undefined
    let fxCode: string | undefined
    let tmplErrors: string[] = []
    let mainTmpl: ReturnType<typeof extractMainTemplate> = null
    // 依赖清单更新映射素材：主模板 ups/节点名 + 每根/子模板的 vars→updater→DOM 映射
    let mainUps: UpOut[] | undefined
    let mainNodeNames: string[] | undefined
    let updateMeta: UpdateMeta = {}
    try {
      mainTmpl = extractMainTemplate(comp, code, mainHits)
      if (mainTmpl) {
        const tree = parseTemplateTree(
          buildTemplateHTML(mainTmpl.strings),
          mainTmpl.vars.length,
        )
        // 折叠只对文本位生效；属性名/属性值里的 html(CONST) 必须保留指令语义。
        clearAttrFragments(tree.root, mainTmpl.vars)
        // 模板层约定规则（.prop 须插值 / 事件须函数 / ref 须 createRef / 指令位置 / .prop 目标）
        conventionErrors.push(...checkTemplateRules(tree, mainTmpl, comp, convCtx, fileTags))

        // codegen：恒执行（走到这里说明 assertStaticAnalysis 已通过）
        {
          const gen = generateBuildTemplate(tree.root, mainTmpl.vars, {
            className: comp.className,
            knownTags: fileTags,
          })
          if (gen.errors.length) tmplErrors = gen.errors
          else buildTemplateCode = gen.code ?? undefined
          if (!gen.errors.length) {
            mainUps = gen.ups
            mainNodeNames = gen.nodeNames
          }
          // 静态取值函数：与 buildTemplate 的 varIndex 空间对齐。
          // 任一插值无法安全静态化（render() 局部标识符 / this 改写失败）→ buildTemplate
          // 一并放弃。
          if (buildTemplateCode) {
            // 先收集子模板候选（失败→整组件报错），再生成主取值函数（带 wraps）
            let subCandidates: ReturnType<typeof collectSubCandidates> = []
            let c1SubBvMap: Map<number, ReturnType<typeof generateSubBuildVars>> | undefined
            let c1Extras: Map<number, string> | undefined
            let c1Carriers: Map<number, string> | undefined
            let c1BvOpts: BuildVarsOptions | undefined
            // U2：本文件内自由标识符校验缓存（comp 恒定，C1 多阶段复用同一 fnRaw 结果）
            const freeCache: Map<string, Set<string> | null> = new Map()
            try {
              subCandidates = collectSubCandidates(comp, code)
              // 每个候选只解析一次树：既用于清理属性位的 fragment 标记（必须早于
              // generateSubBuildVars），也供后续 buildTemplate codegen 复用。
              for (const cand of subCandidates) {
                cand.tree = parseTemplateTree(
                  buildTemplateHTML(cand.strings),
                  cand.vars.length,
                )
                clearAttrFragments(cand.tree.root, cand.vars)
                // 子模板里的指令实参（forEach keyFn / model 写回路径）同样要校验：
                // 这些规则只看表达式本身，不依赖插入位置映射，可直接按 vars 走。
                conventionErrors.push(...checkDirectiveArgs(cand.vars, convCtx))
              }
            } catch (e) {
              tmplErrors = [
                e instanceof SubExtractError || e instanceof TemplateExtractError
                  || e instanceof TemplateParseError
                  ? e.message
                  : String(e),
              ]
            }
            if (!tmplErrors.length && buildTemplateCode) {
              // 两阶段：先试全部子模板取值函数；失败且 free ⊆ 祖先形参 → 生成 __bv 闭包 extras
              const subBvMap = new Map<number, ReturnType<typeof generateSubBuildVars>>()
              const extras = new Map<number, string>()
              /** subId → 模块级 carrier 常量名（自洽子模板；填充见 liftPlan 定稿后） */
              const carriers = new Map<number, string>()
              const liftPlan: Array<{
                cand: (typeof subCandidates)[number]
                allowed: Set<string>
                r: ReturnType<typeof generateSubBuildVars>
              }> = []
              if (subCandidates.length) {
                for (const cand of subCandidates) {
                  subBvMap.set(cand.subId, generateSubBuildVars(cand, code, comp, subCandidates, { freeCache, depsDisplay }))
                }
                /**
                 * 候选「需要祖先作用域的标识符」= 自身 freeIds ∪ **所有后代候选**的 needIds。
                 */
                const needCache = new Map<number, Set<string>>()
                /**
                 * `needIds(cand)` = **cand 的工厂被发出去之后，它的工厂体（含所有被内联进来的
                 * 后代 `__fx`）还需要从「cand 工厂之外」拿到哪些标识符**
                 */
                /** cand 的**直接子候选**：被 cand 严格内含、且不被 cand 的其它后代再内含 */
                const directChildrenOf = (cand: (typeof subCandidates)[number]) => {
                  const kids = subCandidates.filter((o) => {
                    if (o === cand) return false
                    if (typeof o.start !== 'number' || typeof o.end !== 'number') return false
                    return o.start > cand.start && o.end <= cand.end
                  })
                  return kids.filter((o) => !kids.some((m) => m !== o
                    && typeof m.start === 'number' && typeof m.end === 'number'
                    && m.start > cand.start && m.end <= cand.end
                    && o.start >= m.start && o.end <= m.end && (o.start > m.start || m.end > o.end)))
                }
                const needIdsOf = (cand: (typeof subCandidates)[number]): Set<string> => {
                  const hit = needCache.get(cand.subId)
                  if (hit) return hit
                  needCache.set(cand.subId, new Set()) // 防环占位
                  const out = new Set<string>(subBvMap.get(cand.subId)?.freeIds ?? [])
                  for (const o of directChildrenOf(cand)) {
                    for (const id of needIdsOf(o)) out.add(id)
                  }
                  for (const p of paramBaseNames(cand.params)) out.delete(p)
                  needCache.set(cand.subId, out)
                  return out
                }
                for (const cand of subCandidates) {
                  const r = subBvMap.get(cand.subId)!
                  const need = needIdsOf(cand)
                  const ancestors = enclosingCandidates(cand, subCandidates)
                  const allowed = new Set<string>()
                  for (const a of ancestors) {
                    for (const n of paramBaseNames(a.params)) allowed.add(n)
                    // 祖先 prelude 声明的局部 const 同样在祖先工厂体作用域内：
                    // 提升后的 __fx 工厂词法嵌在祖先 pe/fx 体里，祖先 prelude 会按
                    // usesPrelude 文本判定注入工厂体开头 ⇒ 闭包捕获安全。
                    // 这是 inline-template-methods「prelude 注入」设计的前提——
                    // 调用形态的实参绑定就是祖先 prelude const（2026-10-14）。
                    if (a.preludeSrc) collectPreludeDeclNames(a.preludeSrc, allowed)
                  }
                  if (!need.size) continue
                  if (![...need].every((id) => allowed.has(id))) continue
                  liftPlan.push({ cand, allowed, r })
                }
                // 深优先（start 降序）：先处理内层，其 __fx 才能被外层内联时带上
                liftPlan.sort((a, b) => b.cand.start - a.cand.start)

                // carrier 常量（自洽子模板）：模块级一次创建，更新路径零分配。
                // 必须在 liftPlan 定稿**之后**填 —— liftPlan 里的候选会拿到
                // `__fx`（闭包捕获祖先形参，必须逐次新建载体），不能共享常量；
                // 提升失败时它既无 extras 也无 carrier，回落原回调源码形态。
                const liftedIds = new Set(liftPlan.map((x) => x.cand.subId))
                for (const cand of subCandidates) {
                  if (liftedIds.has(cand.subId)) continue
                  const name = `__ce_t${carrierSeq++}`
                  carriers.set(cand.subId, name)
                  carrierDecls.push(
                    `const ${name} = Object.assign(function(){}, {__subId: ${cand.subId}});`,
                  )
                }

                for (const { cand, allowed, r } of liftPlan) {
                  const lifted = generateSubBuildVars(cand, code, comp, subCandidates, {
                    extraAllowed: allowed,
                    extras,
                    freeCache,
                    depsDisplay,
                  })
                  if (lifted.code) {
                    // 跨层子模板也内联 —— 生成内联 fx + 合并 pointEffects，
                    // 作为 __fx 挂在**本子回调对象字面量**上（该字面量在祖先回调体内创建，
                    // 祖先 effect 每轮重跑 ⇒ 闭包捕获的祖先形参天然新鲜，无需 __bv 快照）。
                    // 自由标识符校验仍由上面的 generateSubBuildVars(extraAllowed) 负责。
                    let liftGen: ReturnType<typeof generateBuildTemplate> | undefined
                    try {
                      liftGen = generateBuildTemplate(cand.tree!.root, cand.vars, {
                        className: comp.className,
                        knownTags: fileTags,
                      })
                    } catch {
                      liftGen = undefined
                    }
                    if (liftGen && !liftGen.errors.length) {
                      const inliner = buildSubInliner(cand, code, subCandidates, extras, carriers)
                      const subParams = cand.params.length ? `, ${cand.params.join(', ')}` : ''
                      // 子模板 prelude（回调体的前置语句）里声明的局部变量名 —— 供
                      // `generateSubInlinedEffect` 判断 fx 工厂是否需要注入 prelude。
                      // 不传 → 只要 prelude 引用了，fx 就会 ReferenceError（见该函数注释）。
                      const liftPreludeNames = new Set<string>()
                      if (cand.preludeSrc) collectPreludeDeclNames(cand.preludeSrc, liftPreludeNames)
                      const subRe = generateSubInlinedEffect(
                        liftGen.ups ?? [],
                        inliner.val,
                        inliner.prelude ?? '',
                        subParams,
                        liftPreludeNames,
                      )
                      if (!subRe.usedGet && inliner.prelude != null) {
                        for (const w of subRe.writers) writers.add(w)
                        extras.set(cand.subId, `, __fx: { fx: ${subRe.fxExpr}, pe: ${subRe.arrayExpr} }`)
                        r.code = null
                        r.errors = []
                        r.freeIds = undefined
                        r.lifted = true
                        r.viewDepVarIndices = lifted.viewDepVarIndices
                      }
                    }
                  }
                }
                // extras 就绪后重生成未提升且可能包住提升子节点的父级取值函数
                if (extras.size) {
                  for (const cand of subCandidates) {
                    const r = subBvMap.get(cand.subId)!
                    if (!r.code) continue
                    const regen = generateSubBuildVars(cand, code, comp, subCandidates, { extras, freeCache, depsDisplay })
                    if (regen.code) {
                      r.code = regen.code
                      r.errors = []
                      r.viewDepVarIndices = regen.viewDepVarIndices
                    }
                  }
                }
              }

              // `__bv` 闭包提升（C1）在 extras 上追加条目 ⇒ 该候选载体必须逐次新建。
              // liftPlan 之外、到这里才被加 `__bv` 的候选要把已有 carrier 常量撤掉。
              for (const subId of extras.keys()) carriers.delete(subId)
              const bvOpts: BuildVarsOptions = { extras, freeCache, depsDisplay, carriers }
              const bv = generateBuildVars(mainTmpl, comp, code, subCandidates, bvOpts)
              if (bv.code) {
                // `bv.code` 本身不注入产物：主模板的每个点都已把表达式内联进
                // fx / pointEffects 工厂。保留本函数调用是因为它还提供两样东西：
                //   1 `bv.errors` —— 门禁（自由标识符 / TS 语法 ⇒ 不可编译）
                //   2 `bv.viewDepVarIndices` —— verbose 依赖清单的根名→var 映射
                if (mainUps?.length) {
                  // varIndex → 该 var 自己的表达式：保留 `this.metrics.length` 这类成员访问，
                  // 否则 effect 只会读 `rc.__s.metrics.value`（整个数组），
                  // 文本点就会渲染成 [object Object],[object Object],…
                  const upsVars = varsByUpIndex(mainTmpl.vars)
                  // 自守卫：每个非片段 var 恰好产生一个 up（serializeUp 的同一不变量）。
                  // 一旦被打破，宁可构建期硬报错，也不静默解错表达式。
                  if (upsVars.length !== mainUps.length) {
                    tmplErrors = [
                      `插值槽与更新点数量不一致（插值 ${upsVars.length} / 更新点 ${mainUps.length}）：` +
                      `varIndex 空间错位，拒绝生成取值表达式`,
                    ]
                  }
                  const varIndexToExpr = new Map<number, string>()
                  for (let vi = 0; vi < upsVars.length; vi++) varIndexToExpr.set(vi, upsVars[vi].exprSource)
                  // `__s` 的真实键集 = 本组件（含继承链）已建信号的字段 + 框架自带 slots。
                  // 只有这些键才允许内联成 `rc.__s.<k>.value`，见 signalExprFor 的说明。
                  const signalKeys = new Set<string>(comp.fields.keys())
                  signalKeys.add('slots')
                  // 内联上下文：让 effect / fx 工厂直接内联表达式（含 __subId wraps）。
                  // - ranges：varIndex → 源码绝对区间，applySubIdWraps 靠偏移切片
                  const varIndexToRange = new Map<number, [number, number]>()
                  for (let vi = 0; vi < upsVars.length; vi++) {
                    const v = upsVars[vi]
                    if (typeof v.start === 'number' && typeof v.end === 'number') {
                      varIndexToRange.set(vi, [v.start, v.end])
                    }
                  }
                  // 主模板 prelude：stripTs → TS 复检 → rewriteThis('rc')。
                  // 引用 prelude 局部变量的插值会由 generateRenderEffect 在对应工厂内注入
                  // prelude（每轮 effect 重算，读 rc.route getter 即订阅信号）；未引用的
                  // 工厂零开销。门禁（TS 语法 / 未知自由标识符）仍由 generateBuildVars 把关。
                  let fxPrelude = ''
                  const preludeNames = new Set<string>()
                  if (mainTmpl.preludeSrc) {
                    const pc = stripTsChecked(mainTmpl.preludeSrc)
                    if (pc.tsHit) {
                      tmplErrors = ['render() prelude 含 TS 专有语法（as/satisfies/非空断言），放弃注入']
                    } else {
                      const pl = rewriteThis(pc.stripped, 'rc') ?? ''
                      fxPrelude = pl
                      collectPreludeDeclNames(mainTmpl.preludeSrc, preludeNames)
                    }
                  }
                  const re = !tmplErrors.length
                    ? generateRenderEffect(mainUps, varIndexToExpr, signalKeys, {
                      source: code,
                      candidates: subCandidates,
                      extras,
                      carriers,
                      ranges: varIndexToRange,
                      prelude: fxPrelude,
                      preludeNames,
                    })
                    : undefined
                  if (re) {
                    for (const w of re.writers) writers.add(w)
                    pointEffectsCode = re.arrayExpr
                    fxCode = re.fxExpr
                    // 主模板产物**不允许**出现 get(varIndex) 回退 —— 每个更新点都必须把
                    // 表达式内联进 fx / pointEffects 工厂：出现回退即说明表达式含无法静态化
                    // 语法（render() 局部标识符 / TS 专有残留），应在构建期硬报错，让作者
                    // 修模板或改写法。
                    if (re.usedGet) {
                      tmplErrors = [
                        '主模板存在无法内联进 effect 工厂的插值表达式（出现 get(varIndex) 回退）：' +
                        '静态路径要求所有更新点内联取值，请检查该表达式是否引用了 render() 局部标识符或 TS 专有语法。',
                      ]
                    }
                  }

                }
                const vm = depsDisplay ? makeVarMap(comp, bv.viewDepVarIndices, mainUps, mainNodeNames) : undefined
                if (vm) updateMeta.varMap = vm
              } else {
                buildTemplateCode = undefined
                tmplErrors = bv.errors
              }
              c1SubBvMap = subBvMap
              c1Extras = extras
              c1Carriers = carriers
              c1BvOpts = bvOpts
            } else if (tmplErrors.length) {
              buildTemplateCode = undefined
            }
            // 子模板 codegen：任一失败 → tmplErrors 非空 → 下方整组件报错阻断
            if (!tmplErrors.length && buildTemplateCode && subCandidates.length) {
              const entries: string[] = []
              for (const cand of subCandidates) {
                try {
                  const subGen = generateBuildTemplate(cand.tree!.root, cand.vars, {
                    className: comp.className,
                    knownTags: fileTags,
                  })
                  if (subGen.errors.length) {
                    tmplErrors = subGen.errors.map((m) => `sub#${cand.subId}: ${m}`)
                    break
                  }
                  const subBv =
                    c1SubBvMap?.get(cand.subId) ??
                    generateSubBuildVars(cand, code, comp, subCandidates, c1BvOpts)

                  const subVm = depsDisplay ? makeVarMap(comp, subBv.viewDepVarIndices, subGen.ups, subGen.nodeNames) : undefined
                  if (subVm) {
                    if (!updateMeta.subVarMap) updateMeta.subVarMap = {}
                    updateMeta.subVarMap[cand.subId] = subVm
                  }
                  if (subBv.code) {
                    // **自洽子模板** → 内联 fx。
                    // 表达式只引用自身形参 + this + 模块名，顶层工厂可直接内联取值，
                    // 运行时无需 get 回退。跨层子模板（引用祖先形参，如 `row[c]`）
                    // 走下面的已提升分支（回调实例上的 __fx）。
                    const inliner = buildSubInliner(cand, code, subCandidates, c1Extras, c1Carriers)
                    const subParams = cand.params.length ? `, ${cand.params.join(', ')}` : ''
                    // 同上：把 prelude 声明的局部变量名交给 fx 注入判定
                    const subPreludeNames = new Set<string>()
                    if (cand.preludeSrc) collectPreludeDeclNames(cand.preludeSrc, subPreludeNames)
                    const subRe = generateSubInlinedEffect(
                      subGen.ups ?? [],
                      inliner.val,
                      inliner.prelude ?? '',
                      subParams,
                      subPreludeNames,
                    )
                    if (subRe.usedGet || inliner.prelude == null) {
                      tmplErrors = [
                        `sub#${cand.subId}: 子模板存在无法内联进 effect 工厂的插值表达式（get(varIndex) 回退）`,
                      ]
                      break
                    }
                    for (const w of subRe.writers) writers.add(w)
                    entries.push(
                      `${cand.subId}: { buildTemplate: ${subGen.code}, pointEffects: ${subRe.arrayExpr}, fx: ${subRe.fxExpr} }`,
                    )
                  } else if (subBv.lifted || (typeof c1Extras !== 'undefined' && c1Extras.has(cand.subId))) {
                    // 跨层子模板已内联为回调实例上的 __fx（fx + 合并 pointEffects），
                    // subs 只留 buildTemplate 作 DOM 克隆源；取值/effect 全部由 __fx 提供。
                    entries.push(`${cand.subId}: { buildTemplate: ${subGen.code} }`)
                  } else {
                    // 取值表达式无法内联进 effect 工厂（自由标识符既不在自身形参、
                    // 也不在任何祖先回调形参里）→ **构建期报错**：静态路径不执行
                    // render()，闭包作用域未必存在这些名字。
                    // freeIds 为空说明失败来自其他 code:null 路径（如私有名包装
                    // parse 失败），此时 subBv.errors 才是真实原因，优先透出。
                    const realErrors =
                      (subBv.errors?.length ?? 0) > 0 && !(subBv.freeIds?.length ?? 0)
                        ? subBv.errors
                        : [
                          `插值表达式无法内联进 effect 工厂，引用了无法解析的自由标识符 '${(subBv.freeIds ?? []).join(
                            "', '",
                          )}'`,
                        ]
                    tmplErrors = realErrors.map((m) => `sub#${cand.subId}: ${m}`)
                    break
                  }
                } catch (e) {
                  tmplErrors = [
                    `sub#${cand.subId}: ${e instanceof SubExtractError || e instanceof TemplateExtractError
                      ? e.message
                      : String(e)
                    }`,
                  ]
                  break
                }
              }
              if (tmplErrors.length) {
                buildTemplateCode = undefined
              } else if (entries.length) {
                subsCode = `{ ${entries.join(', ')} }`
                // subViewDeps：start → subId 映射后进入依赖清单
                if (depsDisplay && ra.subViewDeps.size) {
                  const startToSubId = new Map(subCandidates.map((c) => [c.start, c.subId]))
                  const rec: Record<number, string[]> = {}
                  let hasAny = false
                  for (const [start, deps] of ra.subViewDeps) {
                    const subId = startToSubId.get(start)
                    if (subId !== undefined && deps.length) {
                      rec[subId] = deps
                      hasAny = true
                    }
                  }
                  if (hasAny) {
                    subViewDepsRec = rec
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      tmplErrors = [e instanceof TemplateParseError || e instanceof TemplateExtractError || e instanceof SubExtractError ? e.message : String(e)]
      // 解析错误同样不可编译：tmplErrors 非空 ⇒ 下方抛 StaticAnalysisError。
    }
    if (tmplErrors.length) {
      // 模板 codegen 失败 ⇒ **编译报错**：放行「凑合能跑」的产物，运行时表现是
      // 组件静默渲染成空白，比构建失败难查得多。
      throw new StaticAnalysisError(comp.className, tmplErrors)
    }

    // render() 存在但无主模板（顶层 return 全为 null/undefined 字面量）→ noView
    if (!mainTmpl && comp.hasRender && !tmplErrors.length) {
      // 检查 render 体的顶层 return 是否全为 null/undefined 字面量
      const rets = comp.renderBody
        ? (Array.isArray(comp.renderBody) ? comp.renderBody : [comp.renderBody])
        : []
      const topRets = rets.filter((s: any) => s?.type === 'ReturnStatement')
      const allNull =
        topRets.length > 0 &&
        topRets.every((r: any) => {
          const raw = r.argument
          if (!raw) return true // return; （无值）视为 null
          const arg = unwrapExpr(raw)
          if (arg.type === 'Literal' && (arg.value === null || arg.value === undefined)) return true
          if (arg.type === 'Identifier' && (arg.name === 'null' || arg.name === 'undefined')) return true
          if (arg.type === 'UnaryExpression' && arg.operator === 'void') return true
          return false
        })
      if (allNull) {
        edits.push({
          comp,
          literal: buildStaticLiteral({ noView: true }, {
            ...fieldCodes,
            cssEffect: cssEffectCode ?? PARENT_CSS_EFFECT,
            watchEffects: watchEffectsCode,
            inlinedWatchAncestors: watchRes.inlinedAncestors,
          }),
          removals: allRemovals,
          ...fieldExtras,
        })
        diagnostics.push({
          className: comp.className,
          viewDeps: 0,
          conventionErrors,
          deps: buildDeps('noView', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries),
        })
        continue
      }
    }

    // render() 存在但没有可编译的主模板（返回 this.tpl / h(CONST) / 其它非 h 表达式）
    // ⇒ 产物既无 buildTemplate 也无 noView，运行时 setup 会抛“未编译”。构建期直接拦。
    if (comp.hasRender && (!mainTmpl || !buildTemplateCode)) {
      throw new StaticAnalysisError(comp.className, [
        'render() 必须返回唯一的 h`` 模板或 null/undefined；' +
        '返回普通表达式/预计算 Template 无法生成静态视图。',
      ])
    }

    // 静态路径准入（运行时唯一渲染路径 = buildTemplate 在字面量里）
    // → render() 成死代码：体清空为 `render(): Template {}`（走 removals，剥离测试恒等）。
    // 「未准入」只剩 noView 一种，走上面 noView 的早退分支，不会流到这里
    const stripRender =
      !!buildTemplateCode &&
      comp.renderBodyStart >= 0 &&
      comp.renderBodyEnd > comp.renderBodyStart
    const edit: (typeof edits)[number] = {
      comp,
      literal: buildStaticLiteral({}, {
        pointEffects: pointEffectsCode,
        fx: fxCode,
        watchEffects: watchEffectsCode,
        inlinedWatchAncestors: watchRes.inlinedAncestors,
        cssEffect: cssEffectCode ?? PARENT_CSS_EFFECT,
        buildTemplate: buildTemplateCode,
        subViews: subsCode,
        ...fieldCodes,
      }),
      removals: allRemovals,
      ...fieldExtras,
    }
    edits.push(edit)
    if (stripRender) renderStrips.push({ edit, start: comp.renderBodyStart, end: comp.renderBodyEnd })
    diagnostics.push({
      className: comp.className,
      viewDeps: ra.viewDeps.length,
      conventionErrors,
      deps: buildDeps('normal', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries, updateMeta),
    })
  }

  // render 体清空（问题④）：静态准入组件的 render **无任何运行时消费**，无条件清空。
  for (const rs of renderStrips) rs.edit.removals = [...(rs.edit.removals ?? []), { start: rs.start, end: rs.end }]

  // 访问器所需运行时函数：文件级并集 → 扩展已有 compelem import（或新增独立 import 行）
  // Map<本地名, 原始导出名>：冲突别名时两者不同，import 必须写 `原导出名 as 本地名`。
  const localToImported = new Map<string, string>()
  for (const [canon, alias] of Object.entries(helperBindings)) localToImported.set(alias, canon)
  const helperNeeds = new Map<string, string>()
  const myfxNeeds = new Map<string, string>()
  const addNeed = (into: Map<string, string>, local: string) => {
    into.set(local, localToImported.get(local) ?? local)
  }
  for (const e of edits) {
    for (const hlp of e.helpers ?? []) addNeed(helperNeeds, hlp)
    for (const hlp of e.myfxHelpers ?? []) addNeed(myfxNeeds, hlp)
  }
  let helperImport: { decl: any; source: string } | undefined
  let myfxImport: { decl: any; source: string } | undefined
  let helpersAnchor: number | undefined
  if (helperNeeds.size || myfxNeeds.size) {
    for (const node of parsed.program.body ?? []) {
      if (node.type !== 'ImportDeclaration') continue
      if (helpersAnchor === undefined) helpersAnchor = node.start
      const src = node.source?.value
      if (typeof src === 'string') {
        if (isCompelemSource(src)) {
          // C4：同文件多处命中 compelem 源时，优先裸包名 `compelem`（生产形态），
          // dev 相对形态 `./src` 仅作回退——避免 dev 依赖把 helper 注到相对入口上。
          if (!helperImport || (helperImport.source !== 'compelem' && src === 'compelem')) {
            helperImport = { decl: node, source: src }
          }
        } else if (!myfxImport && isMyfxSource(src)) {
          myfxImport = { decl: node, source: src }
        }
      }
    }
    // 无 import 时锚在首语句起点（前导注释之后）
    if (helpersAnchor === undefined) helpersAnchor = firstCodeStart(parsed.program)
  }

  // carrier 常量的模块级插入点：最后一个 import 声明之后（无 import 则首语句之前）
  let topLevelAnchor: number | undefined
  if (carrierDecls.length) {
    let lastImportEnd: number | undefined
    for (const node of parsed.program.body ?? []) {
      if (node.type === 'ImportDeclaration') lastImportEnd = node.end
    }
    topLevelAnchor = lastImportEnd ?? firstCodeStart(parsed.program)
  }

  const aliasRecord = (m: Map<string, string>) =>
    Object.fromEntries([...m].filter(([local, imported]) => local !== imported))

  const mappedEdits = inlineEdits.length ? edits.map((e) => mapEditToOriginal(e, inlineEdits)) : edits
  const mapPos = (n: number | undefined) =>
    n === undefined ? undefined : mapInlineOffset(n, inlineEdits)
  const mapImport = (
    imp: { decl: any; source: string } | undefined,
  ): { decl: any; source: string } | undefined =>
    !imp || !inlineEdits.length
      ? imp
      : {
        source: imp.source,
        decl: {
          ...imp.decl,
          start: mapInlineOffset(imp.decl.start, inlineEdits),
          end: mapInlineOffset(imp.decl.end, inlineEdits),
        },
      }

  const { code: out, map, injected, additions } = injectInto(
    inlineEdits.length ? originalCode : code,
    mappedEdits,
    id,
    {
      helpers: helperNeeds.size ? [...helperNeeds.keys()] : undefined,
      helperAliases: helperNeeds.size ? aliasRecord(helperNeeds) : undefined,
      helperImport: mapImport(helperImport),
      myfxHelpers: myfxNeeds.size ? [...myfxNeeds.keys()] : undefined,
      myfxAliases: myfxNeeds.size ? aliasRecord(myfxNeeds) : undefined,
      myfxImport: mapImport(myfxImport),
      helpersAnchor: mapPos(helpersAnchor),
      topLevel: carrierDecls.length ? carrierDecls.join('\n') : undefined,
      topLevelAnchor: mapPos(topLevelAnchor),
      inlineEdits,
    },
  )

  // 诊断的 offset 是 inline 变换后的坐标系；对外统一回到原始源码坐标。
  if (inlineEdits.length) {
    for (const d of diagnostics) {
      for (const e of d.conventionErrors) {
        e.start = mapInlineOffset(e.start, inlineEdits)
        e.end = mapInlineOffset(e.end, inlineEdits)
      }
    }
  }
  // verbose 依赖清单打印（depsDisplay 判定同上，已在 compileFile 入口计算）
  if (depsDisplay) {
    for (const d of diagnostics) if (d.deps) console.log(formatDeps(id, d))
  }
  return {
    code: out,
    map,
    diagnostics,
    changed: injected.length > 0,
    removals: mappedEdits.flatMap((e) => e.removals ?? []),
    additions,
  }
}

export { analyzeFile, analyzeRender, assertStaticAnalysis }

/**
 * 编译**已确定要编译**的源码，跳过 `include` 判定。
 *
 * 与 {@link compileFile} 的分工：
 * - `compileFile` 面向「磁盘上可能是组件、也可能不是」的输入，先按扩展名 +
 *   特征做 include 判定；
 * - `compileSource` 面向「调用方已经决定要编译」的输入 —— 典型是 SFC 插件把
 *   `.ce` 分段拼成的虚拟 TypeScript 模块。虚拟模块的 id 仍是 `.ce`（为了
 *   sourcemap 指向真实文件），天然过不了 `defaultInclude` 的扩展名检查，
 *   以前只能传 `include: () => true` 绕过整个判定（连 node_modules 排除也一起绕过）。
 *
 * `options.include` 在这里被忽略。
 */
export function compileSource(
  code: string,
  id: string,
  options: CompilerOptions = {},
): CompileResult {
  return compileFile(code, id, { ...options, include: () => true })
}
