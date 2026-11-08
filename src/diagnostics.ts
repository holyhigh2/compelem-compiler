/**
 * 约定诊断（E-* / W-*）的收集与上报。
 *
 * 独立模块：`.ts` 组件与 `.ce` 组件的约定校验共用同一份实现，
 * 由 `collectErrors` 统一产出 errs / warns 两组文本。
 */
import type { CompileResult } from './compile'

/** 约定违规的处理力度：error 阻断构建 / warn 控制台提示 / silent 忽略。 */
export type ConventionMode = 'error' | 'warn' | 'silent'

/** 已格式化为 `文件:行:列 [类名] 消息` 的两组诊断文本。 */
export interface CollectedDiagnostics {
  errs: string[]
  warns: string[]
}

/** 惰性构建换行偏移索引（升序；仅在有诊断时付费一次）。 */
export function newlineIndex(code: string): Int32Array {
  const arr: number[] = []
  for (let i = 0; i < code.length; i++) if (code.charCodeAt(i) === 10) arr.push(i)
  return Int32Array.from(arr)
}

/** 把源码偏移换算成 `行:列`（1 起算）；带换行索引时走二分（O(log n)）。 */
export function offsetToLineCol(code: string, offset: number, nl?: Int32Array): string {
  if (!nl) {
    let line = 1
    let lastNl = -1
    for (let i = 0; i < offset && i < code.length; i++) {
      if (code.charCodeAt(i) === 10) {
        line++
        lastNl = i
      }
    }
    return `${line}:${offset - lastNl}`
  }
  //二分：count = 换行下标中严格小于 offset 的个数
  let lo = 0,
    hi = nl.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (nl[mid] < offset) lo = mid + 1
    else hi = mid
  }
  const lastNl = lo > 0 ? nl[lo - 1] : -1
  return `${lo + 1}:${offset - lastNl}`
}

/** 相对 root 的展示路径（统一正斜杠，便于点击跳转）。 */
export function relativeToRoot(id: string, root: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const rel = norm(id)
  const base = norm(root)
  if (!base) return rel
  if (rel === base) return ''
  // 必须按路径段对齐：`/foo/bar` 不能匹配 `/foo/barbaz`，否则会切出 `az/x.ts`
  return rel.startsWith(base + '/') ? rel.slice(base.length + 1) : id
}

/**
 * 从 diagnostics 收集**约定诊断**为可上报文本，按 severity 分为 errs（E-*）与 warns（W-*）。
 *
 * `root` 只用于把绝对路径压成相对路径，不影响判定。
 */
export function collectDiagnostics(
  res: CompileResult,
  code: string,
  id: string,
  root: string,
): CollectedDiagnostics {
  const errs: string[] = []
  const warns: string[] = []
  const rel = relativeToRoot(id, root)
  let nl: Int32Array | undefined
  for (const d of res.diagnostics) {
    const list =
      d.conventionErrors?.map((e) => ({ offset: e.start, message: e.message, severity: e.severity })) ?? []
    for (const e of list) {
      nl ??= newlineIndex(code)
      const at = offsetToLineCol(code, e.offset, nl)
      const line = `${rel}:${at} [${d.className}] ${e.message}`
      ;(e.severity === 'warn' ? warns : errs).push(line)
    }
  }
  return { errs, warns }
}

/**
 * 按 mode 上报违规：error 走插件上下文的 `this.error`（阻断构建），warn 走控制台。
 *
 * `thisArg` 是 Rollup/Vite 的插件上下文；纯 API 调用时传 undefined 也能工作
 * （退化为 `throw`）。
 */
export function reportDiagnostics(
  msgs: string[],
  mode: ConventionMode,
  head: string,
  thisArg: any,
): void {
  if (mode === 'silent' || !msgs.length) return
  const text = head + '\n  ' + msgs.join('\n  ')
  if (mode === 'error') {
    const err = thisArg?.error?.bind(thisArg)
    if (err) err(new Error(text))
    else throw new Error(text)
  } else {
    console.warn(text)
  }
}

/**
 * 一站式上报：W 码恒为控制台提示（不随档位阻断），E 码按 mode 处理。
 *
 * 返回是否发生了阻断（仅用于调用方决定是否继续）。
 */
export function reportConventionDiagnostics(
  collected: CollectedDiagnostics,
  mode: ConventionMode,
  thisArg: any,
  tag = '[compelem/compiler]',
): void {
  if (mode === 'silent') return
  const { errs, warns } = collected
  if (warns.length) console.warn(`${tag} ${warns.length} 条提示：\n  ` + warns.join('\n  '))
  reportDiagnostics(errs, mode, `${tag} 检测到 ${errs.length} 处约定错误：`, thisArg)
}
