/**
 * 编译器主流程：单文件 → 注入 `__ce_static__` 后的源码。
 */
import type { CompilerOptions, ComponentAnalysis } from './types'
import { DEBUG_DIV } from './types'
import { parse } from './utils/oxc'
import { analyzeFile, collectLocalClasses, collectModuleBindings, isCompelemSource, isMyfxSource } from './analyze/component'
import { analyzeRender } from './analyze/render-body'
import { decideDegrade, StaticAnalysisError } from './analyze/degrade'
import { checkConventions, collectModuleConsts, collectStringConsts } from './analyze/conventions'
import { extractMainTemplate, TemplateExtractError } from './analyze/template-extract'
import { collectSubCandidates, SubExtractError, enclosingCandidates, paramBaseNames } from './analyze/template-subs'
import { extractCssDeps, extractComputedDeps } from './analyze/deps-extract'
import { parseTemplateTree, buildTemplateHTML, TemplateParseError } from './analyze/template-tree'
import { checkTemplateRules } from './analyze/template-rules'
import { extractWatchers, generateWatchEffects, type WatchEntry } from './analyze/watch-extract'
import { extractFieldAccessors, RUNTIME_HELPERS } from './analyze/field-extract'
import { extractMethodDecos } from './analyze/method-deco-extract'
import { generateBuildTemplate, type UpOut } from './codegen/template-dom'
import { generateBuildVars, generateSubBuildVars, type BuildVarsOptions } from './codegen/build-vars'
import { generateRenderEffect, generateSubInlinedEffect, buildSubInliner } from './codegen/render-effect'
import { buildStaticLiteral, emitFamily, injectInto, planCtorInsert, type CtorInsertPlan } from './codegen/inject'

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
    degraded: boolean
    reason: string | null
    viewDeps: number
    /** 硬性违规（D7 嵌套模板），需在构建期暴露给用户 */
    errors: Array<{ start: number; end: number; exprStart: number; exprEnd: number; message: string }>
    /** 约定错误（emit/@prop/@computed/@csscope 静态校验），与降级无关 */
    conventionErrors: Array<{ start: number; end: number; message: string }>
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
 * 默认的参与编译判定：`.ts` 且源码里出现 `extends CompElem` 或 `@tag`。
 *
 * 额外放行**家族装饰器**形态：mixin 文件（`export function mix(B) { class M extends B { @prop … } }`）
 * 既不含 `extends CompElem` 也不含 `@tag`（`@tag` 挂在具体组件上），但必须参与编译，
 * 否则其中的 `@prop/@state/@computed` 不会被剥离、注入的 `__ce_static__` 缺失，
 * 而运行时这几个装饰器是 no-op ⇒ 属性静默退化成普通实例字段。
 * 精确性由 `collectMixinClasses` 的「顶层函数体内 + 带 compelem 家族装饰器」把关，
 * 这里放宽只是让文件进入管线。
 *
 * ⚠️ 保持只收 `.ts`：IIFE 打包产物（`.js`）里指令名不在 scope，放宽会触发 D3 误报。
 */
export function defaultInclude(id: string, code: string): boolean {
  const clean = id.split('?')[0]
  if (!/\.tsx?$/.test(clean)) return false
  if (clean.endsWith('.d.ts')) return false
  if (clean.includes('node_modules')) return false
  if (code.includes('extends CompElem') || /@tag\s*\(/.test(code)) return true
  return /@(prop|state|computed|query|queryAll)\b/.test(code)
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
  const head = `[compelem/compiler] ${id} :: ${d.className} 依赖清单 [${tag}]${d.degraded ? ` 降级(${d.reason ?? '?'})` : ''}`
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

/** 编译单个文件。不会抛出：解析失败时原样返回。 */
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

  const comps = analyzeFile(code, id, parsed)
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
  // render 体清空候选（静态准入组件的 render 是死代码）。全文件任一组件抽取的表达式
  // 以 super.render() 取基类视图时（superHelpers 含 render → 注入 __ce_s_render 转发），
  // 基类 render 体是运行时依赖 → 该候选整体不生效（保守：文件内全保留）。
  const renderStrips: Array<{ edit: (typeof edits)[number]; start: number; end: number }> = []
  let sawRenderForward = false

  // 标签注册表：同文件 @tag + options.knownTags（跨文件由 vite 插件累积注入，见 TEMPLATE-CODEGEN.md §4）
  const fileTags = new Set<string>()
  for (const c of comps) if (c.tagName) fileTags.add(c.tagName.toLowerCase())
  if (options.knownTags) for (const t of options.knownTags) fileTags.add(t.toLowerCase())
  // 已知的 HTML 原生标签（非组件），供 .prop 目标校验时区分「原生标签误用」与「跨文件组件未知」
  // 这里不穷举原生标签——校验逻辑是：有连字符但不在 knownTags → 错误；无连字符 → 原生标签错误；

  // 约定检查上下文（emit 校验 / @prop / @computed / @csscope 目标检查）
  const convCtx = {
    localClasses: collectLocalClasses(parsed),
    stringConsts: collectStringConsts(parsed.program),
    moduleConsts: collectModuleConsts(parsed.program),
    importedLocals: new Set(parsed.imports.keys()),
    code,
  }

  // 运行时函数（RUNTIME_HELPERS）的模块定名：默认原名，与模块既有绑定冲突时
  // 改用 __ce_ 前缀别名（文件级统一，访问器与 import 注入共用）
  const moduleBindings = collectModuleBindings(parsed)
  const helperBindings: Record<string, string> = {}
  for (const canon of RUNTIME_HELPERS) {
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
    // 约定检查独立于降级判定：降级组件同样检查（这些错误运行时也报，只是更晚）
    let conventionErrors = checkConventions(comp, convCtx)

    // @watch 编译期解析（watch 前移）：解析成功 → 删装饰器 + 注入 watchers；
    // 有 E-WATCH-ARG → 整体放弃（不删不注），运行时装饰器路径兜底。
    // watch 前移产物与模板加速字段不同：与降级无关，必须注入。
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
    // ⚠️ 构造体插入点条件：**fieldInits 或 methodDecoCtor 任一非空**就要算 ——
    // 只有方法装饰器、没有 prop/state 的组件（如 `@onced init(){}` 裸组件）同样必须注入。
    const needCtor = fieldRes.fieldInits.length > 0 || !!mdRes.ctorStmts
    const ctorPlan = needCtor
      ? planCtorInsert(comp, comp.cls ?? convCtx.localClasses.get(comp.className), code)
      : undefined
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
    const decision = decideDegrade(comp, ra)

    // ---- cssDeps / computedDeps 静态提取（候选4/候选3，与降级无关，始终尝试）----
    const cssDeps = extractCssDeps(comp, convCtx.localClasses)
    const computedDeps = extractComputedDeps(comp, convCtx.localClasses)
    let cssEffectCode: string | undefined
    if (cssDeps && cssDeps.length) {
      const signalReads = cssDeps.map(d => `rc.__s.${d}.value`).join(', ')
      // cssDeps 是已知信号根的扁平数组：逐元素 Object.is 比较，免去每次触发
      // 两侧各一次 JSON.stringify（序列化整个依赖数组）
      // `wCssVars` 是 compelem 的模块级自由函数（首参 rc）：作者可见的 CompElem
      // 类型面上不留这批「产物专用」成员。
      writers.add('wCssVars')
      cssEffectCode = `(rc) => { let ov; return () => { const nv = [${signalReads}]; let changed = ov === undefined; if (!changed) { for (let i = 0; i < nv.length; i++) { if (!Object.is(nv[i], ov[i])) { changed = true; break } } } if (changed) { wCssVars(rc); ov = nv } } }`
    }
    // subViewDeps：ra.subViewDeps 的 key 是回调 start 偏移，需映射为 subId
    // （collectSubCandidates 在 codegen 分支内执行；非降级且有主模板时才有 subId）
    // 仅用于 debug 依赖清单输出（不注入 __ce_static__）
    let subViewDepsRec: Record<number, string[]> | undefined

    // ---- 无视图组件（noView）：无 render / render 返回 null / 继承链终点 CompElem ----
    if (comp.noView) {
      edits.push({
        comp,
        literal: buildStaticLiteral({ noView: true }, { ...fieldCodes }),
        removals: allRemovals,
        ...fieldExtras,
      })
      diagnostics.push({
        className: comp.className,
        degraded: false,
        reason: null,
        viewDeps: 0,
        errors: [],
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
        fieldRes.computedCode !== undefined
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
        // watchEffects 必须注入：@watch 装饰器已随 watchRemovals 被删，不注入即彻底丢失
        if (watchEffectsCode) parts.push(mk('watchEffects', `watchEffects: ${watchEffectsCode}`))
        // 本分支（继承链上有 render 祖先 ⇒ skipInjection）与 `codegen/inject.ts` 同为
        // 注入路径，同样不注入 `diag`：降级信息只经 `compileResult.diagnostics` 出口
        // （`degraded` / `reason` / `errors`），产物里不留该字段。
        //
        // ⚠️ `version` 必须保留：运行时据它判定产物准入
        // （`CompElem.ts` 中 `ceStatic.version >= 3` 校验）。
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
        // decideDegrade 命中即抛 ⇒ 能走到这里必为通过。
        degraded: false,
        reason: null,
        viewDeps: ra.viewDeps.length,
        errors: decision.errors.map((e) => ({
          start: e.start,
          end: e.end,
          exprStart: e.exprStart,
          exprEnd: e.exprEnd,
          message: e.message,
        })),
        conventionErrors,
        deps: buildDeps('skipInjection', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries),
      })
      continue
    }

    const opts = {
      buildVars: !options.disable?.buildVars,
    }

    // ---- 模板诊断（约定错误 E-*）无条件执行 ----
    // extractMainTemplate → parseTemplateTree → checkTemplateRules 始终运行，
    // 与静态分析结论正交，必须报告。
    // codegen（generateBuildTemplate/generateBuildVars）仍条件化：降级组件不生成构建产物。
    let buildTemplateCode: string | undefined
    let subsCode: string | undefined
    let pointEffectsCode: string | undefined
    let fxCode: string | undefined
    let tmplErrors: string[] = []
    let superHelpers: string[] = []
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
        // 模板层约定规则（.prop 须插值 / 事件须函数 / ref 须 createRef / 指令位置 / .prop 目标）
        conventionErrors.push(...checkTemplateRules(tree, mainTmpl, comp, convCtx, fileTags))

        // codegen：恒执行（compelem 不允许降级 —— decideDegrade 命中即抛）
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
            } catch (e) {
              tmplErrors = [
                e instanceof SubExtractError || e instanceof TemplateExtractError
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
                for (const cand of subCandidates) {
                  const r = subBvMap.get(cand.subId)!
                  if (r.code || !r.freeIds?.length) continue
                  const ancestors = enclosingCandidates(cand, subCandidates)
                  const allowed = new Set<string>()
                  for (const a of ancestors) for (const n of paramBaseNames(a.params)) allowed.add(n)
                  if (!r.freeIds.every((id) => allowed.has(id))) continue
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
                      const liftTree = parseTemplateTree(
                        buildTemplateHTML(cand.strings),
                        cand.vars.length,
                      )
                      liftGen = generateBuildTemplate(liftTree.root, cand.vars, {
                        className: comp.className,
                        knownTags: fileTags,
                      })
                    } catch {
                      liftGen = undefined
                    }
                    if (liftGen && !liftGen.errors.length) {
                      const liftSupers = new Set<string>()
                      const inliner = buildSubInliner(cand, code, subCandidates, extras, carriers, liftSupers)
                      const subParams = cand.params.length ? `, ${cand.params.join(', ')}` : ''
                      const subRe = generateSubInlinedEffect(
                        liftGen.ups ?? [],
                        inliner.val,
                        inliner.prelude ?? '',
                        subParams,
                      )
                      if (!subRe.usedGet && inliner.prelude != null) {
                        for (const w of subRe.writers) writers.add(w)
                        extras.set(cand.subId, `, __fx: { fx: ${subRe.fxExpr}, pe: ${subRe.arrayExpr} }`)
                        for (const s of liftSupers) if (!superHelpers.includes(s)) superHelpers.push(s)
                        if (lifted.superHelpers?.length) {
                          for (const s of lifted.superHelpers) if (!superHelpers.includes(s)) superHelpers.push(s)
                        }
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
                      r.superHelpers = regen.superHelpers
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
                // fx / pointEffects 工厂。保留本函数调用是因为它还提供三样东西：
                //   ① `bv.errors` —— 门禁（自由标识符 / TS 语法 ⇒ 不可编译）
                //   ② `bv.superHelpers` —— 表达式里的 super.METHOD 转发方法
                //   ③ `bv.viewDepVarIndices` —— verbose 依赖清单的根名→var 映射
                if (bv.superHelpers?.length) superHelpers.push(...bv.superHelpers)
                if (mainUps?.length) {
                  // varIndex → 该 var 自己的表达式：保留 `this.metrics.length` 这类成员访问，
                  // 否则 effect 只会读 `rc.__s.metrics.value`（整个数组），
                  // 文本点就会渲染成 [object Object],[object Object],…
                  const varIndexToExpr = new Map<number, string>()
                  for (const v of mainTmpl.vars) varIndexToExpr.set(v.index, v.exprSource)
                  // `__s` 的真实键集 = 本组件（含继承链）已建信号的字段 + 框架自带 slots。
                  // 只有这些键才允许内联成 `rc.__s.<k>.value`，见 signalExprFor 的说明。
                  const signalKeys = new Set<string>(comp.fields.keys())
                  signalKeys.add('slots')
                  // 内联上下文：让 effect / fx 工厂直接内联表达式（含 __subId wraps）。
                  // - ranges：varIndex → 源码绝对区间，applySubIdWraps 靠偏移切片
                  // - superHelpers：内联表达式里的 super.METHOD 与子模板汇流到同一集合，
                  //   否则类体会漏注入 `__ce_s_METHOD` 转发方法（Expression is not defined）
                  const varIndexToRange = new Map<number, [number, number]>()
                  for (const v of mainTmpl.vars) {
                    if (typeof v.start === 'number' && typeof v.end === 'number') {
                      varIndexToRange.set(v.index, [v.start, v.end])
                    }
                  }
                  const fxSuperHelpers = new Set<string>()
                  const re = generateRenderEffect(mainUps, varIndexToExpr, signalKeys, {
                    source: code,
                    candidates: subCandidates,
                    extras,
                    carriers,
                    ranges: varIndexToRange,
                    // rewriteSuper 要 Set；产出入 Set 再并回外层数组
                    superHelpers: fxSuperHelpers,
                  })
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
                  for (const s of fxSuperHelpers) if (!superHelpers.includes(s)) superHelpers.push(s)

                }
                const vm = makeVarMap(comp, bv.viewDepVarIndices, mainUps, mainNodeNames)
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
            // 子模板 codegen：任一失败 → 整组件降级（清空主产物）
            if (!tmplErrors.length && buildTemplateCode && subCandidates.length) {
              const entries: string[] = []
              for (const cand of subCandidates) {
                try {
                  const subTree = parseTemplateTree(
                    buildTemplateHTML(cand.strings),
                    cand.vars.length,
                  )
                  const subGen = generateBuildTemplate(subTree.root, cand.vars, {
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

                  const subVm = makeVarMap(comp, subBv.viewDepVarIndices, subGen.ups, subGen.nodeNames)
                  if (subVm) {
                    if (!updateMeta.subVarMap) updateMeta.subVarMap = {}
                    updateMeta.subVarMap[cand.subId] = subVm
                  }
                  if (subBv.code) {
                    // **自洽子模板** → 内联 fx。
                    // 表达式只引用自身形参 + this + 模块名，顶层工厂可直接内联取值，
                    // 运行时无需 get 回退。跨层子模板（引用祖先形参，如 `row[c]`）
                    // 走下面的已提升分支（回调实例上的 __fx）。
                    const subSupers = new Set<string>()
                    const inliner = buildSubInliner(cand, code, subCandidates, c1Extras, c1Carriers, subSupers)
                    const subParams = cand.params.length ? `, ${cand.params.join(', ')}` : ''
                    const subRe = generateSubInlinedEffect(
                      subGen.ups ?? [],
                      inliner.val,
                      inliner.prelude ?? '',
                      subParams,
                    )
                    if (subRe.usedGet || inliner.prelude == null) {
                      tmplErrors = [
                        `sub#${cand.subId}: 子模板存在无法内联进 effect 工厂的插值表达式（get(varIndex) 回退）`,
                      ]
                      break
                    }
                    for (const s of subSupers) if (!superHelpers.includes(s)) superHelpers.push(s)
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
                    tmplErrors = [
                      `sub#${cand.subId}: 插值表达式无法内联进 effect 工厂，引用了无法解析的自由标识符 '${(subBv.freeIds ?? []).join(
                        "', '",
                      )}'`,
                    ]
                    break
                  }
                } catch (e) {
                  tmplErrors = [
                    `sub#${cand.subId}: ${
                      e instanceof SubExtractError || e instanceof TemplateExtractError
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
                if (ra.subViewDeps.size) {
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
      // 解析错误同样不可编译：tmplErrors 非空 ⇒ 下方降级判定会把它变成诊断错误。
    }
    if (tmplErrors.length) {
      // 模板 codegen 失败 ⇒ **编译报错，不降级**：降级产物在运行时的表现是
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
          const arg = r.argument
          if (!arg) return true // return; （无值）视为 null
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
          }),
          removals: allRemovals,
          ...fieldExtras,
        })
        diagnostics.push({
          className: comp.className,
          degraded: false,
          reason: null,
          viewDeps: 0,
          errors: [],
          conventionErrors,
          deps: buildDeps('noView', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries),
        })
        continue
      }
    }

    // 静态路径准入（运行时唯一渲染路径 = buildTemplate 在字面量里）
    // → render() 成死代码：体清空为 `render(): Template {}`（走 removals，剥离测试恒等）。
    // 「未准入」只剩 noView 一种，走上面 noView 的早退分支，不会流到这里。
    //
    // ⚠️ 判据就是「静态路径产出了 buildTemplate」。
    //    也**不能用 pointEffectsCode 代替** —— 无 view 点的组件它为 undefined，
    //    会让本该走静态路径的组件忽然保留 render 体（会导致 subs 的 __subId 丢失）。
    const stripRender =
      !!buildTemplateCode &&
      comp.renderBodyStart >= 0 &&
      comp.renderBodyEnd > comp.renderBodyStart
    const edit: (typeof edits)[number] = {
      comp,
      literal: buildStaticLiteral(opts, {
        pointEffects: pointEffectsCode,
        fx: fxCode,
        watchEffects: watchEffectsCode,
        cssEffect: cssEffectCode,
        buildTemplate: buildTemplateCode,
        subViews: subsCode,
        superHelpers: superHelpers.length ? [...new Set(superHelpers)] : undefined,
        ...fieldCodes,
      }),
      removals: allRemovals,
      ...fieldExtras,
    }
    edits.push(edit)
    if (stripRender) renderStrips.push({ edit, start: comp.renderBodyStart, end: comp.renderBodyEnd })
    if (superHelpers.includes('render')) sawRenderForward = true
    diagnostics.push({
      className: comp.className,
      // 能走到这里说明 decideDegrade 与模板 codegen 都已通过 ⇒ 恒为false。
      degraded: false,
      reason: null,
      viewDeps: ra.viewDeps.length,
      errors: decision.errors.map((e) => ({
        start: e.start,
        end: e.end,
        exprStart: e.exprStart,
        exprEnd: e.exprEnd,
        message: e.message,
      })),
      conventionErrors,
      deps: buildDeps('normal', ra, cssDeps, computedDeps, subViewDepsRec, watchRes.entries, updateMeta),
    })
  }

  // render 体清空（问题④）：静态准入组件的 render 无运行时消费；super.render 转发存在时保留。
  if (!sawRenderForward) {
    for (const rs of renderStrips) rs.edit.removals = [...(rs.edit.removals ?? []), { start: rs.start, end: rs.end }]
  }

  // 访问器所需运行时函数：文件级并集 → 扩展已有 compelem import（或新增独立 import 行）
  const helperNeeds = new Set<string>()
  const myfxNeeds = new Set<string>()
  for (const e of edits) {
    for (const hlp of e.helpers ?? []) helperNeeds.add(hlp)
    for (const hlp of e.myfxHelpers ?? []) myfxNeeds.add(hlp)
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
        if (!helperImport && isCompelemSource(src)) helperImport = { decl: node, source: src }
        else if (!myfxImport && isMyfxSource(src)) myfxImport = { decl: node, source: src }
      }
      if (helperImport && myfxImport) break
    }
    // 无 import 时锚在首语句起点（前导注释之后）
    if (helpersAnchor === undefined) helpersAnchor = parsed.program.body?.[0]?.start ?? 0
  }

  // carrier 常量的模块级插入点：最后一个 import 声明之后（无 import 则首语句之前）
  let topLevelAnchor: number | undefined
  if (carrierDecls.length) {
    let lastImportEnd: number | undefined
    for (const node of parsed.program.body ?? []) {
      if (node.type === 'ImportDeclaration') lastImportEnd = node.end
    }
    topLevelAnchor =
      lastImportEnd ?? parsed.program.body?.[0]?.start ?? 0
  }

  const { code: out, map, injected, additions } = injectInto(code, edits, id, {
    helpers: helperNeeds.size ? [...helperNeeds] : undefined,
    helperImport,
    myfxHelpers: myfxNeeds.size ? [...myfxNeeds] : undefined,
    myfxImport,
    helpersAnchor,
    topLevel: carrierDecls.length ? carrierDecls.join('\n') : undefined,
    topLevelAnchor,
  })
  // verbose 依赖清单打印（depsDisplay 判定同上，已在 compileFile 入口计算）
  if (depsDisplay) {
    for (const d of diagnostics) if (d.deps) console.log(formatDeps(id, d))
  }
  return {
    code: out,
    map,
    diagnostics,
    changed: injected.length > 0,
    removals: edits.flatMap((e) => e.removals ?? []),
    additions,
  }
}

export { analyzeRender, analyzeFile, decideDegrade }
