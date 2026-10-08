/**
 * buildTemplate codegen：模板节点树 IR → 生成的 DOM 构建函数源码。
 *
 * 生成物形态（docs/TEMPLATE-CODEGEN.md §2）——两条路径：
 *
 * 1. **innerHTML 快路径（默认，canUseInnerHTML 判定）**：
 *    编译期把树序列化为 HTML 串（template-html.ts），运行时
 *    `template.innerHTML = "..."` 一次性建树，再由通用 walk 文档序收集 nodes
 *    并对变量文本做 split（对齐 emitText 的 trim/丢空语义）。body 只含
 *    ee/tc 行 + walk + ups 字面量——无逐点 createElement。
 * 2. **createElement 路径（风险树回退 / forceCreate）**：
 *    `const d = document; const f = d.createDocumentFragment(); ...`
 *    逐点 createElement / createTextNode / appendChild / ee[sn] = [...]。
 *
 * 两路径的 nodeSn 编号、ups、emptyEvents、nodes 顺序完全一致（契约不变）。
 *
 * - **零依赖**：只用 document 全局与字面量，不 import compelem 内部类。
 * - 以普通函数生成，运行时以 `buildTemplate.call(首实例)` 调用 —— `this` 用于
 *   首实例求值（首实例冻结语义）。
 * - nodeSn 由生成器在输出树上按文档序静态编号（元素 + 文本；注释不计号，
 *   即 SHOW_ELEMENT|SHOW_TEXT 过滤）。
 * - `nodes` 与 nodeSn 同步 push（创建即入列，父先于子），运行时可 O(1) 取
 *   `nodes[sn]`，免去 cloneNode + collectNodes 回扫。
 * - `ups` 为 body 末尾一次性字面量（免逐点 `ups.push` 调用）。
 * - varIndex 为 upm 序。
 */
import { COMpelem_DIRECTIVES } from '../analyze/render-body'
import type { TemplateVarInfo } from '../analyze/template-extract'
import {
  PLACEHOLDER,
  SVG_NS,
  splitParts,
  type TAttr,
  type TElement,
  type TNode,
  type TVarPart,
} from '../analyze/template-tree'
import { camelCase, kebabCase, snakeCase } from 'myfx'
import { canUseInnerHTML, serializeTemplateHTML } from './template-html'

const J = JSON.stringify
const BUILTIN_DIRECTIVES = COMpelem_DIRECTIVES

export interface CodegenOptions {
  className: string
  /** 已注册 CompElem 标签（小写）—— SLOT 判定与 prop 位置校验 */
  knownTags: Set<string>
  /** 强制 createElement 路径（默认走 innerHTML 快路径，风险树自动回退） */
  forceCreate?: boolean
}

export interface CodegenResult {
  /** 生成函数源码（`function() {...}`）；errors 非空时为 null */
  code: string | null
  errors: string[]
  /** 与 ups.push 序一致的描述符数组（供 pointEffects codegen 消费）；errors 非空时为 undefined */
  ups?: UpOut[]
  /** nodeSn → 节点名（元素为 tag、文本为 '#text'），与运行时 nodes 数组同序；errors 非空时为 undefined */
  nodeNames?: string[]
  /** 构建路径：html = template.innerHTML 一次性建树；create = 逐点 createElement（风险回退） */
  mode?: 'create' | 'html'
}

const NAME_TOKEN_RE = new RegExp(`^${PLACEHOLDER}(\\d+)$`)

/** 生成的 UpdatePoint 描述符（与运行时 UpdatePointMeta 字段同构）。 */
export interface UpOut {
  varIndex: number
  nodeSn: number
  slotNodeSn?: number
  /**
   * 本 up 在 `ups` 数组里的下标 —— **运行时需要**。
   *
   * `renderTemplate` 是按「node × 该 node 的 upms」遍历的，不是线性扫 `ups`，
   * 所以要拿到某个 up 在 `fx`（与 ups 1:1 的工厂数组）里的位置，必须显式带索引。
   * Q2 若把元数据整体挂到工厂上，这个字段会被 `ups: [{ pe }]` 的精简形态取代。
   */
  ux?: number
  attrName?: string
  attrTmpl?: string
  isPureTmpl?: boolean
  isText?: boolean
  isDirective?: boolean
  directiveType?: string
  /** 指令真名（forEach/ifTrue/show/...）。directiveType 只是锚点类型（text|slot），
   *  不能用来判断指令种类——之前 render-effect 正是因此把所有结构指令都判成未知。 */
  directiveName?: string
  isProp?: boolean
  isToggleProp?: boolean
  isEvent?: boolean
  isRef?: boolean
  isRefAttr?: boolean
  /** TAG 指令的 this 链全前缀路径（运行时 varChain 空时回退） */
  directiveVarChain?: string[]
}

interface Ctx {
  L: string[]
  nodeSn: number
  varIndex: number
  tmp: number
  slotStack: number[]
  errors: string[]
  vars: TemplateVarInfo[]
  opts: CodegenOptions
  /** 与 ups.push 同序的描述符收集（供 pointEffects codegen） */
  ups: UpOut[]
  /** nodeSn → 节点名（下标 = sn，与 nodes 数组同序） */
  nodeNames: string[]
  /** innerHTML 快路径（序列化进 HTML 串，body 只发射 ee/tc 行与 walk） */
  html: boolean
  /**
   * nodeSn → 从 fragment 根到该节点的 childNodes 下标链（编译期静态计算）。
   *
   * html 与 create 两条建树路径的**最终** DOM 结构一致，故路径唯一：html 快路径的
   * 文本占位符拆分（walkSplitText）产出的分段数，与 emitText 的 nodeSn 分配严格一一对应。
   * 只有 `needed` 集合里的路径会进产物（其余编译期丢弃，避免产物膨胀）。
   */
  paths: Map<number, number[]>
  /**
   * 运行时 renderTemplate 需**逐点访问**的 nodeSn（A+B）：有 up 的节点、有 emptyEvents
   * 的节点、CompElem / `<slot>` 结构节点、被 up 引用的 slotNodeSn。
   * 产物里发射为同序的 `updateSns` + `updatePaths`；运行时只遍历它，免去对全部节点做
   * `upmMap[nodeSn]` 查表，也免去对整棵克隆树 collectNodes 回扫。
   */
  needed: Set<number>
}

function err(ctx: Ctx, msg: string) {
  ctx.errors.push(`[${ctx.opts.className}] ${msg}`)
}

function lowerName(ctx: Ctx, el: TElement, name: string): string {
  return el.ns === 'html' ? name.toLowerCase() : name
}

function varPartsOf(a: TAttr): TVarPart[] {
  return a.parts.filter((p): p is TVarPart => p.type === 'var')
}

/** attrTmpl：token 保留 Template 序编号（编号无语义影响）。 */
function attrTmplOf(a: TAttr): string {
  return a.parts.map(p => (p.type === 'static' ? p.text : PLACEHOLDER + p.index)).join('')
}

export function generateBuildTemplate(
  root: TNode[],
  vars: TemplateVarInfo[],
  opts: CodegenOptions,
): CodegenResult {
  const html = !opts.forceCreate && canUseInnerHTML(root)
  const ctx: Ctx = {
    L: [],
    nodeSn: 0,
    varIndex: 0,
    tmp: 0,
    slotStack: [],
    errors: [],
    vars,
    opts,
    ups: [],
    nodeNames: [],
    html,
    paths: new Map(),
    needed: new Set(),
  }

  const rootPath: number[] = []
  const rootSib = { i: 0 }
  for (const nd of root) emitNode(ctx, nd, 'f', rootPath, rootSib)

  if (ctx.errors.length) return { code: null, errors: ctx.errors }

  // U3：ups 收集完毕后一次性字面量折叠
  const upsFields = ctx.ups.map(serializeUp)
  // A+B：按「需访问的 nodeSn 升序」发射 updateSns + 同序 updatePaths（运行时 resolvePath 解析）。
  const sns = [...ctx.needed].sort((a, b) => a - b)
  const updateSnsField = `const updateSns = [${sns.join(', ')}];`
  const updatePathsField = `const updatePaths = [${sns.map(sn => `[${(ctx.paths.get(sn) ?? []).join(', ')}]`).join(', ')}];`
  const bodyLines = [...ctx.L]
  if (html) bodyLines.push(...WALK_LINES)
  bodyLines.push(`const ups = [${upsFields.join(', ')}];`)
  bodyLines.push(updateSnsField)
  bodyLines.push(updatePathsField)
  const body = bodyLines.map(l => '    ' + l).join('\n')
  //U6：document 别名提升到函数头（每实例一次，节点创建免全局对象属性链查找）
  const ret = `  return { fragment: f, ups: ups, emptyEvents: ee, nodes: nodes, updateSns: updateSns, updatePaths: updatePaths };\n}`
  const code = html
    ? `function() {
  const d = document;
  const t = d.createElement('template');
  t.innerHTML = ${J(serializeTemplateHTML(root))};
  const f = t.content;
  const ee = {};
  const nodes = [];
${body}
${ret}`
    : `function() {
  const d = document;
  const f = d.createDocumentFragment();
  const ee = {};
  const nodes = [];
${body}
${ret}`
  return { code, errors: [], ups: ctx.ups, nodeNames: ctx.nodeNames, mode: html ? 'html' : 'create' }
}

/**
 * innerHTML 快路径的文本拆分 + 文档序收集。
 *
 * 这段约 1.2 KB 的自包含 walk 若**逐模板内联**生成（主模板 + 每个子模板各一份），
 * 是产物体积最大的单项浪费（实测 10 组件 × 3 子模板 = 20 份完全相同、minifier 无法去重的
 * 函数体，合计占产物 34.5%）。故提到运行时 `render.ts` 的 `walkSplitText`，
 * 产物只剩一行调用。
 *
 * `buildTemplate` / `subViews[id].buildTemplate` 均以 `.call(component)` 调用，
 * 故 `this` 恒为组件实例，用实例方法 `_ceWalkSplit` 转发，产物无需引入自由标识符。
 *
 * ⚠️ 位置敏感：walk 必须排在 `ups` 字面量折叠之前、且 push 序与编译期分配的 `nodeSn`
 * 严格一一对应（这是 `canUseInnerHTML` 保守性的依据）。改动请勿调整调用位置。
 */
const WALK_LINES: string[] = ['this._ceWalkSplit(f, nodes);']

// ---------- 节点发射 ----------

function emitNode(ctx: Ctx, nd: TNode, parentVar: string, parentPath: number[], sib: { i: number }) {
  if (nd.type === 'element') emitElement(ctx, nd, parentVar, parentPath, sib)
  else if (nd.type === 'text') emitText(ctx, nd, parentVar, parentPath, sib)
  else emitComment(ctx, nd, parentVar, parentPath, sib)
}

function emitComment(ctx: Ctx, nd: { type: 'comment'; text: string }, parentVar: string, _parentPath: number[], sib: { i: number }) {
  // 注释不计 nodeSn、不入 nodes（按元素/文本过滤），但**占一个 childNodes 位**
  // （html 串里保留 → 解析后仍在原位；create 路径同样 appendChild 一个注释节点）
  sib.i++
  // html 模式：注释已序列化进 HTML 串，无需创建行（parentVar 未用）
  if (ctx.html) return
  ctx.L.push(`${parentVar}.appendChild(d.createComment(${J(nd.text)}));`)
}

function emitElement(ctx: Ctx, el: TElement, parentVar: string, parentPath: number[], sib: { i: number }) {
  const idx = sib.i
  sib.i = idx + 1
  const sn = ctx.nodeSn++
  ctx.nodeNames.push(el.tag)
  const myPath = parentPath.concat(idx)
  ctx.paths.set(sn, myPath)

  // isCompElemNode 判定先于属性处理 → CompElem 自身的属性 up 也带 slotNodeSn（=自身 nodeSn）
  const isComp = ctx.opts.knownTags.has(el.tag.toLowerCase())
  if (isComp) ctx.slotStack.push(sn)
  // B：CompElem / <slot> 需在渲染期注册 wrapper / 绑定插槽 —— 即使该节点没有任何 up。
  // 自定义元素名必含 `-`（customElements.define 的硬约束），故 `-` 判定独立于 knownTags，
  // 覆盖「未被编译器登记但运行时已注册」的跨包标签；多余命中由运行时的 isCompElemNode 过滤。
  if (isComp || el.tag.indexOf('-') >= 0 || el.tag.toLowerCase() === 'slot') ctx.needed.add(sn)

  const childSib = { i: 0 }
  if (ctx.html) {
    // 元素已在 HTML 串中：只走编号/属性 up 收集，不发射创建与 append 行
    for (const a of el.attrs) emitAttr(ctx, el, a, sn, '')
    for (const c of el.children) emitNode(ctx, c, parentVar, myPath, childSib)
    if (isComp) ctx.slotStack.pop()
    return
  }

  const v = `n${ctx.tmp++}`
  const create =
    el.ns === 'svg'
      ? `d.createElementNS(${J(SVG_NS)}, ${J(el.tag)})`
      : `d.createElement(${J(el.tag)})`
  ctx.L.push(`const ${v} = ${create};`)
  ctx.L.push(`nodes.push(${v});`)

  for (const a of el.attrs) emitAttr(ctx, el, a, sn, v)

  ctx.L.push(`${parentVar}.appendChild(${v});`)

  for (const c of el.children) emitNode(ctx, c, v, myPath, childSib)
  if (isComp) ctx.slotStack.pop()
}

function emitText(ctx: Ctx, nd: { type: 'text'; raw: string; parts: any[] }, parentVar: string, parentPath: number[], sib: { i: number }) {
  const hasVar = nd.parts.some((p: any) => p.type === 'var')

  // 无插值：原样保留（含纯空白；parts<2 → 原样保留但占号）
  if (!hasVar) {
    const sn = ctx.nodeSn++
    ctx.nodeNames.push('#text')
    ctx.paths.set(sn, parentPath.concat(sib.i++))
    if (ctx.html) return
    const v = `n${ctx.tmp++}`
    ctx.L.push(`const ${v} = d.createTextNode(${J(nd.raw)});`)
    ctx.L.push(`nodes.push(${v});`)
    ctx.L.push(`${parentVar}.appendChild(${v});`)
    return
  }

  // 有插值：整体 trim 后分裂（静态片段 trim、空白片段丢弃、占位符为空文本节点）。
  // 每个分段占一个 childNodes 位；分段数与运行时 walkSplitText 严格一致（见 canUseInnerHTML 契约）。
  const whole = nd.raw.trim()
  const parts = splitParts(whole)

  for (const p of parts) {
    if (p.type === 'static') {
      const t = p.text.trim()
      if (!t) continue
      const sn = ctx.nodeSn++
      ctx.nodeNames.push('#text')
      ctx.paths.set(sn, parentPath.concat(sib.i++))
      if (ctx.html) continue
      const v = `n${ctx.tmp++}`
      ctx.L.push(`const ${v} = d.createTextNode(${J(t)});`)
      ctx.L.push(`nodes.push(${v});`)
      ctx.L.push(`${parentVar}.appendChild(${v});`)
      continue
    }
    // 占位符
    const sn = ctx.nodeSn++
    ctx.nodeNames.push('#text')
    ctx.paths.set(sn, parentPath.concat(sib.i++))
    if (!ctx.html) {
      const v = `n${ctx.tmp++}`
      ctx.L.push(`const ${v} = d.createTextNode('');`)
      ctx.L.push(`nodes.push(${v});`)
      ctx.L.push(`${parentVar}.appendChild(${v});`)
    }
    const info = ctx.vars[p.index]
    if (!info) {
      err(ctx, `插值槽 #${p.index} 未声明（内部错误）`)
      continue
    }
    const up: UpOut = { varIndex: ctx.varIndex++, nodeSn: sn, isText: true }
    if (info.isDirectiveCall) {
      up.isDirective = true
      // directiveType 必须与运行时 EnterPointType 枚举值一致（小写）
      up.directiveType = ctx.slotStack.length ? 'slot' : 'text'
      // 指令真名单独记录：directiveType 只是锚点类型，render-effect 需要真名来分派
      up.directiveName = info.directiveName
      if (ctx.slotStack.length) up.slotNodeSn = ctx.slotStack[ctx.slotStack.length - 1]
    }
    pushUp(ctx, up)
  }
}

// ---------- 属性发射（判定顺序见 CODEGEN §3.2） ----------

function emitAttr(ctx: Ctx, el: TElement, a: TAttr, sn: number, elVar: string) {
  const name = a.name
  const vps = varPartsOf(a)

  // 1. 标签位指令（属性名整体为占位符）
  const tok = NAME_TOKEN_RE.exec(name)
  if (tok) {
    const info = ctx.vars[+tok[1]]
    if (!info) { err(ctx, `插值槽 #${tok[1]} 未声明`); return }
    if (!info.isDirectiveCall) {
      // 自定义指令（directive() 工厂产物）：callee 是模块绑定的函数调用，extract 已记 moduleBindingName。
      // 若连模块绑定都不是（如表达式非直接 Identifier 调用），按字面量形态兜底放行 identifier(...)。
      if (!info.moduleBindingName && !/^[A-Za-z_$][\w$]*\s*\(/.test(info.exprSource.trim())) {
        err(ctx, `标签位插值 \${${info.exprSource}} 必须是指令调用（bind/show/classes/styles/model 等），` +
          `否则运行时 varIndex 将错位`)
        return
      }
    }
    const up: UpOut = { varIndex: ctx.varIndex++, nodeSn: sn, isDirective: true, directiveType: 'tag' }
    // directiveName 是 render-effect 判分派/结构性的唯一依据，缺了它 TAG 位指令会退化成
    // `rc._execDir("", …)`，且在**子模板**里 isStructural 判定恒假 → 该点不生成任何语句。
    if (info.directiveName) up.directiveName = info.directiveName
    else if (info.moduleBindingName) up.directiveName = info.moduleBindingName
    if (info.directiveVarChain && info.directiveVarChain.length) up.directiveVarChain = info.directiveVarChain
    if (ctx.slotStack.length) up.slotNodeSn = ctx.slotStack[ctx.slotStack.length - 1]
    pushUp(ctx, up)
    return
  }

  // 2. slot-props：内部保留属性，忽略
  if (name === 'slot-props') {
    if (vps.length) err(ctx, `slot-props 不允许插值`)
    return
  }

  // 3. 事件
  if (name[0] === '@') {
    if (vps.length === 1) {
      const info = ctx.vars[vps[0].index]
      if (info?.isDirectiveCall) {
        err(ctx, `事件 ${name} 的插值不应是指令调用`)
        return
      }
      const up: UpOut = { varIndex: ctx.varIndex++, nodeSn: sn, isEvent: true, attrName: lowerName(ctx, el, name.slice(1)) }
      pushUp(ctx, up)
      return
    }
    if (vps.length === 0) {
      if ((a.value ?? '').trim() === '') {
        const ev = lowerName(ctx, el, name.slice(1))
        ctx.L.push(`(${eeGet(ctx, sn)}).push(${J(ev)});`)
        return
      }
      err(ctx, `事件 ${name} 的静态值会被丢弃（legacy 行为），请绑定函数`)
      return
    }
    err(ctx, `事件 ${name} 的值最多一个插值`)
    return
  }

  // 4. ref
  if (name === 'ref') {
    if (vps.length === 1) {
      const up: UpOut = { varIndex: ctx.varIndex++, nodeSn: sn, isRef: true }
      pushUp(ctx, up)
      return
    }
    err(ctx, `静态 ref="${a.value ?? ''}" 会被 legacy 静默丢弃；请使用 createRef 绑定`)
    return
  }

  // 5. 尾点属性（propPerfix，跨框架兼容）：不产生 up、不消耗槽
  if (name.endsWith('.')) {
    if (vps.length) err(ctx, `尾点属性 ${name} 的插值在 legacy 中不消耗槽位（会引发 varIndex 错位），不支持`)
    return
  }

  // 6. 带插值的属性
  if (vps.length === 1) {
    const info = ctx.vars[vps[0].index]
    // 仅拒绝内置指令误用在属性值位；自定义指令/普通模块函数调用（map/format 等）是合法值表达式
    if (info?.isDirectiveCall && info.directiveName && BUILTIN_DIRECTIVES.has(info.directiveName)) {
      err(ctx, `属性 ${name} 的插值 \${${info.exprSource}} 是指令调用，但该位置只接受值；指令应写在标签位 <el \${...}>`)
      return
    }
    const up: UpOut = { varIndex: ctx.varIndex++, nodeSn: sn }
    if (ctx.slotStack.length) up.slotNodeSn = ctx.slotStack[ctx.slotStack.length - 1]
    if (name[0] === '.') {
      // prop：目标必须是已注册 CompElem（或 <slot>）
      if (!ctx.opts.knownTags.has(el.tag.toLowerCase()) && el.tag.toLowerCase() !== 'slot') {
        err(ctx, `Prop ${name} 只能设置在 CompElem 或 <slot> 上（<${el.tag}> 未注册）`)
      }
      up.isProp = true
      up.attrName = name.slice(1)
    } else if (name[0] === '?') {
      up.isToggleProp = true
      up.attrName = lowerName(ctx, el, name.slice(1))
    } else if (name[0] === '*') {
      // refAttr：*name[:camel|:kebab|:snake]
      const spec = lowerName(ctx, el, name.slice(1))
      const colon = spec.indexOf(':')
      const refName = colon < 0 ? spec : spec.slice(0, colon)
      const fmt = colon < 0 ? '' : spec.slice(colon + 1)
      let converted = refName
      if (fmt === 'camel') converted = camelCase(refName)
      else if (fmt === 'kebab') converted = kebabCase(refName)
      else if (fmt === 'snake') converted = snakeCase(refName)
      else if (fmt !== '') err(ctx, `*${name.slice(1)} 的格式后缀仅支持 :camel/:kebab/:snake，收到 ':${fmt}'`)
      up.isRefAttr = true
      up.attrName = converted
    } else {
      up.attrName = lowerName(ctx, el, name)
      up.attrTmpl = attrTmplOf(a)
      // isPureTmpl：value === PLACEHOLDER + varIndex（upm 序严格相等）
      up.isPureTmpl = a.parts.length === 1 && vps[0].index === up.varIndex
    }
    pushUp(ctx, up)
    return
  }
  if (vps.length > 1) {
    err(ctx, `属性 ${name} 的值最多一个插值`)
    return
  }

  // 7. 纯静态属性
  if (name[0] === '.' || name[0] === '?' || name[0] === '*') {
    err(ctx, `前缀属性 ${name} 不允许静态值（无插值）；legacy 中该属性会被原样残留在 DOM`)
    return
  }
  // html 模式：静态属性已序列化进 HTML 串（不产生创建期 setAttribute 行）
  if (ctx.html) return
  ctx.L.push(`${elVar}.setAttribute(${J(el.ns === 'html' ? name.toLowerCase() : name)}, ${J(a.value ?? '')});`)
}

function eeGet(ctx: Ctx, sn: number): string {
  // B：空事件写法（`@ev` 无值）的节点没有任何 up，但渲染期需注册 noop 监听 → 必须进 updateSns 表。
  ctx.needed.add(sn)
  return `ee[${sn}] ?? (ee[${sn}] = [])`
}

function pushUp(ctx: Ctx, up: UpOut) {
  up.ux = ctx.ups.length
  ctx.ups.push(up)
  // B：有 up 的节点（及其 slotNodeSn 锚点）必须在运行时被逐点访问。
  ctx.needed.add(up.nodeSn)
  if (up.slotNodeSn !== undefined && up.slotNodeSn > -1) ctx.needed.add(up.slotNodeSn)
}

/**
 * **仅供编译期消费、运行时从不读取**的 up 字段 —— 不写进 `ups` 字面量。
 *
 * `directiveName`：render-effect 靠它区分结构指令 / 判 show/classes/… 形态，但那是在
 *   codegen 阶段读 `UpOut` 对象本身（同一进程内），产物里的 `ups` 用不到 ——
 *   compelem 运行时对 `directiveName` 的引用数为 **0**。
 *
 * 该键名长且**不会被 minifier 压缩**（对象字面量键在产物里是数据）。
 *
 * 注：`isPureTmpl` 同样是运行时未读字段，但它属于 `ups` 的既有形状契约
 * （template-codegen-e2e 的 A7/A8/C3/H4 断言它），此处保留。
 */
const CODEGEN_ONLY_UP_KEYS = new Set(['directiveName'])

/**
 * 单个 up 描述符 → 对象字面量源码。
 *
 * **`ux` / `varIndex` 恒等于该条目在 `ups` 数组里的下标**（`ux` 由 `pushUp` 写
 * `ctx.ups.length`，`varIndex` 由 `ctx.varIndex++`，两者与 push 严格配对），因此
 * 这两个字段是纯冗余 —— 全量实测 145/145 条成立。省掉它们可减产物约 4%。
 *
 * **自守卫**：只在 `=== idx` 时才省，一旦哪天不变量被破坏（例如将来出现不经过
 * `pushUp` 的 ups 路径），就显式写出，不会静默错位。运行期
 * `hydrateBuiltTemplate` 按下标回填，对**显式带值**的产物同样兼容。
 */
function serializeUp(up: UpOut, idx: number): string {
  const fields = Object.entries(up)
    .filter(([k, v]) => {
      if (v === undefined || CODEGEN_ONLY_UP_KEYS.has(k)) return false
      // 恒等于下标的两个字段：剔除（renderTemplate 用 `fx[upm.ux]`、
      // UpdatePoint 构造用 `upm.varIndex`，两者都在 hydrate 时由下标补齐）
      if (k === 'ux') return up.ux !== idx
      if (k === 'varIndex') return up.varIndex !== idx
      return true
    })
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v : J(v)}`)
  return `{ ${fields.join(', ')} }`
}
