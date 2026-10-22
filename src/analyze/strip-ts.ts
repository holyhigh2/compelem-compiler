/**
 * TS 专有语法的运行时剥离（`x!` 后缀非空断言）。
 *
 * 单独成模块的原因：`template-extract`（分析期）与 `template-subs`（分析期 + 各 codegen 模块）
 * 都要用它，而 `template-subs` 已经 import 了 `template-extract` 的 `hasTsSyntax` /
 * `MainTemplate` / `TemplateVarInfo`。若 `template-extract` 反过来 import `template-subs`，
 * 就形成模块环 —— 本文件零依赖，把环打断。
 */
import { hasTsSyntax, isUnaryKeyword, scanJsText } from '../utils/js-text'

/**
 * 剥离后缀非空断言 `expr!`（上下文感知，跳过字符串/注释/正则）。
 * 不处理 `as`/`satisfies`：复检 `hasTsSyntax` 仍命中则由调用方判为不可编译。
 */
export function stripTs(src: string): string {
  const { mask, closed } = scanJsText(src)
  if (!closed) return src
  let out = ''
  let lastCode = ''
  let lastCodeIdx = -1
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (mask[i] && c === '!') {
      const next = i + 1 < src.length ? src[i + 1] : ''
      // `!` 与上一个代码字符之间有换行时不判 postfix：`a\n!b` 经 ASI 断成
      // 两条语句（`!b` 是前缀取反），剥掉 `!` 会静默改变语义。复检侧
      // hasTsSyntax 的 BANG_RE 要求 `!` 紧贴 [\w)\]]，天然不命中跨行形态，
      // 两边判据保持一致
      const newlineBefore = lastCodeIdx >= 0 && src.slice(lastCodeIdx + 1, i).includes('\n')
      const postfix =
        next !== '=' &&
        !!lastCode &&
        !newlineBefore &&
        /[A-Za-z0-9_$)\]'\"`]/.test(lastCode) &&
        // 关键字（typeof/await/return/…）后的 `!` 是一元取反，不是断言
        !isUnaryKeyword(src, lastCodeIdx)
      if (postfix) continue
    }
    out += c
    if (mask[i] && !/\s/.test(c)) {
      lastCode = c
      lastCodeIdx = i
    }
  }
  return out
}

/**
 * `stripTs` + `hasTsSyntax` 复检的合并出口（同一份文本只处理一次）。
 *
 * 主模板与分析期的每个插值都要「先 stripTs 再复检」，且同一条表达式文本会分别流经
 * `template-extract`（分析）、`build-vars`（取值函数）、`render-effect`（内联工厂）三处，
 * 每处各自 `stripTs`（内含多次 `scanJsText` 全文扫描）+ `hasTsSyntax`（再一次 `scanJsText`）
 * ⇒ 一条文本被全文扫描 6+ 遍。三处传入的是**逐字相同**的字符串（wraps 后仍是同一拼接结果），
 * 故按文本 memo。`stripTs`/`hasTsSyntax` 是纯函数（结果只依赖入参），跨文件共享同一缓存亦正确；
 * LRU 上限防 dev 长会话内存增长。
 */
const STRIP_CHECK_MEMO = new Map<string, { stripped: string; tsHit: boolean }>()
const STRIP_CHECK_MAX = 4096

export function stripTsChecked(src: string): { stripped: string; tsHit: boolean } {
  const hit = STRIP_CHECK_MEMO.get(src)
  if (hit !== undefined) {
    // LRU touch
    STRIP_CHECK_MEMO.delete(src)
    STRIP_CHECK_MEMO.set(src, hit)
    return hit
  }
  const r = { stripped: stripTs(src), tsHit: false }
  r.tsHit = hasTsSyntax(r.stripped)
  if (STRIP_CHECK_MEMO.size >= STRIP_CHECK_MAX) {
    const oldest = STRIP_CHECK_MEMO.keys().next().value
    if (oldest !== undefined) STRIP_CHECK_MEMO.delete(oldest)
  }
  STRIP_CHECK_MEMO.set(src, r)
  return r
}
