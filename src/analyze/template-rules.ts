/**
 * 模板层约定规则：模板树 + 插值表达式源码 → 编译期诊断。
 *
 * 编译期覆盖以下约定检查：
 *   E-PROP-INTERP   .prop 的值必须是插值
 *   E-MUTATE-MODIFIER  @mutate 必须带 attr/child/char/tree 类型修饰符
 *   E-EVENT-FN      事件处理器必须是函数/成员
 *   E-EVENT-MODIFIER  非键盘事件上出现了不会生效的修饰符（运行期会被当成按键名过滤）
 *   E-REF-TYPE      ref 必须绑定 createRef() 结果
 *   E-DIRECTIVE-SCOPE  指令只能出现在允许的位置
 *   E-FOREACH-KEY   forEach 的 keyFn 必须是函数（运行期无条件 keyFn.call）
 *   E-MODEL-CHAIN   model() 的实参必须能解析出 this 写回路径
 *   W-EVENT-NO-HANDLER  @event 无插值 → 监听器为空（运行期注册 noop）
 *   W-EVENT-COMP-MODIFIER  组件事件上使用了该通道不支持的修饰符
 *
 * 其余同类运行时检查的编译期覆盖：
 *   - 动态根元素（vars.length != updatePointMetas.length）的三个触发条件
 *     （注释内插值 / 属性多插值 / 标签名插值）→ template-tree.ts 硬错误
 *
 * 无法静态判定的表达式形态（外部标识符、动态访问、未知基类成员）一律放行 —— 宁漏勿误报。
 * 错误定位统一挂在模板字面量整体（start/end = 模板源码区间），明细在 message 中。
 */
import type { ComponentAnalysis } from '../types'
import { decoratorName, isCustomTag, keyName, superClassName, thisChain, THIS_MEMBER_RE } from '../utils/ast'
import type { TemplateTree, TElement, TNode } from './template-tree'
import type { MainTemplate, TemplateVarInfo } from './template-extract'
import type { ConventionsContext } from './conventions'
import { bodyReturnsTemplate, unwrapTsExpr } from './conventions'
import { collectTemplateTagAliases } from './template'

/** knownTags 缺省（无同文件 @tag 登记）时的空集——isCustomTag 需要恒有 .has。 */
const EMPTY_TAG_SET: ReadonlySet<string> = new Set<string>()

export interface TemplateRuleError {
  start: number
  end: number
  message: string
  /** 'warn'：提示级（合法但运行期静默失效），走 console.warn，不阻断构建。缺省 error。 */
  severity?: 'warn'
}


/** 指令允许的插入位置（EnterPointType 值，小写）。 */
const DIRECTIVE_SCOPES: Record<string, string[]> = {
  bind: ['tag'],
  show: ['tag'],
  model: ['tag'],
  classes: ['tag'],
  styles: ['tag'],
  forEach: ['text', 'slot'],
  ifTrue: ['text', 'slot'],
  ifElse: ['text', 'slot'],
  when: ['text', 'slot'],
  slot: ['slot'],
  html: ['tag', 'text', 'slot'],
}

/** @mutate 必需的变异类型修饰符（任一即可，对齐运行期 extends.ts addMutation 的 slots 判定）。 */
const MUTATE_TYPE_MODS = new Set(['attr', 'child', 'char', 'tree'])

/**
 * 事件修饰符分类 —— 逐项对齐运行期 `events/event.ts`：
 *
 * - `EVENT_PLAIN_MODS`：`parseModifiers` 里的 `MODI_EV_NON_KEY_TOKENS`，**不会**被当成按键名；
 * - `EVENT_FLOW_MOD_RE`：`debounce` / `debounce:100` / `throttle` / `throttle:100`；
 * - 其余 token 一律按 `KeyboardEvent.key` 过滤（`checkKeys`），因此在**非键盘事件**上
 *   永远匹配不到（`e.key === undefined`）⇒ 监听器恒不触发，属于必须拦的写法。
 */
const EVENT_PLAIN_MODS: ReadonlySet<string> = new Set([
  'self', 'stop', 'prevent', 'once', 'capture', 'passive',
  'left', 'right', 'middle', 'ctrl', 'alt', 'shift', 'meta',
])
const EVENT_FLOW_MOD_RE = /^(debounce|throttle)(:\d+)?$/

/**
 * 键盘类事件：其余 token 在这类事件上是**合法键名**（`@keydown.a`），不做取值枚举校验
 * （`KeyboardEvent.key` 取值域太大，逐一列举只会误报）。
 */
const KEY_EVENTS: ReadonlySet<string> = new Set(['keydown', 'keyup', 'keypress'])

/**
 * **原生 DOM 事件名**白名单 —— E-EVENT-MODIFIER 只对这些名字判定修饰符词表。
 *
 * 为什么必须收窄到原生事件：自定义事件（尤其是 `extends.ts` 注册的**扩展事件**）
 * 会把 `parts` 原样交给自己的实现，修饰符词表由扩展事件自定义
 * （如 `@outside.mousedown`：`mousedown` 是 outside 的参数，不是按键名）。
 * 事件名不在本表 ⇒ 词表不可知 ⇒ 一律放行。
 */
const NATIVE_EVENTS: ReadonlySet<string> = new Set([
  'click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'mousemove',
  'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'wheel', 'scroll', 'scrollend',
  'focus', 'blur', 'focusin', 'focusout', 'input', 'change', 'submit', 'reset', 'select',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout',
  'pointerenter', 'pointerleave', 'pointercancel', 'gotpointercapture', 'lostpointercapture',
  'touchstart', 'touchend', 'touchmove', 'touchcancel',
  'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'drop',
  'paste', 'copy', 'cut', 'compositionstart', 'compositionend', 'compositionupdate',
  'keydown', 'keyup', 'keypress',
  'load', 'error', 'beforeunload', 'resize', 'animationstart', 'animationend',
  'animationiteration', 'transitionend', 'transitionstart', 'slotchange',
])

/**
 * 组件事件通道（`registerEvent` 第 1 分支 → `wrapControlFn(cbk, f, true)`）实际生效的修饰符。
 * `stop/prevent/self/capture/passive/鼠标/键盘` 在这一通道被整体丢弃 —— 无非空 DOM 监听器可挂。
 */
const COMP_EVENT_MODS: ReadonlySet<string> = new Set(['once'])

/**
 * CompElem 基类内置实例成员（事件绑定到它们不算错误）。
 *
 * 手工镜像，与 `F:\github\compelem\src\CompElem.ts` 逐项对应；运行期一加成员这里就要跟。
 * 少列 = 误报（把合法引用判成「不是组件成员」），多列 = 漏报，故宁可同步时多核对一遍。
 */
const KNOWN_BASE_MEMBERS = new Set([
  // 生命周期 / 框架方法
  'setup', 'propsReady', 'render', 'beforeMount', 'mounted', 'slotChange', 'afterUpdate',
  'beforeDestroyed', 'destroyed', 'destroy', 'emit', 'nextTick', 'forceUpdate', 'updateProps',
  'insertStyleSheet', 'getSubViewNodes', 'defineSignalField',
  // Web Components 回调（CompElem.ts:284 / 321 / 626）
  'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback',
  // 只读字段 / getter
  'cid', 'rootComponent', 'parentComponent', 'wrapperComponent', 'renderRoot', 'renderRoots',
  'shadowRoot', 'slots', 'slotHooks', 'cssSheets', 'globalCssSheet', 'attrs', 'props',
  'isMounted', 'isDestroyed', 'cssVars', 'tagName',
])


function collectElements(nodes: TNode[], out: TElement[]): void {
  for (const nd of nodes) {
    if (nd.type !== 'element') continue
    out.push(nd)
    collectElements(nd.children, out)
  }
}

/**
 * 沿同文件继承链收集成员名。
 * 链尾不可知（非本地类且非导入的 CompElem）→ 返回 null（无法穷尽，全部放行）。
 */
function collectMemberNames(comp: ComponentAnalysis, ctx: ConventionsContext): Set<string> | null {
  const out = new Set<string>()
  let node = comp.cls ?? ctx.localClasses.get(comp.className)
  if (!node) return null
  const seen = new Set<any>()
  while (node && !seen.has(node)) {
    seen.add(node)
    for (const m of node.body?.body ?? []) {
      const n = keyName(m.key)
      if (n) out.add(n)
    }
    const sup = superClassName(node)
    if (!sup) {
      // 无标识符基类但有 superClass 节点（mixin 调用 `extends Mixin(X)`）→ 成员不可穷尽
      if (node.superClass) return null
      break
    }
    if (ctx.localClasses.has(sup)) {
      node = ctx.localClasses.get(sup)
      continue
    }
    // 链尾：基类是导入的 CompElem → 成员空间已知（仅剩框架内置），可穷尽
    if (comp.compelemImports.get(sup) === 'CompElem') break
    return null
  }
  return out
}

/** 在继承链上找成员定义节点（PropertyDefinition / MethodDefinition），自派生类向上取首个命中。 */
function findMemberNode(
  comp: ComponentAnalysis,
  ctx: ConventionsContext,
  name: string,
): any | null {
  let node = comp.cls ?? ctx.localClasses.get(comp.className)
  const seen = new Set<any>()
  while (node && !seen.has(node)) {
    seen.add(node)
    for (const m of node.body?.body ?? []) {
      if (keyName(m.key) === name) return m
    }
    const sup = superClassName(node)
    node = sup && ctx.localClasses.has(sup) ? ctx.localClasses.get(sup) : null
  }
  return null
}

function isCreateRefCall(initNode: any, comp: ComponentAnalysis): boolean {
  return (
    initNode?.type === 'CallExpression' &&
    initNode.callee?.type === 'Identifier' &&
    comp.compelemImports.get(initNode.callee.name) === 'createRef'
  )
}

/** 内联函数形态：function 声明 / async / 箭头函数。 */
const INLINE_FN_RE = /(^function\b)|(^async\s*(?:function\b|\())|=>/

/** 不可能是双向绑定目标的节点类型（字面量 / 容器 / 运算结果 / 调用产物）。 */
const MODEL_NON_TARGET_TYPES: ReadonlySet<string> = new Set([
  'Literal', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral',
  'TemplateLiteral', 'ArrayExpression', 'ObjectExpression', 'UnaryExpression',
  'BinaryExpression', 'LogicalExpression', 'ConditionalExpression',
  'CallExpression', 'NewExpression', 'ThisExpression',
])

/** 成员链的最内层是不是 `this`（`thisChain` 为 null 时用来区分「含下标」与「非 this 根链」）。 */
function rootIsThis(node: any): boolean {
  let cur = node
  while (cur && (cur.type === 'MemberExpression' || cur.type === 'OptionalMemberExpression')) {
    cur = cur.object
  }
  return cur?.type === 'ThisExpression'
}

/** 收集节点里的字符串字面量（数组展开；模板字面量要求无插值）。动态值一律不收。 */
function literalStrings(node: any, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out
  if (node.type === 'Literal' && typeof node.value === 'string') {
    out.push(String(node.value))
    return out
  }
  if (node.type === 'ArrayExpression') {
    for (const el of node.elements ?? []) literalStrings(el, out)
    return out
  }
  if (node.type === 'TemplateLiteral' && !(node.expressions ?? []).length) {
    const s = node.quasis?.[0]?.value?.cooked
    if (typeof s === 'string') out.push(s)
  }
  return out
}

/**
 * 本文件内「自定义元素标签 → `@emits` 声明集」。
 *
 * 只收同文件类：跨文件组件的 emits 表在单文件编译里不可知（compileFile 不解析 import），
 * 拿不到就放行 —— 组件事件相关检查宁可漏报也不能误报（`@click.stop` 在组件标签上
 * 完全可能绑定的是原生 click）。
 */
function collectLocalEmits(
  comp: ComponentAnalysis,
  ctx: ConventionsContext,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const cls of ctx.localClasses.values()) {
    let tag: string | undefined
    let emits: Set<string> | undefined
    for (const dec of cls.decorators ?? []) {
      // 节点可能是 Decorator 包装，也可能直接是表达式 —— 两者都要吃（decoratorName 内部同样双通道）
      const expr = dec.expression ?? dec
      const local = decoratorName(dec)
      const imported = local ? comp.compelemImports.get(local) : undefined
      if (imported === 'tag') {
        tag = literalStrings(expr.arguments?.[0])[0]?.toLowerCase()
      } else if (imported === 'emits') {
        const list = new Set<string>()
        for (const a of expr.arguments ?? []) for (const s of literalStrings(a)) list.add(s)
        emits = list
      }
    }
    if (tag && emits) out.set(tag, emits)
  }
  return out
}

/** 对齐运行期 `matchEmit`：精确名或 `x:*` 前缀通配。 */
function matchEmitName(emits: ReadonlySet<string>, name: string): boolean {
  if (emits.has(name)) return true
  for (const e of emits) {
    if (e.endsWith(':*') && name.startsWith(e.slice(0, -1))) return true
  }
  return false
}

/** `@emits` 声明的实参能否静态解析为字符串（决定该事件名是否可信） */
function isUndefinedLike(node: any): boolean {
  if (!node) return true
  if (node.type === 'Identifier') return node.name === 'undefined'
  return node.type === 'Literal' && (node.value === null || node.value === undefined)
}

/**
 * 指令实参的静态校验（forEach keyFn / model 写回路径）。
 *
 * 与位置无关 —— 主模板与子模板（指令回调内的嵌套模板）共用本函数，
 * 故由 `checkTemplateRules`（主）和 `compile.ts`（子候选）两处分别调用。
 */
export function checkDirectiveArgs(
  vars: readonly TemplateVarInfo[],
  ctx?: ConventionsContext,
): TemplateRuleError[] {
  const errs: TemplateRuleError[] = []
  for (const v of vars) {
    if (!v.isDirectiveCall) continue
    const name = v.directiveName
    if (!name) continue
    const args: any[] = v.node?.arguments ?? []
    const pos = { start: v.start ?? 0, end: v.end ?? 0 }

    // ---- E-FOREACH-KEY：运行期无条件 `keyFn.call(...)` ----
    if (name === 'forEach') {
      const raw = args[1]
      const keyFn = raw ? unwrapTsExpr(raw) : null
      // 完整形态是 forEach(list, keyFn, tmpl)：实参不足 3 个 ⇒ keyFn 或模板必缺一个，
      // 两者都会让运行期落到「keyFn 不是函数」或「模板为 undefined」，编译期一律拦。
      const missing = args.length < 3
      const literal =
        !!keyFn &&
        (keyFn.type === 'Literal' ||
          keyFn.type === 'TemplateLiteral' ||
          keyFn.type === 'ArrayExpression' ||
          keyFn.type === 'ObjectExpression' ||
          keyFn.type === 'UnaryExpression')
      if (missing || literal || isUndefinedLike(keyFn)) {
        errs.push({
          ...pos,
          message:
            `E-FOREACH-KEY: forEach 的第二个实参必须是 key 函数（keyFn: (item, key, index) => key），` +
            `当前${missing ? `实参只有 ${args.length} 个（需要 list / keyFn / tmpl 三个）` : `为 \`${v.exprSource.slice(0, 80)}\` 的字面量`}——` +
            `运行期会直接对它调用 .call()，恒抛 TypeError`,
        })
      }
      continue
    }

    // ---- E-MODEL-CHAIN：运行期用 `varChain[last]` 作写回路径，`set(this, path, v)` ----
    if (name === 'model') {
      // 第三参 modelProp 显式给了路径：初始路径不存在时由它兜底，不再要求 this 链
      const override = args[2] ? unwrapTsExpr(args[2]) : null
      if (override) {
        const s = literalStrings(override)[0]
        const viaConst =
          override.type === 'Identifier' && ctx?.stringConsts?.get(override.name)
        if (typeof s === 'string' || typeof viaConst === 'string') continue
      }
      const arg0 = args.length ? unwrapTsExpr(args[0]) : null
      const chain = arg0 ? thisChain(arg0) : null
      const shown = v.exprSource.slice(0, 80)
      if (!arg0 || MODEL_NON_TARGET_TYPES.has(arg0.type)) {
        // 字面量 / 数组 / 对象 / 无实参：无论如何都算不出写回目标
        errs.push({
          ...pos,
          message:
            `E-MODEL-CHAIN: model() 的实参必须是 this.<字段>（或 this.<字段>.<子字段>），` +
            `当前 \`${shown}\` 根本不是可写目标——运行期以 directiveVarChain 末段作 set() 目标，` +
            `取不到时静默写不进去`,
        })
      } else if (!chain && arg0 && rootIsThis(arg0)) {
        // this 根链里含下标 / 动态访问：`this.arr[i]` 的链会整体退化成根字段，可能整块覆盖
        errs.push({
          ...pos,
          severity: 'warn',
          message:
            `W-MODEL-CHAIN: model() 的 '${shown}' 含下标 / 动态访问，编译期无法给出字段级写回路径；` +
            `运行期只能退到根字段，子项赋值可能被整体覆盖`,
        })
      } else if (chain?.some((seg) => seg.startsWith('#'))) {
        errs.push({
          ...pos,
          severity: 'warn',
          message:
            `W-MODEL-CHAIN: model() 的 '${shown}' 指向私有字段（#），` +
            `运行期用字符串路径 set() 写回，无法访问私有成员`,
        })
      }
      // 其它形态（循环项 `model(condi.color)`、外部标识符）→ 子视图写回语义未经证实，放行
      continue
    }
  }
  return errs
}

/** 对单个组件的主模板执行模板层约定检查。返回错误列表（可为空）。 */
export function checkTemplateRules(
  tree: TemplateTree,
  tmpl: MainTemplate,
  comp: ComponentAnalysis,
  ctx: ConventionsContext,
  knownTags?: Set<string>,
): TemplateRuleError[] {
  const errs: TemplateRuleError[] = []
  const pos = { start: tmpl.start, end: tmpl.end }

  const elements: TElement[] = []
  collectElements(tree.root, elements)

  const members = collectMemberNames(comp, ctx)

  // ---- 指令实参校验（forEach keyFn / model 写回路径）----
  // 与插入位置无关（只看表达式本身），故独立成段；子模板由 compile.ts 另调一次。
  errs.push(...checkDirectiveArgs(tmpl.vars, ctx))

  // 本文件组件标签 → @emits 声明集（判定「组件事件通道」用，见 W-EVENT-COMP-MODIFIER）
  const localEmits = collectLocalEmits(comp, ctx)

  // 位置映射：varIndex → 所在位置（tag=标签属性位 / text=文本插值 / slot=组件标签体内插值）
  // C1（指令位置）与 C2（文本位插 Template）共用，无条件构建。
  const varPosMap = new Map<number, 'tag' | 'text' | 'slot'>()
  for (const el of elements) {
    for (const a of el.attrs) {
      if (a.name.includes('⟬')) {
        // 属性名整体插值 = TAG 指令位
        const m = /⟬Ċ⟭(\d+)/.exec(a.name)
        if (m) varPosMap.set(+m[1], 'tag')
      }
    }
  }
  const walkText = (nodes: TNode[], inSlot: boolean) => {
    for (const nd of nodes) {
      if (nd.type === 'text') {
        for (const p of nd.parts) {
          if (p.type === 'var' && !varPosMap.has(p.index)) {
            varPosMap.set(p.index, inSlot ? 'slot' : 'text')
          }
        }
      } else if (nd.type === 'element') {
        // HTML 标签名大小写不敏感，`<Slot>` 与 `<slot>` 同义。这里必须比小写形式 ——
        // 只认 'slot' / 'SLOT' 会把 `<Slot>` 判成普通元素，其体内插值落到 'text' 位，
        // 于是 `slot()` 指令在该位置合法、却被误报 E-DIRECTIVE-SCOPE。
        // C3：自定义元素名恒含 `-`（跨包组件如 `<ui-table>` 不在本文件 knownTags 里，
        // 但其体内插值同样是 slot 位）——用 isCustomTag 统一判据，修跨包 `${slot(...)}` 误报。
        const isComp = isCustomTag(nd.tag.toLowerCase(), knownTags ?? EMPTY_TAG_SET)
        walkText(nd.children, isComp)
      }
    }
  }
  walkText(tree.root, false)

  // ---- C1: 指令插入位置校验 ----
  const directiveVars = tmpl.vars.filter((v) => v.isDirectiveCall && v.directiveName)
  for (const v of directiveVars) {
    const allowed = DIRECTIVE_SCOPES[v.directiveName!]
    if (!allowed) continue // 未知指令名（自定义指令）→ 放行
    const pos2 = varPosMap.get(v.index)
    if (pos2 && !allowed.includes(pos2)) {
      errs.push({
        ...pos,
        message:
          `E-DIRECTIVE-SCOPE: 指令 '${v.directiveName}' 只能出现在 ${allowed.join('/')} 位置，` +
          `当前在 ${pos2} 位置`,
      })
    }
  }

  // ---- C2: 文本/插槽位插值「返回 Template（子视图）的表达式」⇒ 禁止 ----
  // 子视图必须经指令（forEach/if/when）或子组件（自定义元素）实现；直接把返回 Template
  // 的本地函数插值到文本位会被字符串化成 [object Object]（见 IntroPage 旧写法）。
  // 仅针对「本文件模块级函数」——跨文件导入无法静态证明返回类型，宁漏勿误报。
  const hAliases = collectTemplateTagAliases(comp)
  const localTemplateFns = new Set<string>()
  for (const [name, fn] of ctx.moduleFunctions ?? []) {
    if (fn.annotatedTemplate || bodyReturnsTemplate(fn.node, hAliases)) localTemplateFns.add(name)
  }
  for (const v of tmpl.vars) {
    if (v.isDirectiveCall) continue
    const p2 = varPosMap.get(v.index)
    if (p2 !== 'text' && p2 !== 'slot') continue
    const expr = unwrapTsExpr(v.node)
    if (expr?.type === 'CallExpression' && expr.callee?.type === 'Identifier') {
      if (localTemplateFns.has(expr.callee.name)) {
        errs.push({
          start: v.start ?? pos.start,
          end: v.end ?? pos.end,
          message:
            `E-TEMPLATE-INTERP: 插值表达式 '${v.exprSource}' 返回 Template（子视图），` +
            `不能直接插值在文本位（会被字符串化为 [object Object]）。` +
            `请改用 forEach / if / when 指令，或将结构抽成子组件（自定义元素）。`,
        })
      }
    }
  }

  for (const el of elements) {
    for (const a of el.attrs) {
      // 属性名整体插值 = TAG 指令写法，不属于以下任何检查
      if (a.name.includes('⟬')) continue

      const varPart = a.parts.find((p) => p.type === 'var')
      const varCount = a.parts.filter((p) => p.type === 'var').length

      // ---- 事件修饰符 / 无处理器 ----
      // 运行期把「非内置 token」一律当 KeyboardEvent.key 过滤（events/event.ts:139-143）：
      // 非键盘事件上 e.key 恒 undefined ⇒ 监听器永不触发，而修饰符本身照样生效，
      // 表现为「点了没反应但也不报错」，只能靠编译期拦。
      if (a.name.startsWith('@') && !a.name.startsWith('@mutate')) {
        const segs = a.name.slice(1).split('.')
        const evName = (segs[0] ?? '').toLowerCase()
        const mods = segs.slice(1)
        const compEmits = localEmits.get(el.tag.toLowerCase())
        const isCompEvent = !!compEmits && matchEmitName(compEmits, evName)
        if (isCompEvent) {
          // 组件事件走 wrapControlFn：只有 debounce/throttle/once 生效，其余静默丢弃
          const bad = mods.filter((mo) => !COMP_EVENT_MODS.has(mo) && !EVENT_FLOW_MOD_RE.test(mo))
          if (bad.length) {
            errs.push({
              ...pos,
              severity: 'warn',
              message:
                `W-EVENT-COMP-MODIFIER: '${a.name}' 是组件事件（${el.tag} 的 @emits 已声明 '${evName}'），` +
                `运行期只应用 debounce/throttle/once，[${bad.join(', ')}] 会被静默丢弃`,
            })
          }
        } else if (!KEY_EVENTS.has(evName) && NATIVE_EVENTS.has(evName)) {
          const bad = mods.filter((mo) => !EVENT_PLAIN_MODS.has(mo) && !EVENT_FLOW_MOD_RE.test(mo))
          if (bad.length) {
            errs.push({
              ...pos,
              message:
                `E-EVENT-MODIFIER: '${a.name}' 中的 [${bad.join(', ')}] 不是内置修饰符；` +
                `运行期会把它当作 KeyboardEvent.key 过滤，而 '${evName}' 不是键盘事件 ⇒ 处理器恒不触发`,
            })
          }
        }
        // 只有**裸事件名**才是「忘了写处理器」；`@click.stop` / `@dragover.prevent` 这类
        // 无处理器写法是刻意 idiom —— 空监听器仍会执行 stopPropagation / preventDefault。
        if (varCount === 0 && mods.length === 0) {
          errs.push({
            ...pos,
            severity: 'warn',
            message:
              `W-EVENT-NO-HANDLER: '${a.name}' 没有插值处理器，运行期只注册空监听器（noop）——` +
              `是否遗漏了 \${…}？`,
          })
        }
      }

      // ---- E-PROP-INTERP：.prop 的值必须是插值（对齐 render.ts:336 的 EXP_TAG 判定）----
      if (a.name.startsWith('.') && varCount === 0) {
        errs.push({
          ...pos,
          message:
            `E-PROP-INTERP: Prop '${a.name}' 必须是插值（.foo="${'$'}{expr}"）；` +
            `静态值请直接写属性或改用 bind 指令`,
        })
        continue
      }

      // ---- E-MUTATE-MODIFIER：@mutate 必须带类型修饰符（对齐 extends.ts addMutation）----
      // 必须放在 E-EVENT-FN 之前：事件属性带单插值时那条规则的 continue 会截断本检查
      if (a.name.startsWith('@mutate')) {
        const mods = a.name.slice(1).split('.').slice(1)
        if (!mods.some((mo) => MUTATE_TYPE_MODS.has(mo))) {
          errs.push({
            ...pos,
            message:
              `E-MUTATE-MODIFIER: 事件 '${a.name}' 缺少变异类型修饰符，` +
              `必须使用 @mutate.attr/child/char/tree 之一（裸 @mutate 运行期无法 observe）`,
          })
        }
      }

      // ---- E-EVENT-FN：事件处理器必须是函数 ----
      if (a.name.startsWith('@') && varCount === 1 && varPart) {
        const exprSource = tmpl.vars[varPart.index]?.exprSource ?? ''
        if (INLINE_FN_RE.test(exprSource)) continue
        const m = THIS_MEMBER_RE.exec(exprSource)
        if (m) {
          const name = m[1]
          // 成员不可穷尽（外部基类）→ 放行；命中已知成员 / 框架内置 → 放行
          if (members === null || members.has(name) || KNOWN_BASE_MEMBERS.has(name)) continue
          errs.push({
            ...pos,
            message: `E-EVENT-FN: 事件 '${a.name}' 的处理器 '${exprSource}' 不是组件 ${comp.className} 的成员`,
          })
        }
        // 其他形态（外部标识符、动态访问、条件表达式）→ 无法判定，放行
        continue
      }

      // ---- E-REF-TYPE：ref 必须绑定 createRef() 结果 ----
      if (a.name === 'ref' && varCount === 1 && varPart) {
        const exprSource = tmpl.vars[varPart.index]?.exprSource ?? ''
        const m = THIS_MEMBER_RE.exec(exprSource)
        if (m && members !== null) {
          const name = m[1]
          if (!members.has(name)) {
            errs.push({
              ...pos,
              message: `E-REF-TYPE: ref 绑定的 '${exprSource}' 不是组件 ${comp.className} 的成员`,
            })
          } else {
            const member = findMemberNode(comp, ctx, name)
            // 仅对「有初始化器的字段」可静态证明；方法/getter/无初始化器 → 放行
            if (member?.type === 'PropertyDefinition' && member.value != null) {
              if (!isCreateRefCall(member.value, comp)) {
                errs.push({
                  ...pos,
                  message:
                    `E-REF-TYPE: ref 绑定的 '${exprSource}' 初始化器不是 createRef() 调用，` +
                    `运行时将报「Ref must be a RefObject」`,
                })
              }
            }
          }
        }
        // members===null（外部基类）或非 this.* 形态 → 放行
      }
    }
  }

  return errs
}
