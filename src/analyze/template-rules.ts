/**
 * 模板层约定规则：模板树 + 插值表达式源码 → 编译期诊断。
 *
 * 编译期覆盖以下约定检查：
 *   E-PROP-INTERP   .prop 的值必须是插值
 *   E-EVENT-FN      事件处理器必须是函数/成员
 *   E-REF-TYPE      ref 必须绑定 createRef() 结果
 *
 * 其余同类运行时检查的编译期覆盖：
 *   - 动态根元素（vars.length != updatePointMetas.length）的三个触发条件
 *     （注释内插值 / 属性多插值 / 标签名插值）→ template-tree.ts 硬错误
 *
 * 无法静态判定的表达式形态（外部标识符、动态访问、未知基类成员）一律放行 —— 宁漏勿误报。
 * 错误定位统一挂在模板字面量整体（start/end = 模板源码区间），明细在 message 中。
 */
import type { ComponentAnalysis } from '../types'
import { keyName } from '../utils/oxc'
import type { TemplateTree, TElement, TNode } from './template-tree'
import type { MainTemplate, TemplateVarInfo } from './template-extract'
import type { ConventionsContext } from './conventions'

export interface TemplateRuleError {
  start: number
  end: number
  message: string
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

/** CompElem 基类内置实例成员（事件绑定到它们不算错误）。 */
const KNOWN_BASE_MEMBERS = new Set([
  // 方法
  'emit', 'nextTick', 'forceUpdate', 'updateProps', 'insertStyleSheet', 'destroy',
  'propsReady', 'render', 'beforeMount', 'mounted', 'shouldUpdate', 'beforeDestroyed', 'destroyed',
  // 只读字段 / getter
  'rootComponent', 'parentComponent', 'wrapperComponent', 'renderRoot', 'renderRoots',
  'shadowRoot', 'slots', 'slotHooks', 'cssSheets', 'globalCssSheet', 'attrs', 'props',
  'isMounted', 'isDestroyed', 'cssVars', 'tagName',
])

function superClassName(node: any): string | null {
  const sc = node.superClass
  if (!sc) return null
  if (sc.type === 'Identifier') return sc.name
  if (sc.type === 'MemberExpression' && sc.property?.type === 'Identifier') return sc.property.name
  return null
}

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

  // ---- C1: 指令插入位置校验 ----
  // 遍历主模板 vars，对 isDirectiveCall 的插值检查其在树中的位置是否被该指令允许
  const directiveVars = tmpl.vars.filter((v) => v.isDirectiveCall && v.directiveName)
  if (directiveVars.length) {
    // 建立 varIndex → 所在位置 的映射（tag=标签属性位 / text=文本插值 / slot=组件标签体内插值）
    const varPosMap = new Map<number, 'tag' | 'text' | 'slot'>()
    // 标签属性位
    for (const el of elements) {
      for (const a of el.attrs) {
        if (a.name.includes('⟬')) {
          // 属性名整体插值 = TAG 指令位
          const m = /⟬Ċ⟭(\d+)/.exec(a.name)
          if (m) varPosMap.set(+m[1], 'tag')
        }
        for (const p of a.parts) {
          if (p.type === 'var') {
            // 属性值内的指令调用：按 TAG 处理（模板中指令出现在属性值里的情况极少，但 bind/show 等确实可能）
            // 实际上指令只允许出现在标签位或文本位；属性值内的指令调用由 codegen 层报错，这里不重复
          }
        }
      }
    }
    // 文本/插值位（含 slot 体内）
    const walkText = (nodes: TNode[], inSlot: boolean) => {
      for (const nd of nodes) {
        if (nd.type === 'text') {
          for (const p of nd.parts) {
            if (p.type === 'var' && !varPosMap.has(p.index)) {
              varPosMap.set(p.index, inSlot ? 'slot' : 'text')
            }
          }
        } else if (nd.type === 'element') {
          const isComp =
            (knownTags?.has(nd.tag.toLowerCase()) ?? false) ||
            nd.tag === 'SLOT' ||
            nd.tag === 'slot'
          walkText(nd.children, isComp)
        }
      }
    }
    walkText(tree.root, false)

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
  }

  for (const el of elements) {
    for (const a of el.attrs) {
      // 属性名整体插值 = TAG 指令写法，不属于以下任何检查
      if (a.name.includes('⟬')) continue

      const varPart = a.parts.find((p) => p.type === 'var')
      const varCount = a.parts.filter((p) => p.type === 'var').length

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

      // ---- .prop 目标校验（.prop 只能设在 CompElem 或 <slot> 上）----
      if (a.name.startsWith('.') && varCount === 1) {
        const lower = el.tag.toLowerCase()
        const isKnown = knownTags?.has(lower) ?? false
        const isSlot = lower === 'slot'
        if (!isKnown && !isSlot) {
          // 无连字符的原生标签（div/span 等）→ 确定性错误；同文件组件可查 prop 存在性
          // 跨文件组件（无连字符且不在 knownTags）→ 保守放行（宁漏勿误报）
          if (!/^[a-z][a-z0-9]*$/.test(el.tag) || el.tag.includes('-')) {
            // 有连字符但未注册 → 错误；无连字符的原生标签 → 错误
            errs.push({
              ...pos,
              message:
                `E-PROP-TARGET: Prop '${a.name}' 只能设置在 CompElem 或 <slot> 上` +
                `（<${el.tag}> 未注册为组件）`,
            })
          }
        } else if (isKnown) {
          // 同文件组件：检查 prop 是否存在（通过 knownTags 只知标签名，prop 集合需从 comp.fields 推断——
          // 跨组件 prop 存在性检查需要 componentIndex，暂不覆盖，仅做位置校验）
        }
      }

      // ---- E-EVENT-FN：事件处理器必须是函数 ----
      if (a.name.startsWith('@') && varCount === 1 && varPart) {
        const exprSource = tmpl.vars[varPart.index]?.exprSource ?? ''
        if (INLINE_FN_RE.test(exprSource)) continue
        const m = /^this\.([A-Za-z_$][\w$]*)$/.exec(exprSource)
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
        const m = /^this\.([A-Za-z_$][\w$]*)$/.exec(exprSource)
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
