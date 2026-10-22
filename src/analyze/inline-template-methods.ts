import { collectCompelemImports } from './component'
import { COMpelem_DIRECTIVES } from './render-body'
import { collectPatternNames, unwrapExpr, type ParsedFile } from '../utils/ast'

/**
 * 模板方法内联预变换（source-level pre-pass）
 *
 * 新编译器要求结构指令回调的表达式体/顶层 return **直接**是 h`` 模板——
 * `forEach(rows, r => this.renderRow(r))` 这类「回调间接返回 Template」的写法
 * 无法静态提取子视图（template-subs 需要 DOM 克隆源编译期可见）。
 *
 * 本 pass 在主分析管线之前做纯文本改写，把符合「唯一 h`` 直接返回」形状的
 * 本类方法调用内联为等价回调：
 *
 *   r => this.renderRow(r)      →  (r, row = r, field = row.field) => { ...; return h`...` }
 *   ifTrue(c, this.header())    →  ifTrue(c, () => { return h`...` })
 *
 * 关键设计——**方法形参与尾随简单 const 一律注入为回调体的前置 const（prelude 注入）**：
 *
 *   r => this.renderRow(r)      →  (r) => { const row = r; const field = row.field; ...; return h`...` }
 *   ifTrue(c, this.header())    →  ifTrue(c, () => { return h`...` })
 *
 * 运行期子视图工厂按**位置**传参：`(rc, nodes, __ceGet, __ceDep, ov, v, k, i)` ——
 * 第 6~8 位是结构指令的 item 槽位（cond 路径 `valueAry ?? [0]` 灌 `cell.value`）。
 * 曾试过把绑定提升为「带默认值形参」：绑定名恰好落在 item 槽位上，运行期实参
 * 覆盖默认值 ⇒ 实参静默丢失（`data-tab="0"` / 分组标签显示 0，2026-10-14 实锤，
 * 爆炸半径 = 全部调用形态 site）。注入为 prelude const 后，绑定成为子模板工厂体
 * 内的局部量，运行期多余实参无人接收即被忽略，零碰撞。
 *
 * 嵌套子候选（体内 ifTrue/forEach 的模板回调）引用这些绑定时走 **C1 闭包提升**
 * （`__fx` 词法捕获）：compile.ts 的祖先白名单 = 祖先形参 ∪ **祖先 prelude 声明名**
 * —— 本设计依赖该白名单扩展，两者必须同批生效。
 *
 * 间接链（A 返回 this.B()）递归拉平：各层绑定按「形参 const → 本层 prelude →
 * 尾随 const」的原始声明序拼进同一回调体，内层绑定的初始化器可引用外层绑定。
 *
 * 语义保持论证：
 * - 实参只求值一次（const 初始化 = 原实参源码，求值时机与调用点等价）；
 * - this 链不变（回调内 this 与方法调用时的 this 同为组件实例）；
 * - 方法体源码原样搬运；方法保留在类上（内联后成死代码，无害）。
 *
 * 不匹配模板形状（0/多个 h``、非直接 return、形参含解构、名字碰撞等）的
 * 方法调用**原样保留**，交由主管线的静态检查给出原有诊断——本 pass 绝不
 * 扩大报错面。
 */

export interface Edit {
  start: number
  end: number
  text: string
}

interface MethodInfo {
  /** 形参名列表（仅支持纯 Identifier 形参）；null = 形参模式不支持 */
  params: string[] | null
  /** 方法体节点（BlockStatement 或箭头字段的表达式体） */
  bodyNode: any
  /** async/generator 不能内联（会丢 await/yield 语义） */
  async: boolean
}

interface BodyShape {
  /** 不可提升的 prelude 前缀源码（可空） */
  preludeSrc: string
  /** 从 prelude 尾部提升的简单 const（const X = expr;）→ 回调体前置 const */
  lifts: Array<{ name: string; initSrc: string; init: any }>
  /** return 的实参（h`` 节点，或 this 方法调用节点——由调用方递归拉平） */
  retArg: any
}

/** 单次内联的结果：块体内部语句（绑定 const + prelude + 内层链） */
interface InlineResult {
  inner: string
}

const MAX_DEPTH = 8

/**
 * import 解析上下文：本文件的两个「识别 compelem 侧符号」判定都必须在**本地名 →
 * 原始导入名**映射后再判断——否则 dev 形态（`from '../src/index'`）与改名导入
 * （`import { h as html }` / `import { ifTrue as t }`）会让本 pass 静默不生效，
 * 把可内联的写法退回主管线的报错。
 */
interface ImportCtx {
  /** h 标签函数的本地别名（仅 import 绑定，`const h2 = h` 级别名不做） */
  hLocals: Set<string>
  /** compelem 本体绑定：本地名 → 原始导入名 */
  compelem: Map<string, string>
}

/** callee 本地名是否解析为 compelem 内置指令（改名导入后同样识别）。 */
function isDirectiveRef(ctx: ImportCtx, calleeName: string): boolean {
  const imported = ctx.compelem.get(calleeName)
  return !!imported && COMpelem_DIRECTIVES.has(imported)
}

/**
 * 通用 AST 子树遍历（跳过元数据键；不去重——调用方自行控制范围）。
 * visit 返回 true = **不再下钻该节点子树**（site 命中/已入列编辑区间用）。
 */
function walk(node: any, visit: (n: any) => boolean | void): void {
  if (!node || typeof node.type !== 'string') return
  if (visit(node) === true) return
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'parent') continue
    const c = node[key]
    if (Array.isArray(c)) for (const x of c) walk(x, visit)
    else if (c && typeof c === 'object' && typeof c.type === 'string') walk(c, visit)
  }
}

/** `this.name(...)` / `this.#name(...)` → 方法名；否则 null */
function thisMethodCalleeName(node: any): string | null {
  if (!node || node.type !== 'CallExpression') return null
  const callee = node.callee
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null
  if (!callee.object || callee.object.type !== 'ThisExpression') return null
  const p = callee.property
  if (p.type === 'Identifier') return p.name
  if (p.type === 'PrivateIdentifier' || p.type === 'PrivateName') return '#' + p.name
  return null
}

/** 从 class 节点收集本类方法/箭头字段：name → MethodInfo */
function collectMethods(cls: any): Map<string, MethodInfo> {
  const map = new Map<string, MethodInfo>()
  for (const member of cls.body?.body ?? []) {
    let name: string | null = null
    let fnNode: any = null
    if (member.type === 'MethodDefinition') {
      const k = member.key
      if (k?.type === 'Identifier') name = k.name
      else if (k?.type === 'PrivateIdentifier' || k?.type === 'PrivateName') name = '#' + k.name
      fnNode = member.value
    } else if (member.type === 'PropertyDefinition') {
      const k = member.key
      if (k?.type === 'Identifier') name = k.name
      else if (k?.type === 'PrivateIdentifier' || k?.type === 'PrivateName') name = '#' + k.name
      fnNode = member.value
    }
    if (!name || !fnNode) continue
    if (fnNode.type !== 'FunctionExpression' && fnNode.type !== 'ArrowFunctionExpression') continue
    const params: string[] = []
    let ok = true
    for (const p of fnNode.params ?? []) {
      if (p.type === 'Identifier') params.push(p.name)
      else {
        ok = false
        break
      }
    }
    map.set(name, { params: ok ? params : null, bodyNode: fnNode.body, async: !!fnNode.async || !!fnNode.generator })
  }
  return map
}

/** 尾随可提升 const：`const X = <expr>;`（单声明符、纯 Identifier、有初始值） */
function liftableConst(s: any): { name: string; init: any } | null {
  if (s?.type !== 'VariableDeclaration' || s.kind !== 'const') return null
  if (s.declarations?.length !== 1) return null
  const d = s.declarations[0]
  if (d.id?.type !== 'Identifier' || !d.init) return null
  return { name: d.id.name, init: d.init }
}

/**
 * 校验方法体是否「唯一 h`` 直接返回」形状（单层，不递归）：
 * 块体 = [任意 prelude 语句][若干尾随简单 const][return <模板>]；表达式体 = 模板。
 * retArg 为 h`` 节点，或 this 方法调用节点（间接链由 buildChain 递归拉平）。
 */
function bodyShapeOf(code: string, bodyNode: any, ctx: ImportCtx): BodyShape | null {
  if (!bodyNode) return null
  const isH = (n: any): boolean =>
    n?.type === 'TaggedTemplateExpression' && n.tag?.type === 'Identifier' && ctx.hLocals.has(n.tag.name)

  if (bodyNode.type !== 'BlockStatement') {
    const expr = unwrapExpr(bodyNode)
    if (isH(expr) || thisMethodCalleeName(expr)) return { preludeSrc: '', lifts: [], retArg: expr }
    return null
  }

  const stmts: any[] = bodyNode.body ?? []
  const retIdxs = stmts.map((s, i) => (s.type === 'ReturnStatement' ? i : -1)).filter((i) => i >= 0)
  if (retIdxs.length !== 1) return null
  const retIdx = retIdxs[0]
  if (retIdx !== stmts.length - 1) return null
  const arg = unwrapExpr(stmts[retIdx].argument)
  if (!arg) return null
  if (!isH(arg) && !thisMethodCalleeName(arg)) return null

  // 尾随简单 const 提升：从 return 前一条语句向前收集，遇第一条不可提升语句停止
  const lifts: Array<{ name: string; initSrc: string; init: any }> = []
  let cut = retIdx // stmts[cut..retIdx-1] 为可提升段
  for (let i = retIdx - 1; i >= 0; i--) {
    const lc = liftableConst(stmts[i])
    if (!lc) break
    lifts.unshift({ name: lc.name, initSrc: code.slice(lc.init.start, lc.init.end), init: lc.init })
    cut = i
  }
  const preludeSrc = cut > 0 ? code.slice(stmts[0].start, stmts[cut - 1].end) : ''
  return { preludeSrc, lifts, retArg: arg }
}

/**
 * AST 级引用检查：子树内是否存在指向 `name` 的**真引用**（Identifier）。
 * 非计算成员属性（`row.field` 的 field）、非计算对象键/方法名不是引用；
 * 对象 shorthand（`{ row }`）的 value 是引用。文本级单词匹配会把属性位置
 * 误判为引用（如 `const field = row.field`），故用 AST 判定。
 */
function referencesIdent(node: any, name: string, skipKey = false): boolean {
  if (!node || typeof node.type !== 'string') return false
  if (node.type === 'Identifier' && node.name === name && !skipKey) return true
  const skip = new Set<string>(['type', 'start', 'end', 'loc', 'parent'])
  if (node.type === 'MemberExpression' && !node.computed) skip.add('property')
  if ((node.type === 'Property' || node.type === 'MethodDefinition') && !node.computed) skip.add('key')
  for (const key of Object.keys(node)) {
    if (skip.has(key)) continue
    const c: any = node[key]
    if (Array.isArray(c)) {
      for (const x of c) if (referencesIdent(x, name)) return true
    } else if (c && typeof c === 'object' && typeof (c as any).type === 'string' && referencesIdent(c, name)) {
      return true
    }
  }
  return false
}

/**
 * 沿间接链拉平 `this.method(args)` 调用，把各层形参/prelude-const 注入为
 * 回调体前置 const（外→内；内层绑定初始化器可引用外层绑定），生成块体内部语句。
 * 不满足形状/参数约束时返回 null（调用方保留原源码）。
 *
 * @param existingNames 外层回调已有形参名（碰撞检测与去重用）
 */
function buildChain(
  code: string,
  methods: Map<string, MethodInfo>,
  callNode: any,
  ctx: ImportCtx,
  visited: Set<string>,
  depth: number,
  existingNames: readonly string[],
): InlineResult | null {
  const name = thisMethodCalleeName(callNode)
  if (!name || depth > MAX_DEPTH || visited.has(name)) return null
  const m = methods.get(name)
  if (!m || !m.params || m.async) return null
  const args: any[] = callNode.arguments ?? []
  if (args.length !== m.params.length) return null
  if (args.some((a) => a.type === 'SpreadElement')) return null
  const shape = bodyShapeOf(code, m.bodyNode, ctx)
  if (!shape) return null

  const visited2 = new Set(visited)
  visited2.add(name)
  const taken = new Set<string>(existingNames)
  const lines: string[] = []

  // 本层方法形参 → 前置 const。护栏：
  // - 实参是与形参同名的裸标识符 → 不新增（方法体内对该名的引用自然落到
  //   外层同名变量上，取值一致）；否则 `const r = r` 式重声明/TDZ；
  // - 形参名与外层已绑定名重名但实参不是同名标识符 → 值可能不同，放弃；
  // - 实参表达式引用了该形参名（如 r.length）→ const 初始化前引用，放弃。
  for (let i = 0; i < m.params.length; i++) {
    const p = m.params[i]
    const argSrc = code.slice(args[i].start, args[i].end)
    const argId = unwrapExpr(args[i])
    if (argId?.type === 'Identifier' && argId.name === p) continue
    if (taken.has(p)) return null
    if (referencesIdent(args[i], p)) return null
    lines.push(`const ${p} = ${argSrc};`)
    taken.add(p)
  }

  lines.push(shape.preludeSrc)

  // 本层 prelude 尾随 const → 原位 const（保持原始声明序：形参绑定 → prelude
  // → 尾随 const；初始化器可引用更早绑定与 prelude 局部量）
  for (const lc of shape.lifts) {
    if (taken.has(lc.name)) return null
    if (referencesIdent(lc.init, lc.name)) return null
    lines.push(`const ${lc.name} = ${lc.initSrc};`)
    taken.add(lc.name)
  }

  if (shape.retArg.type === 'TaggedTemplateExpression') {
    const tplSrc = inlineRegion(code, methods, shape.retArg, ctx, visited2, depth + 1, taken)
    lines.push(`return ${tplSrc};`)
  } else {
    // 间接链：递归拉平内层调用。绑定按原始声明序拼接（内层初始化器可引用
    // 外层绑定）；执行序 = 本层绑定 → 本层 prelude → 本层尾随 const → 内层
    const sub = buildChain(code, methods, shape.retArg, ctx, visited2, depth + 1, [...taken])
    if (!sub) return null
    lines.push(sub.inner)
  }

  return { inner: lines.filter((s) => s.trim()).join('\n') }
}

/**
 * 在「模板节点」子树内收集并应用嵌套 site 的编辑，返回改写后的模板源码。
 * site 形态：
 * - 回调体：`() => this.fn(x)` → `(x0) => { const x = x0; ...; return h... }`
 * - 指令模板实参：`ifTrue(c, this.fn())` → `ifTrue(c, () => { return h... })`
 */
function inlineRegion(
  code: string,
  methods: Map<string, MethodInfo>,
  regionNode: any,
  ctx: ImportCtx,
  visited: Set<string>,
  depth: number,
  outerNames?: ReadonlySet<string>,
): string {
  const edits: Edit[] = []

  walk(regionNode, (n) => {
    // 已入列编辑的区间内不再下钻：外层编辑文本已整体替换该区间（指令实参
    // buildChain / 回调 site），内层再入列会产生重叠编辑、应用时偏移失效
    if (n !== regionNode && typeof n.start === 'number' && typeof n.end === 'number') {
      if (edits.some((e) => n.start >= e.start && n.end <= e.end)) return true
    }
    // site 仅限箭头函数：FunctionExpression 改写成箭头会静默丢失
    // 自定义 thisArg 调用（fn.call(x)）与 arguments 语义
    if (n.type === 'ArrowFunctionExpression' && n !== regionNode) {
      const site = arrowSite(code, methods, n, ctx, visited, depth, outerNames)
      // site 命中后不下钻该子树：嵌套 site 由替换文本内递归 inlineRegion 处理，
      // 这里再入列只会产生与外层编辑重叠的内层编辑
      if (site) {
        edits.push(site)
        return true
      }
      return
    }
    if (n.type === 'CallExpression') {
      const callee = n.callee
      if (callee?.type === 'Identifier' && isDirectiveRef(ctx, callee.name)) {
        for (const arg of n.arguments ?? []) {
          if (thisMethodCalleeName(arg)) {
            const r = buildChain(code, methods, arg, ctx, visited, depth, [])
            if (r) edits.push({ start: arg.start, end: arg.end, text: `() => {\n${r.inner}\n}` })
          }
        }
      }
    }
  })

  if (!edits.length) return code.slice(regionNode.start, regionNode.end)
  edits.sort((a, b) => b.start - a.start)
  const base = regionNode.start
  let out = code.slice(base, regionNode.end)
  // 重叠保护（与顶层 inlineTemplateMethodsWithEdits 一致）：start 降序应用时
  // 跳过与已应用编辑重叠的条目，防止源码被静默拼接损坏
  let lastStart = Number.POSITIVE_INFINITY
  for (const e of edits) {
    if (e.end > lastStart) continue
    out = out.slice(0, e.start - base) + e.text + out.slice(e.end - base)
    lastStart = e.start
  }
  return out
}

/** 回调体 site：整只箭头替换为「原形参 + prelude 注入块体」形态 */
function arrowSite(
  code: string,
  methods: Map<string, MethodInfo>,
  fn: any,
  ctx: ImportCtx,
  visited: Set<string>,
  depth: number,
  outerNames?: ReadonlySet<string>,
): Edit | null {
  // 仅限箭头函数 site（见 inlineRegion 注释：FunctionExpression 改写会丢
  // thisArg / arguments 语义）
  if (fn.type !== 'ArrowFunctionExpression') return null
  const body = fn.body
  if (!body || fn.async || fn.generator) return null
  const existing: string[] = (fn.params ?? []).map((p: any) => code.slice(p.start, p.end))
  // 碰撞白名单必须收**全部绑定名**：解构（`({row})`）/默认值/rest 形参的绑定
  // 不在 `p.name` 上，漏收会让 prelude 注入与之重名 → 重复声明 SyntaxError
  const boundNames = new Set<string>()
  for (const p of fn.params ?? []) collectPatternNames(p, boundNames)
  const names = [...(outerNames ?? []), ...boundNames]

  let callNode: any = null
  if (body.type !== 'BlockStatement') {
    if (thisMethodCalleeName(body)) callNode = body
  } else {
    const stmts: any[] = body.body ?? []
    if (stmts.length === 1 && stmts[0].type === 'ReturnStatement') {
      const arg = unwrapExpr(stmts[0].argument)
      if (arg && thisMethodCalleeName(arg)) callNode = arg
    }
  }
  if (!callNode) return null
  const r = buildChain(code, methods, callNode, ctx, visited, depth, names)
  if (!r) return null
  const params = existing.join(', ')
  return { start: fn.start, end: fn.end, text: `(${params}) => {\n${r.inner}\n}` }
}

/**
 * 入口：扫描模块内所有含 render() 的 class，把 render 体（含嵌套回调/指令实参）
 * 里的 this 方法调用按形状内联。
 *
 * 返回**改写后的源码**与**原始坐标下的非重叠编辑**（升序）。调用方保留原始
 * 源码坐标，用于诊断/sourcemap 映射，并把编辑交给 MagicString 统一应用。
 */
export function inlineTemplateMethodsWithEdits(
  code: string,
  parsed: ParsedFile,
): { code: string; edits: Edit[] } {
  // compelem 本体绑定表（含 dev 形态 '../src/index' 与改名导入）+ h 的本地别名集合
  // （`const h2 = h` 级别名不做，v1 仅 import 绑定）
  const compelem = collectCompelemImports(parsed.imports)
  const hLocals = new Set<string>()
  for (const [local, imported] of compelem) {
    if (imported === 'h') hLocals.add(local)
  }
  const ctx: ImportCtx = { hLocals, compelem }
  if (!hLocals.size) return { code, edits: [] }

  const classes: any[] = []
  walk(parsed.program, (n) => {
    if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') classes.push(n)
  })

  const edits: Edit[] = []
  for (const cls of classes) {
    const methods = collectMethods(cls)
    const render = methods.get('render')
    if (!render || !render.bodyNode || render.bodyNode.type !== 'BlockStatement') continue
    // render 体内：回调体 site + 指令实参 site（直接编辑入列；嵌套 site 由
    // inlineRegion 在方法模板替换文本内递归处理）
    edits.push(...collectRenderEdits(code, methods, render.bodyNode, ctx))
  }
  if (!edits.length) return { code, edits: [] }

  edits.sort((a, b) => b.start - a.start)
  const applied: Edit[] = []
  let out = code
  let lastStart = Number.POSITIVE_INFINITY
  for (const e of edits) {
    if (e.end > lastStart) continue // 重叠保护（site 互不嵌套，防御性跳过）
    out = out.slice(0, e.start) + e.text + out.slice(e.end)
    applied.push(e)
    lastStart = e.start
  }
  applied.sort((a, b) => a.start - b.start)
  return { code: out, edits: applied }
}

/** 兼容旧 API：只返回改写后的源码。compile.ts 用 WithEdits 版本保留坐标映射。 */
export function inlineTemplateMethods(code: string, parsed: ParsedFile): string {
  return inlineTemplateMethodsWithEdits(code, parsed).code
}

/** render 体内的顶层 site 收集 */
function collectRenderEdits(
  code: string,
  methods: Map<string, MethodInfo>,
  renderBody: any,
  ctx: ImportCtx,
): Edit[] {
  const edits: Edit[] = []
  walk(renderBody, (n) => {
    // 已入列编辑的区间内不再下钻（同 inlineRegion：外层编辑整体替换该区间，
    // 内层再入列会产生重叠编辑）
    if (typeof n.start === 'number' && typeof n.end === 'number') {
      if (edits.some((e) => n.start >= e.start && n.end <= e.end)) return true
    }
    // site 仅限箭头函数（FunctionExpression 改写会丢 thisArg / arguments 语义）
    if (n.type === 'ArrowFunctionExpression') {
      const e = arrowSite(code, methods, n, ctx, new Set(), 0)
      if (e) {
        edits.push(e)
        return true // site 命中后不下钻该子树
      }
      return
    }
    if (n.type === 'CallExpression') {
      const callee = n.callee
      if (callee?.type === 'Identifier' && isDirectiveRef(ctx, callee.name)) {
        for (const arg of n.arguments ?? []) {
          if (thisMethodCalleeName(arg)) {
            const r = buildChain(code, methods, arg, ctx, new Set(), 0, [])
            if (r) edits.push({ start: arg.start, end: arg.end, text: `() => {\n${r.inner}\n}` })
          }
        }
      }
    }
  })
  return edits
}
