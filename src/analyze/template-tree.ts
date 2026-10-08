/**
 * 模板源码级解析：h`` 模板字面量（strings + 插值）→ 节点树 IR（TNode）。
 *
 * 与运行时正则管线（parseTemplate/convertHTML/createTemplate）的**根本区别**：
 * 本模块解析的是**开发者源码**（见 docs/TEMPLATE-CODEGEN.md §3）——
 * 不做 innerHTML 解析、convertHTML、自动闭合与实体解码。
 * 相关容错行为在本层均为**编译错误**（静态编译唯一路径）。
 *
 * 占位符 token 与 compelem `src/constants.ts` 的 PLACEHOLDER 一致：
 * 解析时以 `⟬Ċ⟭N`（N = Template 序，即源码插值顺序）拼接 quasis，
 * 与运行时 parseTemplate 的编号空间相同 —— 保证 attrTmpl 生成物逐字节可比。
 */

/** 与 compelem constants.ts PLACEHOLDER 完全一致（⟬ + Ċ + ⟭）。 */
export const PLACEHOLDER = '⟬Ċ⟭'

const TOKEN_RE = new RegExp(`${PLACEHOLDER}(\\d+)`, 'g')

/** HTML void 元素（不需要闭合标签）。 */
export const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

export const SVG_NS = 'http://www.w3.org/2000/svg'

// ---------- IR 数据结构 ----------

export interface TStaticPart { type: 'static'; text: string }
export interface TVarPart { type: 'var'; index: number }
export type TPart = TStaticPart | TVarPart

export interface TAttr {
  /** 源码属性名（保留前缀字符 . ? @ * 与大小写） */
  name: string
  /** 原始值（未解码）；null = 无值属性（如布尔写法） */
  value: string | null
  /** 值按插值拆分 */
  parts: TPart[]
}

export interface TElement {
    type: 'element'
    tag: string
    attrs: TAttr[]
    children: TNode[]
    ns: 'html' | 'svg'
}

export interface TText {
    type: 'text'
    raw: string
    parts: TPart[]
}

export interface TComment {
  type: 'comment'
  text: string
}

export type TNode = TElement | TText | TComment

/** 带源码位置的错误（偏移基于拼接后的 html 串）。 */
export class TemplateParseError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message)
  }
}

// ---------- 拼接与拆分 ----------

/** quasis + 插值 → 源码级 html 串（插值以 ⟬Ċ⟭N 占位）。 */
export function buildTemplateHTML(strings: readonly string[]): string {
  let html = ''
  for (let i = 0; i < strings.length; i++) {
    html += strings[i]
    if (i < strings.length - 1) html += PLACEHOLDER + i
  }
  return html
}

/** 把含占位符的字符串拆成 static/var 片段（每次调用重置 lastIndex，避免 /g 状态泄漏）。 */
export function splitParts(s: string): TPart[] {
  const parts: TPart[] = []
  let last = 0
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(s))) {
    if (m.index > last) parts.push({ type: 'static', text: s.slice(last, m.index) })
    parts.push({ type: 'var', index: parseInt(m[1]) })
    last = m.index + m[0].length
  }
  if (last < s.length) parts.push({ type: 'static', text: s.slice(last) })
  return parts
}

// ---------- 解析器 ----------

export interface TemplateTree {
  /** 根级节点 */
  root: TNode[]
}

/**
 * 解析源码级模板串为节点树。
 *
 * 抛出 `TemplateParseError` 表示源码写法不受 codegen 支持（静态编译下不允许回退）。
 */
export function parseTemplateTree(
  html: string,
  varCount: number,
): TemplateTree {
  const root: TNode[] = []
  const stack: OpenTag[] = []
  let inSvg = false
  let i = 0
  const n = html.length

  const err = (msg: string): never => {
    throw new TemplateParseError(msg, i)
  }

  while (i < n) {
    const parent = stack.length ? stack[stack.length - 1].node.children : root

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4)
      if (end < 0) err('注释未闭合')
      const text = html.slice(i + 4, end)
      if (TOKEN_RE.test(text)) err('注释内不允许出现模板插值（会被静默丢弃）')
      parent.push({ type: 'comment', text })
      i = end + 3
      continue
    }

    if (html[i] === '<') {
      // 结束标签
      if (html[i + 1] === '/') {
        const m = /^<\/\s*([^\s>]+)\s*>/.exec(html.slice(i))
        if (!m) err('非法的结束标签')
        const lower = m![1].toLowerCase()
        let found = -1
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].lower === lower) { found = k; break }
        }
        if (found < 0) err(`</${m![1]}> 没有对应的开始标签`)
        if (found !== stack.length - 1) {
          err(`<${stack[stack.length - 1].name}> 未闭合（不支持 HTML 自动闭合，请显式书写结束标签）`)
        }
        const popped = stack.pop()!
        if (popped.lower === 'svg') inSvg = false
        i += m![0].length
        continue
      }

      // 开始标签
      if (!/[a-zA-Z]/.test(html[i + 1] || '')) err(`'<' 后未跟标签名（如需文本请转义）`)
      const rest = html.slice(i)
      const nameMatch = /^<([^\s/>]+?)(?=[\s/>])/.exec(rest)
      if (!nameMatch) err('非法的标签名')
      const tag = nameMatch![1]
      const lower = tag.toLowerCase()
      // <svg> 自身也是 SVG 命名空间（对齐 innerHTML 语义）
      const el: TElement = {
        type: 'element',
        tag,
        attrs: [],
        children: [],
        ns: inSvg || lower === 'svg' ? 'svg' : 'html',
      }
      parent.push(el)

      // 属性区
      let j = i + 1 + tag.length
      let selfClosing = false
      while (j < n) {
        while (j < n && /\s/.test(html[j])) j++
        if (j >= n) err(`标签 <${tag}> 未闭合`)
        if (html[j] === '>') { j++; break }
        if (html[j] === '/' && html[j + 1] === '>') { selfClosing = true; j += 2; break }
        let nameStart = j
        while (j < n && !/[\s=/>]/.test(html[j])) j++
        if (j === nameStart) err(`标签 <${tag}> 的属性区非法（位置 ${j}）`)
        const attrName = html.slice(nameStart, j)
        let attrValue: string | null = null
        let k = j
        while (k < n && /\s/.test(html[k])) k++
        if (html[k] === '=') {
          k++
          while (k < n && /\s/.test(html[k])) k++
          const q = html[k]
          if (q === '"' || q === '\'') {
            const endQ = html.indexOf(q, k + 1)
            if (endQ < 0) err(`属性 ${attrName} 的引号未闭合`)
            attrValue = html.slice(k + 1, endQ)
            j = endQ + 1
          } else {
            const vStart = k
            while (k < n && !/[\s>]/.test(html[k])) k++
            attrValue = html.slice(vStart, k)
            j = k
          }
        }
        el.attrs.push({ name: attrName, value: attrValue, parts: attrValue == null ? [] : splitParts(attrValue) })
      }
      i = j

      // 属性区约束（静态编译硬约束）
      for (const a of el.attrs) {
        const nameParts = splitParts(a.name)
        const nameVars = nameParts.filter((p): p is TVarPart => p.type === 'var')
        if (nameVars.length > 1 || (nameVars.length === 1 && a.name !== PLACEHOLDER + nameVars[0].index)) {
          err(`属性名 ${a.name} 只允许整体为一个插值（标签位指令写法），不允许部分插值`)
        }
        const valVars = a.parts.filter((p): p is TVarPart => p.type === 'var').length
        if (valVars > 1) err(`属性 ${a.name} 的值最多允许一个插值（对齐 EXP_ATTR_CHECK）`)
        // 实体检查对静态/动态属性都生效（setAttribute 不解码，与 innerHTML 行为有差异 → 强制写明面字符）
        if (a.value != null && /&[a-zA-Z#0-9]+;/.test(a.value)) {
          err(`属性 ${a.name} 的值包含 HTML 实体；codegen 不做实体解码，请直接书写目标字符`)
        }
      }

      if (lower === 'svg') inSvg = true
      if (lower === 'foreignobject') err('foreignObject 暂不支持（v1）')

      if (!selfClosing && !VOID_TAGS.has(lower)) {
        stack.push({ name: tag, lower, node: el })
      }
      continue
    }

    // 文本节点：到下一个 '<' 为止（原样保留，含纯空白 —— 分裂/裁剪在 codegen 层做）
    let end = html.indexOf('<', i)
    if (end < 0) end = n
    const raw = html.slice(i, end)
    parent.push({ type: 'text', raw, parts: splitParts(raw) })
    i = end
  }

  if (stack.length) {
    err(`<${stack[stack.length - 1].name}> 未闭合（不支持 HTML 自动闭合，请显式书写结束标签）`)
  }

  // 插值槽完整性：每个 varIndex 必须在树里恰好出现一次
  const seen = new Set<number>()
  const visit = (nodes: TNode[]) => {
    for (const nd of nodes) {
      if (nd.type === 'text') {
        for (const p of nd.parts) if (p.type === 'var') seen.add(p.index)
      } else if (nd.type === 'element') {
        for (const a of nd.attrs) {
          for (const p of a.parts) if (p.type === 'var') seen.add(p.index)
          for (const p of splitParts(a.name)) if (p.type === 'var') seen.add(p.index)
        }
        visit(nd.children)
      }
    }
  }
  visit(root)
  for (let v = 0; v < varCount; v++) {
    if (!seen.has(v)) err(`插值槽 ${v} 未在模板结构中出现`)
  }
  if (seen.size !== varCount) err('模板中出现未知编号的插值槽')

  // <transition> 在解包阶段显式拦截（见 unwrapList）
  const newRoot = unwrapList(root)

  // 编译期剔除「仅排版用的空白文本」节点：源码换行/缩进会解析出不带占位符的
  // 纯空白 Text，它们在 innerHTML 路径里会变成空 Text 节点，白占 nodes[] 名额与
  // clone/effect 开销。判据：`raw` 全是空白（只含空格/Tab/换行）⇒ 纯排版空白。
  //
  // ⚠️ 代价（已知取舍）：`</b> <span>` 这类**同一行内**、两个内联元素之间的单个空格
  // 也会被剔除，渲染时两者直接相邻。依赖该空格做视觉分隔的写法请改用 CSS
  // （gap / margin）表达。rawtext 系（script/style/textarea/title/xmp/listing/pre）
  // 的空白是真内容，一律不动。
  const RAWTEXT = new Set(['script','style','textarea','title','xmp','listing','pre'])
  const prune = (nodes: TNode[], parentTag: string | null): TNode[] => {
    if (parentTag !== null && RAWTEXT.has(parentTag)) return nodes
    const kept: TNode[] = []
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i]
      if (nd.type === 'element') { nd.children = prune(nd.children, nd.tag.toLowerCase()) }
      if (nd.type !== 'text') { kept.push(nd); continue }
      // 纯空白（仅空格/Tab/换行且有非空内容的空白为分界）全部剔除——
      // 用户要求：</b> <span> 间的 " " 这种排版空白不留在 nodes[] 中。
      // 注意：两个内联元素间若依赖该空格做视觉分隔，需改在外层用 CSS gap/markup 表达。
      if (/^[ \t\r\n]+$/.test(nd.raw)) continue
      kept.push(nd)
    }
    return kept
  }
  const pruned = prune(newRoot, null)
  return { root: pruned }
}

interface OpenTag {
  name: string
  lower: string
  node: TElement
}

function unwrapList(list: TNode[]): TNode[] {
  const out: TNode[] = []
  for (const nd of list) {
    if (nd.type !== 'element') { out.push(nd); continue }
    if (nd.tag.toLowerCase() === 'transition') {
      // `<transition>` 伪标签不受支持。显式报错而不是当普通标签渲染
      // —— 后者会在页面上留下一个真实的 <transition> 元素，且结构指令锚点丢失，
      // 属于「构建通过但行为静默错误」，比构建失败难查一个数量级。
      errT('<transition> 不受支持，请改用 CSS 动画或自行实现过渡逻辑')
    }
    nd.children = unwrapList(nd.children)
    out.push(nd)
  }
  return out
}

function errT(msg: string): never {
  throw new TemplateParseError(msg, -1)
}
