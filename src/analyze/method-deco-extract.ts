/**
 * 方法装饰器编译期前移：@debounced / @throttled / @onced。
 *
 * 与 @watch / 五族前移同构（analyze/watch-extract.ts、field-extract.ts）：
 *   - 静态提取装饰器参数 → 生成**构造体注入语句**（逐条直线代码，无计划表、无运行时遍历）；
 *   - 从源码中删除装饰器本身（**方法体保留**）；
 *   - 生成 destroy 注入语句（cancel + 置**空操作函数**）。
 *
 * 产物形态（对齐原运行时 `DebouncedDecorator.created` 等）：
 *
 *   @throttled(100) onScroll() { this.sync() }
 *   ⇒ 构造体：const __f0 = this.onScroll; this.onScroll = throttle(__f0, 100); this.onScroll_$__ = __f0
 *   ⇒ destroy：this.onScroll = () => {}; this.onScroll_$__ = () => {}
 *
 *   @debounced(50, true) onSearch(kw) { … }
 *   ⇒ 构造体：const __f1 = this.onSearch;
 *             const __g1 = function (...a) { if (this?.isDestroyed) return; return __f1.apply(this, a) }
 *             this.onSearch = debounce(__g1, 50, true); this.onSearch_$__ = __g1
 *   ⇒ destroy：this.onSearch?.cancel?.(); this.onSearch = () => {}; this.onSearch_$__ = () => {}
 *
 *   @onced init() { … }
 *   ⇒ 构造体：const __f2 = this.init.bind(this); this.init = once(__f2); this.init_$__ = __f2
 *   ⇒ destroy：this.init = () => {}; this.init_$__ = () => {}
 *
 * ⚠️ destroy 里**置空操作函数而非 null**：库里存在若干「一次性定时器 / 手工 debounce」
 * 的迟到回调，会在组件销毁后仍直接 `this.decoMethod()`。若置 null 会抛
 * "X is not a function"；置 no-op 则静默无害（这些方法本就只在存活期有意义）。
 * 注意 no-op 是**真值**（null 是假值），故不要依赖销毁后 `if (this.X)` 为假。
 *
 * ⚠️ **三个装饰器的 `_$__` 语义各不相同**（已实测确认）：
 *   - debounced：包裹 **guard**（含 isDestroyed），`_$__` **也是 guard**
 *   - throttled：包裹**原函数**（无 guard），`_$__` 是**原函数**
 *   - onced：包裹 `once(base)`，`_$__` 是 **bind 后**的原函数
 *   ⇒ 注入代码必须按类型分支，**不能统一写法**。
 *
 * ⚠️ **必须先把原型方法捞进临时变量**（`const __f = this.onX`）：包装后
 * `this.onX` 即指向包装结果，再取就是递归。
 *
 * ⚠️ **继承**：只处理**本类 own** 的装饰器。祖先的 constructor 已经执行过自己的
 * 包装注入；子类再注入一遍会造成 debounce/throttle 双层包装与 _$__ 覆盖。
 *
 * **逐族 all-or-nothing + 失败即报错**：任一成员参数不可静态解析 → 该族整体
 * 不删不注并报 E 码。运行时装饰器已无定义路径，E 码是唯一保护。
 */
import type { ComponentAnalysis } from '../types'
import { keyName, IDENT_RE } from '../utils/ast'
import { decoratorName, unwrapTsExpr, type ConventionError, type ConventionsContext } from './conventions'
import { isBooleanLit, isNumericLit, isNumericUnary } from './literal-meta'
import { lineSpan } from './watch-extract'

export interface MethodDecoResult {
  /** 构造体注入语句（多条以 '\n' 连接；空表示无注入） */
  ctorStmts: string
  /** destroy 注入语句 */
  destroyStmts: string
  /** 需删除的 span（**只删装饰器本身**，方法体保留） */
  removals: Array<{ start: number; end: number }>
  /** 运行时的包装函数名（`debounce` / `throttle` / `once`），供文件级 import 注入 */
  runtimeHelpers: string[]
  errors: ConventionError[]
}

type Kind = 'debounced' | 'throttled' | 'onced'

/** 本地变量前缀（避开用户标识符；`__` 前缀与框架其余注入一致）。 */
const TMP_F = '__ce_mdf'
const TMP_G = '__ce_mdg'
/** destroy 时给装饰器方法（及其 `_$__`）写入的空操作实现（见文件头注释）。 */
const NOOP = '() => {}'

/**
 * 提取组件类上的方法装饰器。祖先条目并入（祖先在前），但 removals 只记本类。
 */
export function extractMethodDecos(
  comp: ComponentAnalysis,
  code: string,
  ctx: ConventionsContext,
): MethodDecoResult {
  const result: MethodDecoResult = { ctorStmts: '', destroyStmts: '', removals: [], runtimeHelpers: [], errors: [] }
  const cls = comp.cls ?? ctx.localClasses.get(comp.className)
  if (!cls) return result

  const kindOf = (local: string): Kind | null => {
    const imported = comp.compelemImports.get(local)
    if (imported === 'debounced') return 'debounced'
    if (imported === 'throttled') return 'throttled'
    if (imported === 'onced') return 'onced'
    return null
  }

  /** 全局计数器，保证临时变量名不冲突（祖先 + 本类共用一个序列）。 */
  let seq = 0
  let failed = false
  const usedHelpers = new Set<string>()

  /**
   * 解析 `wait`：数字字面量（含一元负号）/ 模块级 `const` 数字。
   * ⚠️ ESTree 形态 —— 是 `Literal` + `value`，**不是** `NumericLiteral`。
   * 故必须用 literal-meta 的判定函数，不能直接比 `type === 'NumericLiteral'`
   * （曾因此让 `@debounced(50)` 全部误报 E-METHOD-DECO-ARG）。
   */
  const resolveWait = (arg: any): number | null => {
    if (!arg) return null
    const n = unwrapTsExpr(arg)
    if (isNumericLit(n)) return n.value
    if (isNumericUnary(n)) {
      const v = unwrapTsExpr(n.argument).value
      return n.operator === '-' ? -v : v
    }
    // 模块级 const：`const W = 200` → moduleConsts 存 init 节点
    if (n?.type === 'Identifier') {
      const init = ctx.moduleConsts?.get(n.name)
      if (init) {
        const i = unwrapTsExpr(init)
        if (isNumericLit(i)) return i.value
        if (isNumericUnary(i)) {
          const v = unwrapTsExpr(i.argument).value
          return i.operator === '-' ? -v : v
        }
      }
    }
    return null
  }

  const resolveBool = (arg: any): boolean | null => {
    if (!arg) return null
    const n = unwrapTsExpr(arg)
    if (isBooleanLit(n)) return n.value
    if (n?.type === 'Identifier') {
      const init = ctx.moduleConsts?.get(n.name)
      if (init && isBooleanLit(unwrapTsExpr(init))) return unwrapTsExpr(init).value
    }
    return null
  }

  /** 处理本类节点（祖先 constructor 已自行完成包装，不能重复注入）。 */
  const collect = (node: any): void => {
    const push = (s: string) => { result.ctorStmts += (result.ctorStmts ? '\n' : '') + s }

    const handle = (member: any, dec: any): void => {
      const memberName = keyName(member.key)
      if (!memberName) return
      const dn = decoratorName(dec)
      if (!dn) return
      const kind = kindOf(dn)
      if (!kind) return
      // 目标校验由 checkConventions 的 E-DECO-TARGET 负责；这里只拒绝“明显不能包装”
      // 的形态，避免 conventions: 'warn' 时产出 `this.getter = ...` 这类运行期崩溃。
      if (member.kind !== 'method' || member.static || memberName.startsWith('#')) return

      const expr = dec.expression ?? dec
      const args: any[] = expr.type === 'CallExpression' ? (expr.arguments ?? []) : []

      const fail = (msg: string) => {
        failed = true
        result.errors.push({
          start: dec.start ?? expr.start ?? member.start,
          end: dec.end ?? expr.end ?? member.end,
          message: msg,
        })
      }

      // 产物 emit `this.<name>` / `this.<name>_$__` 点访问：字符串字面量方法名
      // （`'my-fn'(){}`）经 keyName 取出后不是合法标识符，直接拼接会产出非法 JS
      if (!IDENT_RE.test(memberName)) {
        fail(`E-METHOD-DECO-ARG: @${kind} 目标方法名 '${memberName}' 不是合法标识符，无法前移（产物为 this.<name> 点访问）`)
        return
      }

      if (kind === 'onced') {
        // 无参
        if (args.length) { fail(`E-METHOD-DECO-ARG: @onced 不接受参数`); return }
        const f = `${TMP_F}${seq++}`
        push(`const ${f} = this.${memberName}.bind(this);`)
        push(`this.${memberName} = once(${f});`)
        push(`this.${memberName}_$__ = ${f};`)
        result.destroyStmts += (result.destroyStmts ? '\n' : '') +
          `this.${memberName} = ${NOOP}; this.${memberName}_$__ = ${NOOP};`
        usedHelpers.add('once')
      } else {
        const waitArg = args[0]
        const wait = resolveWait(waitArg)
        if (wait === null || !Number.isFinite(wait)) {
          fail(`E-METHOD-DECO-ARG: @${kind} 的 wait 无法静态解析（须为数字字面量或模块级 const 数字）`)
          return
        }
        let immediate = false
        if (kind === 'debounced' && args.length > 1) {
          const b = resolveBool(args[1])
          if (b === null) { fail(`E-METHOD-DECO-ARG: @debounced 的 immediate 必须是布尔字面量`); return }
          immediate = b
        }
        if (kind === 'throttled' && args.length > 1) {
          fail(`E-METHOD-DECO-ARG: @throttled 不接受第二个参数`)
          return
        }

        const f = `${TMP_F}${seq++}`
        push(`const ${f} = this.${memberName};`)

        if (kind === 'debounced') {
          // 包装 guard；guard 自身也是 _$__
          const g = `${TMP_G}${seq++}`
          push(`const ${g} = function (...__a) { if (this?.isDestroyed) return; return ${f}.apply(this, __a) };`)
          push(`this.${memberName} = debounce(${g}, ${wait}, ${immediate});`)
          push(`this.${memberName}_$__ = ${g};`)
          result.destroyStmts += (result.destroyStmts ? '\n' : '') +
            `this.${memberName}?.cancel?.(); this.${memberName} = ${NOOP}; this.${memberName}_$__ = ${NOOP};`
          usedHelpers.add('debounce')
        } else {
          // throttled：包装原函数，_$__ 即原函数（**无 guard**）。
          // destroy 必须 cancel()：throttle 的尾随定时器回调调的是**原始 fn**（myfx
          // throttle.ts 的 proxy），不经过 `this.<name>`，所以置 NOOP 拦不住它 ——
          // 不 clear 就会在销毁后仍执行一次原方法（访问已拆的 DOM）。
          push(`this.${memberName} = throttle(${f}, ${wait});`)
          push(`this.${memberName}_$__ = ${f};`)
          result.destroyStmts += (result.destroyStmts ? '\n' : '') +
            `this.${memberName}?.cancel?.(); this.${memberName} = ${NOOP}; this.${memberName}_$__ = ${NOOP};`
          usedHelpers.add('throttle')
        }
      }

      result.removals.push(lineSpan(code, dec.start ?? expr.start - 1, dec.end ?? expr.end))
    }

    for (const member of node.body?.body ?? []) {
      if (member.type !== 'MethodDefinition') continue
      // 多个包装装饰器叠在同一方法上：产物是构造期「读 this.x → 包装 → 写回」，
      // 两次写回互相覆盖 ⇒ 只有一个包装真正生效，且生效的顺序与 TS 装饰器语义相反。
      // 这种组合没有可解释的运行期语义，直接阻断（不猜用户意图）。
      const kinds: string[] = []
      for (const d of member.decorators ?? []) {
        const dn = decoratorName(d)
        if (dn && kindOf(dn)) kinds.push(dn)
      }
      if (kinds.length > 1) {
        failed = true
        result.errors.push({
          start: member.start ?? 0,
          end: member.end ?? 0,
          message:
            `E-METHOD-DECO-STACK: 方法 '${keyName(member.key) ?? '?'}' 上叠加了 ` +
            `${kinds.map((k) => '@' + k).join(' / ')} —— 多个包装装饰器会互相覆盖，` +
            `产物只有最后一次赋值生效。请只保留一个`,
        })
        continue
      }
      for (const dec of member.decorators ?? []) {
        handle(member, dec)
      }
    }
  }

  // 只处理本类：同文件祖先的 constructor 已经包装过；跨文件祖先也由各自文件处理。
  // 再注入一遍会造成 debounce(throttle) 双层包装与 _$__ 覆盖。
  collect(cls)

  // ⚠️ 用户已声明 own `beforeDestroyed` ⇒ **整体放弃前移并报 E 码**。
  // 原因：清理语句要注入成一个 `beforeDestroyed()` 重写，若用户已有一个，注入会
  // 产生重复方法定义（后者覆盖前者 → 用户逻辑静默丢失）。而"只跳过清理、保留包装"
  // 会造成包装了却永不 cancel 的泄漏 —— 比不包装更难查。故与其它失败一样走
  // all-or-nothing（不删不注 + E 码阻断）。
  if (!failed && result.ctorStmts) {
    const dup = (cls.body?.body ?? []).find(
      (m: any) => m.type === 'MethodDefinition' && m.static !== true && keyName(m.key) === 'beforeDestroyed',
    )
    if (dup) {
      result.errors.push({
        start: dup.start,
        end: dup.end,
        message:
          'E-METHOD-DECO-HOOK: 组件自带 `beforeDestroyed()`，方法装饰器（@debounced/@throttled/@onced）' +
          '的清理需要重写该钩子 —— 请把清理逻辑并入你的 beforeDestroyed，或移除该装饰器',
      })
    }
  }

  if (failed || result.errors.length) {
    // 逐族 all-or-nothing：整体放弃（不删不注），运行时装饰器路径已无定义 —— 由 E 码阻断
    result.ctorStmts = ''
    result.destroyStmts = ''
    result.removals = []
    result.runtimeHelpers = []
    return result
  }

  result.runtimeHelpers = [...usedHelpers]
  return result
}
