/**
 * innerHTML 快路径序列化（模板树 → HTML 串）。
 *
 * 生成的 buildTemplate 改为：`template.innerHTML = "<html>"` 一次性建树，
 * 再由通用 split/collect walk 编号（见 template-dom.ts 的 WALK）。
 * 纯编译期逻辑；DOM 契约与 createElement 路径等价是硬前提——
 * 任何 HTML 树构造会重构/搬迁/丢弃的结构都必须走回退路径。
 *
 * 等价性来源（与 createElement 路径逐项对照）：
 * - 文本：序列化转义 `&`/`<`（script/style 不转义）→ 解析期实体解码 → 还原原文；
 *   `\r` 会被预处理归一为 `\n` → 含 CR 的文本/属性一律回退。
 * - 属性：静态属性按源顺序写入 → setAttribute 同序同值；动态/事件/ref/slot-props
 *   属性不写入（不 setAttribute）。属性值源码禁实体（parse 约束）→ 转义往返无损。
 * - 注释：原样往返（会破坏往返的写法回退）；注释不计 nodeSn（walk 跳过）。
 * - nodeSn：walk 按文档序（元素先入列再入子）编号，与 codegen 的
 *   emitElement/emitText 序号严格一致——这是回退判定保守的根本原因。
 */
import { PLACEHOLDER, VOID_TAGS, type TAttr, type TElement, type TNode } from '../analyze/template-tree'

/** HTML 树构造会重构/搬迁/丢弃的标签——出现即回退 createElement 路径。 */
const HARD_UNSAFE = new Set([
  // 表格族：隐式 tbody/colgroup 包装、foster parenting
  'table', 'tbody', 'thead', 'tfoot', 'tr', 'td', 'th', 'col', 'colgroup', 'caption',
  // 模板内容搬进 .content；noscript 受 scripting 标志影响
  'template', 'noscript',
  // 文档级上下文标签
  'html', 'head', 'body', 'frameset', 'frame', 'plaintext',
  // xmp 内容按纯文本解析（元素子级会变文本）
  'xmp',
])

/** `<p>` 的起始标签会隐式关闭 p 的元素集合（HTML "in body" 规则）。 */
const P_BLOCK_CLOSE = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'dd', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul', 'xmp',
  'listing', 'plaintext',
])

/** li/dd/dt 起始标签回溯时的终止集（special 但非 div/p/address → 直接插入，安全）。 */
const CHAIN_SAFE_STOP = new Set([
  'html', 'body', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'dl',
  'pre', 'listing', 'blockquote', 'fieldset', 'table', 'button', 'hr', 'xmp',
  'article', 'aside', 'details', 'dialog', 'dir', 'footer', 'header', 'hgroup',
  'main', 'menu', 'nav', 'section', 'figure', 'figcaption', 'center', 'plaintext',
])

/** script/style/textarea/title：子级必须纯文本（元素/注释子级会被解析成文本）。 */
const RAWTEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])

/** select 在 "in select" 模式下会忽略的元素子级（除白名单外）。 */
const SELECT_CHILDREN_OK = new Set(['option', 'optgroup', 'hr', 'script'])

const H_SET = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

const TOKEN_RE = new RegExp(`${PLACEHOLDER}(\\d+)`)

function hasVar(s: string): boolean {
  TOKEN_RE.lastIndex = 0
  return TOKEN_RE.test(s)
}

/**
 * 模板树能否安全走 innerHTML 路径（保守判定：任何不确定 → false 回退）。
 */
export function canUseInnerHTML(root: TNode[]): boolean {
  return checkNodes(root, [])
}

function checkNodes(nodes: TNode[], chain: TElement[]): boolean {
  for (const nd of nodes) {
    if (nd.type === 'text') {
      if (nd.raw.includes('\r')) return false
      continue
    }
    if (nd.type === 'comment') {
      if (nd.text.includes('\r')) return false
      if (nd.text.includes('--') || nd.text.startsWith('>') || nd.text.startsWith('->') || nd.text.endsWith('-')) {
        return false
      }
      continue
    }
    if (!checkElement(nd, chain)) return false
  }
  return true
}

function checkElement(el: TElement, chain: TElement[]): boolean {
  const t = el.tag.toLowerCase()
  if (HARD_UNSAFE.has(t)) return false
  if (!/^[a-zA-Z]/.test(el.tag)) return false
  // HTML 上下文专属（foreign content 无隐式闭合/adoption agency）
  if (t === 'image' && el.ns === 'html') return false

  for (const a of el.attrs) {
    if (a.value != null && a.value.includes('\r')) return false
  }

  // rawtext/RCDATA：子级必须纯文本；textarea 首行 \n 被解析器剥离
  if (RAWTEXT_TAGS.has(t)) {
    for (const c of el.children) {
      if (c.type !== 'text') return false
      if (c.raw.includes('\r')) return false
    }
    if (t === 'textarea' && el.children[0]?.type === 'text' && el.children[0].raw.startsWith('\n')) {
      return false
    }
    return checkNodes(el.children, [...chain, el])
  }

  // pre/listing 首行 \n 被解析器剥离（createElement 不会）
  if ((t === 'pre' || t === 'listing') && el.children[0]?.type === 'text' && el.children[0].raw.startsWith('\n')) {
    return false
  }

  if (el.ns === 'html') {
    // 祖先链禁令：a/form/button 嵌套自身、h* 嵌套 h*（adoption agency / 隐式闭合）
    if (t === 'a' || t === 'form' || t === 'button') {
      for (const p of chain) if (p.ns === 'html' && p.tag.toLowerCase() === t) return false
    }
    if (H_SET.has(t)) {
      for (const p of chain) if (p.ns === 'html' && H_SET.has(p.tag.toLowerCase())) return false
    }

    // li/dd/dt 起始标签的隐式闭合回溯（祖先链上命中同族 → 重构）
    if (t === 'li' && chainHits(chain, new Set(['li']))) return false
    if ((t === 'dd' || t === 'dt') && chainHits(chain, new Set(['dd', 'dt']))) return false

    // option/optgroup 嵌套：内层成为兄弟（option 内容仅纯文本）
    if (t === 'option' || t === 'optgroup') {
      for (const c of el.children) {
        if (c.type === 'element') {
          if (t === 'option') return false
          const ct = c.tag.toLowerCase()
          if (ct !== 'option' && ct !== 'optgroup') return false
        }
      }
      const parent = chain.length ? chain[chain.length - 1] : null
      if (parent && parent.ns === 'html') {
        const pt = parent.tag.toLowerCase()
        if (t === 'option' && pt === 'option') return false
        if (t === 'optgroup' && pt === 'optgroup') return false
      }
    }

    // p 子树含会关闭 p 的元素 → 隐式闭合重构
    if (t === 'p' && subtreeHas(el.children, P_BLOCK_CLOSE)) return false

    // select 子级白名单（其余在 "in select" 模式下被直接忽略）
    if (t === 'select') {
      for (const c of el.children) {
        if (c.type === 'element' && !SELECT_CHILDREN_OK.has(c.tag.toLowerCase())) return false
        if (c.type === 'comment') return false
      }
    }
  }

  return checkNodes(el.children, [...chain, el])
}

/**
 * li/dd/dt 起始标签的回溯判定（祖先链由外到内）：从最近祖先向上，
 * 命中目标 → true（重构，不安全）；命中终止集 → false（直接插入，安全）；到根 → false。
 */
function chainHits(chain: TElement[], targets: Set<string>): boolean {
  for (let i = chain.length - 1; i >= 0; i--) {
    const el = chain[i]
    if (el.ns !== 'html') continue
    const t = el.tag.toLowerCase()
    if (targets.has(t)) return true
    if (CHAIN_SAFE_STOP.has(t)) return false
  }
  return false
}

function subtreeHas(nodes: TNode[], set: Set<string>): boolean {
  for (const nd of nodes) {
    if (nd.type === 'element' && nd.ns === 'html') {
      if (set.has(nd.tag.toLowerCase())) return true
      if (subtreeHas(nd.children, set)) return true
    }
  }
  return false
}

/** 序列化可写入 HTML 的静态属性（与 emitAttr 静态分支同口径）。 */
function seriableAttr(a: TAttr): boolean {
  const name = a.name
  if (name === 'slot-props' || name === 'ref') return false
  if (name[0] === '.' || name[0] === '?' || name[0] === '*' || name[0] === '@') return false
  if (hasVar(name)) return false
  if (a.value != null && hasVar(a.value)) return false
  return true
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}


/** script/style 文本不转义（rawtext 内不可能含 `<`——源解析器在此截断）。 */
function isRawtextTag(tag: string): boolean {
  const t = tag.toLowerCase()
  return t === 'script' || t === 'style'
}

/**
 * 模板树 → innerHTML 串。仅在 canUseInnerHTML(root) 为 true 时调用。
 * 属性按源顺序输出（DOM attr 插入序一致）；动态属性省略（不写）。
 */
export function serializeTemplateHTML(root: TNode[]): string {
  let out = ''
  for (const nd of root) out += serNode(nd, null)
  return out
}

function serNode(nd: TNode, parent: TElement | null): string {
  if (nd.type === 'text') {
    return parent && isRawtextTag(parent.tag) ? nd.raw : escText(nd.raw)
  }
  if (nd.type === 'comment') return `<!--${nd.text}-->`
  return serElement(nd)
}

function serElement(el: TElement): string {
  let attrs = ''
  for (const a of el.attrs) {
    if (!seriableAttr(a)) continue
    attrs += a.value == null ? ` ${a.name}` : ` ${a.name}="${escAttr(a.value)}"`
  }
  const open = `<${el.tag}${attrs}>`
  if (VOID_TAGS.has(el.tag.toLowerCase())) return open
  let inner = ''
  for (const c of el.children) inner += serNode(c, el)
  return `${open}${inner}</${el.tag}>`
}
