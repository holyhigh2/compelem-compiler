/**
 * TS 专有语法的运行时剥离（`x!` 后缀非空断言）。
 *
 * 单独成模块的原因：`template-extract`（分析期）与 `template-subs`（分析期 + 各 codegen 模块）
 * 都要用它，而 `template-subs` 已经 import 了 `template-extract` 的 `TS_SYNTAX_RE` /
 * `MainTemplate` / `TemplateVarInfo`。若 `template-extract` 反过来 import `template-subs`，
 * 就形成模块环 —— 本文件零依赖，把环打断。
 *
 * ⚠️ 剥离**顺序**是语义的一部分：必须先 `stripTs`、**再**用 `TS_SYNTAX_RE` 复检
 * （`stripTs → TS 复检`）。反过来的话 `${this.foo!}` 会在 `!` 还没被剥掉时命中正则，
 * 被误判为「含 TS 专有语法」而拒绝 —— 分析期与 codegen 的判定会不一致。
 */

/**
 * 剥离后缀非空断言 `expr!`（上下文感知，跳过字符串/模板字面量）。
 * 不处理 `as`/`satisfies`：复检 TS_SYNTAX_RE 仍命中则由调用方判为不可编译。
 */
export function stripTs(src: string): string {
  let out = ''
  const stack: Array<{ t: string; brace?: number }> = [{ t: 'code', brace: 0 }]
  let i = 0
  const n = src.length
  const isWord = (ch: string) => !!ch && /[A-Za-z0-9_$]/.test(ch)
  while (i < n) {
    const top = stack[stack.length - 1]
    const c = src[i]
    if (top.t === 'sq' || top.t === 'dq' || top.t === "'" || top.t === '"') {
      if (c === '\\') {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (top.t === c) stack.pop()
      out += c
      i++
      continue
    }
    if (top.t === 'tpl' || top.t === '`') {
      if (c === '\\') {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      if (c === '`') {
        stack.pop()
        out += c
        i++
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ t: 'code', brace: 0 })
        out += '${'
        i += 2
        continue
      }
      out += c
      i++
      continue
    }
    // code
    if (c === "'" || c === '"' || c === '`') {
      stack.push({ t: c })
      out += c
      i++
      continue
    }
    if (c === '{') {
      top.brace = (top.brace ?? 0) + 1
      out += c
      i++
      continue
    }
    if (c === '}') {
      if ((top.brace ?? 0) === 0 && stack.length > 1) {
        stack.pop()
        out += c
        i++
        continue
      }
      top.brace = (top.brace ?? 0) - 1
      out += c
      i++
      continue
    }
    if (c === '!') {
      const prev = out.length ? out[out.length - 1] : ''
      const next = i + 1 < n ? src[i + 1] : ''
      // 后缀非空断言：前驱为词/)/]/引号/反引号，且不是 != / !==
      const postfix =
        next !== '=' &&
        next !== '' &&
        (isWord(prev) || prev === ')' || prev === ']' || prev === "'" || prev === '"' || prev === '`')
      // 行尾/结构符前的 `x!`（next 为 ; , } ) 换行或已到末尾前的空白序列）
      const eol =
        next === '' ||
        /[;,\n\r)}]/.test(next) ||
        (next === ' ' && /^\s*[;,\n\r)}]/.test(src.slice(i + 1)))
      if ((postfix && (eol || next === '.' || next === '[' || next === '(')) || (isWord(prev) && eol)) {
        i++
        continue
      }
    }
    out += c
    i++
  }
  if (stack.length !== 1) return src
  return out
}
