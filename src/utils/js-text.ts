/**
 * JS/TS 文本上下文扫描（编译器内部共享）。
 *
 * 只做一件事：标记“哪些字符处于 JS **代码**上下文”。
 * 字符串、模板字面量文本、注释、正则字面量内部一律标记为 0；
 * 模板的 ${...} 表达式与正则结束符/flag 标记为 1。
 *
 * stripTs / rewriteThis / hasTsSyntax 共用本模块，避免三份手写扫描器漂移
 * （历史上两份副本都不识别正则字面量，会把 /a!/、/this/ 改坏）。
 */

export interface JsTextScan {
  /** 1 = JS 代码上下文；0 = 字符串/模板文本/注释/正则内部 */
  mask: Uint8Array
  /** 引号、模板、注释、正则是否全部闭合；false 时调用方应放弃改写 */
  closed: boolean
  /**
   * `//` 行注释区间（start = 首个 `/`，end = 换行符下标或文本末尾）。
   * 供 stripLineComments 精确剥离——字符串/模板/正则里的 `//` 不会入列。
   */
  lineComments: Array<{ start: number; end: number }>
}

/** 这些关键字后允许出现正则字面量（而不是除号）。 */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])

/**
 * 这些 token 之后的 `{` 是**块语句**而非对象字面量——尽管它们同时让
 * regexAllowed=true（`else {` / `do {` / `a => {`）。只影响 `}` 之后
 * regexAllowed 的恢复方向（块尾允许正则、对象尾只允许除法）。
 */
const BLOCK_KEYWORD_BEFORE_BRACE = new Set(['do', 'else', '=>'])

/** 扫描 JS/TS 源码，返回代码上下文掩码与闭合状态。 */
export function scanJsText(src: string): JsTextScan {
  const n = src.length
  const mask = new Uint8Array(n)
  const lineComments: Array<{ start: number; end: number }> = []
  type Ctx =
    | { t: 'code'; braces: Array<'block' | 'object'> }
    | { t: 'sq' | 'dq' | 'tpl' | 'block' }
    | { t: 'line'; rec: { start: number; end: number } }
    | { t: 'regex'; inClass: boolean }
  const stack: Ctx[] = [{ t: 'code', braces: [] }]
  let i = 0
  // 上一个有效代码 token 是否允许 / 作为正则起点
  let regexAllowed = true
  // 最近一个标识符/关键字（或 '=>'）：用于 `{` 的块/对象字面量判定
  let lastWord = ''

  const mark = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) mask[k] = 1
  }

  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]

    if (top.t === 'line') {
      if (c === '\n') {
        top.rec.end = i
        stack.pop()
      }
      i++
      continue
    }
    if (top.t === 'block') {
      if (c === '*' && src[i + 1] === '/') {
        stack.pop()
        i += 2
      } else i++
      continue
    }
    if (top.t === 'sq' || top.t === 'dq') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === (top.t === 'sq' ? "'" : '"')) {
        // 收尾引号算代码位置：让 "x"! 的 ! 仍可被 stripTs 识别
        mask[i] = 1
        stack.pop()
        // ⚠️ 字符串是**值**，其后出现的 `/` 只能是除号（`'a' / 2`）。
        // 不复位的话 regexAllowed 会保留进字符串之前的值（多数情况是 true），
        // 下一个 `/` 被当成正则起点 ⇒ 把后面的代码整段屏蔽（2026-10-22 审查 C-6）：
        //   `'a' / 2`           ⇒ rewriteThis 引号配对复检失败，合法 JS 被拒
        //   `'a' / 2 + (this.n / 3)` ⇒ `this` 落在"正则内容"里漏改写 ⇒ 运行期静默错值
        regexAllowed = false
      }
      i++
      continue
    }
    if (top.t === 'tpl') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        mask[i] = 1
        stack.pop()
        // 同 sq/dq：模板字面量也是值 ⇒ 其后的 `/` 是除号，见 C-6 说明
        regexAllowed = false
        i++
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ t: 'code', braces: [] })
        mark(i, i + 2)
        i += 2
        regexAllowed = true
        continue
      }
      i++
      continue
    }
    if (top.t === 'regex') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '[') {
        top.inClass = true
        i++
        continue
      }
      if (c === ']') {
        top.inClass = false
        i++
        continue
      }
      if (c === '/' && !top.inClass) {
        const start = i
        i++
        while (i < n && /[a-z]/i.test(src[i])) i++
        mark(start, i) // 结束斜杠与 flags 算代码位置（"x"! / /re/! 的 ! 可剥）
        stack.pop()
        regexAllowed = false
        continue
      }
      i++
      continue
    }

    // ---- code ----
    // 上面的分支都已 continue；这里显式收窄，便于 TS 使用 top.braces。
    if (top.t !== 'code') { i++; continue }
    if (c === '/' && src[i + 1] === '/') {
      const rec = { start: i, end: n }
      lineComments.push(rec)
      stack.push({ t: 'line', rec })
      i += 2
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      stack.push({ t: 'block' })
      i += 2
      continue
    }
    if (c === '/' && regexAllowed) {
      stack.push({ t: 'regex', inClass: false })
      i++
      continue
    }
    if (c === "'" || c === '"') {
      stack.push({ t: c === "'" ? 'sq' : 'dq' })
      i++
      continue
    }
    if (c === '`') {
      stack.push({ t: 'tpl' })
      i++
      continue
    }
    if (c === '{') {
      // 表达式位（regexAllowed）的 `{` 是对象字面量；`else {` / `do {` / `a => {`
      // 虽然也处于 regexAllowed=true，但那是块语句——记下来供 `}` 恢复方向用
      top.braces.push(regexAllowed && !BLOCK_KEYWORD_BEFORE_BRACE.has(lastWord) ? 'object' : 'block')
      mask[i] = 1
      i++
      regexAllowed = true
      continue
    }
    if (c === '}') {
      if (top.braces.length === 0 && stack.length > 1) {
        stack.pop()
        mask[i] = 1
        i++
        regexAllowed = false
        continue
      }
      const kind = top.braces.pop()
      mask[i] = 1
      i++
      // 块语句结束（`if(a){} /re/.test(x)`）后正则是合法起点；对象字面量
      // 结束（`const o = {} / 2`）后 `/` 只能是除法。不区分块/对象时
      // 块尾的正则字面量会被当除法扫描，其内容（引号等）不被屏蔽，
      // 可能被 rewriteThis / stripTs 改坏
      regexAllowed = kind === 'block'
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }

    mask[i] = 1
    if (c === '=' && src[i + 1] === '>') {
      // 箭头 `=>`：其后的 `{` 是函数体块，不是对象字面量
      mask[i + 1] = 1
      lastWord = '=>'
      regexAllowed = true
      i += 2
      continue
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++
      const word = src.slice(i, j)
      mark(i, j)
      lastWord = word
      regexAllowed = REGEX_PREFIX_KEYWORDS.has(word)
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++
      mark(i, j)
      regexAllowed = false
      i = j
      continue
    }
    if (c === ')' || c === ']' || c === '.') regexAllowed = false
    else regexAllowed = true
    i++
  }

  return { mask, closed: stack.length === 1, lineComments }
}

/**
 * 剥掉 `//` 行注释（换行符本身保留，行结构不变）。
 *
 * 用途：把源码切片**单行内联 emit** 的场景（field-extract 的 options 切片）——
 * 尾随行注释（`@prop({ type: String, // 说明\n})`）被 trim 掉换行后，
 * `//` 会吞掉产物里后面的闭括号与追加属性 ⇒ 注入产物语法错误。
 * 注释位置来自 scanJsText 的精确上下文扫描：字符串 / 模板 / 正则里的
 * `//`（如 `"http://x"`）不会被误剥。
 */
export function stripLineComments(src: string): string {
  if (!src.includes('//')) return src
  const { lineComments } = scanJsText(src)
  if (!lineComments.length) return src
  let out = ''
  let pos = 0
  for (const { start, end } of lineComments) {
    out += src.slice(pos, start)
    pos = end // end 指向换行符（或文本末尾），换行随下一段保留
  }
  out += src.slice(pos)
  return out
}

/** 把非代码上下文替换为空格（保持长度），供“只看代码”的正则判定使用。 */
export function codeOnly(src: string): string {
  const { mask } = scanJsText(src)
  let out = ''
  for (let i = 0; i < src.length; i++) out += mask[i] ? src[i] : ' '
  return out
}

/**
 * TS 专有语法检测（生成到 JS 运行时会语法错误）。
 *
 * 只看代码上下文，避免把字符串里的 "ok!"、'as soon as' 误判为
 * 非空断言 / as 断言。`as`/`satisfies` 按文本判据检查；后缀 `!` 逐个候选
 * 做「关键字回看」，与 `strip-ts#stripTs` 用同一套 `isUnaryKeyword` 判据，
 * 保证复检与剥离**同序同判**（否则 `typeof!x` 会被 stripTs 正确保留、却被
 * 复检误报为非空断言 —— C1）。
 */
/**
 * `as` / `satisfies` 断言判据。
 *
 * ⚠️ 必须排除**成员访问**：`this.as (1)` / `x?.as (2)` 里的 `as` 是方法名而不是
 * 类型断言。旧判据只要求"词边界 + 后面是标识符/括号"，于是格式化工具把方法调用
 * 写成 `this.as (1)`（名字与 `(` 之间有空格）时被误报成"含 TS 专有语法"，
 * **合法 JS 直接构建失败**（2026-10-22 审查 C-8）。
 * `(?<![\w$.])` 同时挡掉 `obj.as`（前一个字符是 `.`，`?.` 亦然）与标识符内部。
 */
const AS_SATISFIES_RE = /(?<![\w$.])(?:as|satisfies)\s+[A-Za-z_(<]/
/** 后缀 `!` 候选：`x!` / `f(x)!` / `arr[0]!`，但排除 `!=`（不等运算符）。 */
const BANG_RE = /[\w)\]]!(?!=)/g

export function hasTsSyntax(src: string): boolean {
  const code = codeOnly(src)
  if (AS_SATISFIES_RE.test(code)) return true
  BANG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BANG_RE.exec(code)) !== null) {
    const prev = code[m.index]
    // `f(x)!` / `arr[0]!`：调用结果或下标后的 `!` 必是非空断言。
    if (prev === ')' || prev === ']') return true
    // 标识符结尾：回看该完整单词是不是「后面允许跟一元 `!`」的关键字
    // （`typeof!x` 的 `!` 是一元取反，不是断言）；不是关键字才算断言。
    if (!isUnaryKeyword(code, m.index)) return true
  }
  return false
}

/**
 * 「以该字符结尾的完整标识符若是这些关键字，则其后紧跟的 `!` 是一元取反而非
 * 非空断言」的白名单（`strip-ts#stripTs` 与上面的 `hasTsSyntax` 共用一份）。
 *
 * 只按单个尾字符判会误剥：`typeof !x` / `await !x` / `return !x` / `case !x`
 * 的 `!` 前面是 `f`/`t`/`n`/`e`，全部落在标识符字符集里 ⇒ 被当成断言删掉，
 * 语义翻成 `typeof x`（且复检 `hasTsSyntax` 看不到被删的 `!`，不会报错）。
 * 同理 `for (const x of !list)`、`else !a && b()`：prelude 语句位与插值表达式
 * 同受保护，`of`/`in`/`else`/`do` 后的 `!` 也是一元，必须保留。
 *
 * ⚠️ **不含 `this` / `super`**：`this!.foo` / `super!.foo` 是合法的非空断言，要剥。
 * ⚠️ **不含 `instanceof`**：`x instanceof B!` 的 `!` 跟在右操作数 `B` 之后，是断言
 *    （要剥）；把 `instanceof` 加进来反而会把方向判错。只有关键字**后紧跟**的 `!`
 *    才是一元，`instanceof` 后一般是操作数不是 `!`。
 */
const UNARY_BEFORE_BANG = new Set([
  'typeof', 'await', 'void', 'return', 'case', 'throw', 'delete', 'yield',
  'of', 'in', 'else', 'do',
])

/**
 * 以 `end`（含）结尾向前取完整标识符单词，判断它是不是「后面允许跟一元 `!`」的关键字。
 * `end` 不是标识符字符时返回 false。
 *
 * 前一个代码字符是 `.`（含 `?.`）时不算关键字：`row.case!` 里的 `case` 是属性名，
 * 那个 `!` 是真断言。
 */
export function isUnaryKeyword(src: string, end: number): boolean {
  if (end < 0 || !/[A-Za-z0-9_$]/.test(src[end])) return false
  let i = end
  while (i > 0 && /[A-Za-z0-9_$]/.test(src[i - 1])) i--
  if (!UNARY_BEFORE_BANG.has(src.slice(i, end + 1))) return false
  let p = i - 1
  while (p >= 0 && /\s/.test(src[p])) p--
  return p < 0 || src[p] !== '.'
}

/**
 * 把**代码区**的私有名引用降级为普通成员名：`this.#x` → `this.x`。
 *
 * 用途只有一个：给「把片段拼进裸函数再 parse」的校验/建作用域场景（build-vars 的
 * freeIdentifiers、compile 的 collectPreludeDeclNames）造一个能解析的副本 ——
 * 类体外出现 `#x` 是 early error（babel：`Private name #x is not defined`），
 * 而那两处只关心「自由标识符集合」与「prelude 声明了哪些名字」，不关心私有性。
 *
 * 语义等价性：`this.#x` 与 `this.x` 都是 MemberExpression，属性名不进自由标识符集合；
 * classifyThisChain 也只读属性名。故对校验结论无影响。
 *
 * 只动 mask=1 的字符：字符串 / 模板文本 / 注释 / 正则里的 `#` 原样保留
 * （`const sel = "#a"` 不会被改成 `"a"`）。扫描未闭合时退回裸正则，与旧行为一致。
 *
 * ⚠️ 产物不走本函数：预置代码的落盘版本由 compile.ts 的 `rewriteThis(…, 'rc')`
 * 处理，`this.#x` → `rc.#x`，写在 `static __ce_static__` 的类体内，语法合法。
 */
export function degradePrivateNames(src: string): string {
  if (src.indexOf('#') < 0) return src
  const { mask, closed } = scanJsText(src)
  if (!closed) return src.replace(/#(?=[A-Za-z0-9_$])/g, '')
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '#' && mask[i] === 1 && /[A-Za-z0-9_$]/.test(src[i + 1] ?? '')) continue
    out += ch
  }
  return out
}
