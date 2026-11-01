/**
 * `@resource` 编译期前移：装饰器只做标注，运行期不留任何装饰器逻辑。
 *
 * 与五族（`@prop` / `@state` / `@computed` / `@query`）和方法装饰器
 * （`@debounced` / `@throttled` / `@onced`）同一套机制，产物形态：
 *
 * ```ts
 * @resource<Row[]>((self, sig) => fetchRows(self.q, sig), { timeout: 2500, immediate: false })
 * rows!: ResourceView<Row[]>
 * ```
 * ⇒ 删除整个字段声明（含装饰器），在类体注入 loader 方法
 *
 * ```js
 * __rl_rows(__signal) { return ((self, sig) => fetchRows(self.q, sig))(this, __signal) }
 * ```
 * 并把 `{ timeout: 2500, immediate: false }` 写进 `__ce_static__.resources`。
 * 视图访问器不在这里生成：运行期 `CompElem` 按该表在原型上装 `get rows()`。
 *
 * ## 字段名即资源名
 *
 * 字段名既是静态表的 key，也是原型访问器的名字，TS 类型与运行期形态一致：
 * `rows!: ResourceView<Row[]>` 声明什么，`this.rows` 就是什么。
 * 资源没有旁生的派生名，状态与操作都挂在这个字段的视图对象上。
 *
 * 该名字会出现在 `CompElem` 的原型链上，因此不能与既有成员同名（`render`、
 * `slots`、`toString` 等）：安装时原型链上已有同名键会被跳过，资源静默不可用。
 * 这类名字报 E-RESOURCE，见 {@link RESERVED_NAMES}。
 *
 * ## loader 的签名约束
 *
 * `(self, sig) => …` 位于装饰器实参位置，那里的 `this` 是模块作用域的 `this`
 * （globalThis），TS 报 TS7041。实例不能靠词法 `this` 取，而是由编译期作为
 * 第一个实参注入：表达式原样搬进 `__rl_<name>`，以 `expr(this, signal)` 调用。
 *
 * 因此 loader / source 必须是内联箭头函数（引用式写法拿不到这个实参），
 * 且 loader 声明两个形参。违反时报 E-RESOURCE。
 *
 * ## 失败策略
 *
 * 与其余族一致：**逐组件 all-or-nothing**。任一 `@resource` 的选项不可静态解析
 * → 整族不删不注并报 E-RESOURCE。运行时已无定义路径（装饰器是空壳），
 * E 码是唯一保护。
 */
import type { ComponentAnalysis } from '../types'
import { DEBUG_DIV } from '../types'
import { keyName } from '../utils/ast'
import { decoratorName, unwrapTsExpr, type ConventionError, type ConventionsContext } from './conventions'
import { lineSpan } from './watch-extract'

export interface ResourceExtractResult {
  /** 注入类体的源码：视图访问器 + `__rl_<name>` / `__rs_<name>` 私有方法 */
  accessors: string
  /** `__ce_static__.resources` 字面量值；本类无 @resource 时 undefined */
  resourcesCode?: string
  /** 需从源码删除的 span（整个字段声明，含装饰器） */
  removals: Array<{ start: number; end: number }>
  /** 访问器所需的模块级运行时函数（走 helperBindings 定名） */
  runtimeHelpers: string[]
  errors: ConventionError[]
}

const CODE = 'E-RESOURCE'

/** 选项闭集，逐字对齐运行期 `ResourceDecoratorOptions` */
const OPT_KEYS: ReadonlySet<string> = new Set(['timeout', 'immediate', 'track', 'source'])

/** 合法标识符：资源名要拼进 `get <name>()`，非法名会生成坏代码 */
const IDENT = /^[A-Za-z_$][\w$]*$/

/**
 * 不能用作资源名的成员：`CompElem` 原型上的访问器、方法与生命周期回调，
 * 外加 `Object.prototype` 的成员。
 *
 * 运行期按 `__ce_static__.resources` 在原型上装 `get <name>()`，安装前会检查
 * 原型链上是否已有同名键，有则跳过 —— 撞名的结果是资源**静默不可用**。
 * 编译器无法读到运行期原型（`CompElem` 继承 `HTMLElement`，Node 侧无法加载），
 * 这份名单与 `src/CompElem.ts` 的成员表同步维护。
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  // 访问器
  'cid', 'attrs', 'props', 'renderRoot', 'renderRoots', 'parentComponent',
  'wrapperComponent', 'rootComponent', 'slots', 'slotHooks', 'cssSheets',
  'cssVars', 'isMounted', 'isDestroyed',
  // 方法
  'insertStyleSheet', 'setup', 'propsReady', 'render', 'beforeMount', 'mounted',
  'beforeDestroyed', 'destroyed', 'destroy', 'slotChange', 'afterUpdate',
  'updateProps', 'getSubViewNodes', 'emit', 'nextTick', 'defineSignalField',
  'forceUpdate',
  // 生命周期回调
  'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback',
  // Object.prototype
  'constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', '__proto__',
])

/** 编译期注入的私有方法前缀 */
export const LOADER_PREFIX = '__rl_'
export const SOURCE_PREFIX = '__rs_'

/** 迁移提示：给出可直接照抄的写法 */
const MIGRATE =
  '\n  正确形态（loader 是第一个参数，选项可选）：\n' +
  '    @resource((self, signal) => …, { timeout: 3000 })\n' +
  '    rows!: ResourceView<Row[]>\n' +
  '  之后模板里写 this.rows.data / this.rows.busy / this.rows.load()。'

export function extractResources(
  comp: ComponentAnalysis,
  code: string,
  ctx: ConventionsContext,
): ResourceExtractResult {
  const result: ResourceExtractResult = { accessors: '', removals: [], runtimeHelpers: [], errors: [] }
  const cls = comp.cls ?? ctx.localClasses.get(comp.className)
  if (!cls) return result

  const isResourceDeco = (d: string) => comp.compelemImports.get(d) === 'resource'

  // ---- 第一遍：找被 @resource 标注的成员 ----
  const members: any[] = cls.body?.body ?? []
  const targets: Array<{ member: any; dec: any; rawName: string }> = []
  for (const member of members) {
    const dec = (member.decorators ?? []).find((d: any) => {
      const n = decoratorName(d)
      return n ? isResourceDeco(n) : false
    })
    if (!dec) continue
    targets.push({ member, dec, rawName: keyName(member.key) ?? '' })
  }
  if (!targets.length) return result

  const fail = (member: any, dec: any, message: string) => {
    const dStart = dec?.start ?? member.start
    result.errors.push({ start: Math.min(member.start, dStart), end: member.end, message })
  }

  /** 本族已提交的资源名，用于同类内重复检查（TS 也会报，但这里给更直白的 E 码） */
  const emitted = new Set<string>()
  const entries: string[] = []
  let accessors = ''
  const removals: Array<{ start: number; end: number }> = []

  for (const { member, dec, rawName } of targets) {
    // ---- 形态：必须是字段声明 ----
    // 方法形态（旧 API）落到这条分支，错误信息直接给出字段写法。
    if (member.type !== 'PropertyDefinition') {
      fail(member, dec, `${CODE}: @resource 只能装饰字段声明。${MIGRATE}`)
      continue
    }
    if (!rawName) {
      fail(member, dec, `${CODE}: 无法识别被装饰的字段名（计算属性键不支持）`)
      continue
    }
    if (rawName.startsWith('#')) {
      fail(member, dec, `${CODE}: 不支持私有字段（'${rawName}'）——视图访问器要挂在原型上才能被模板读取`)
      continue
    }
    if (!IDENT.test(rawName)) {
      fail(member, dec, `${CODE}: 资源名 '${rawName}' 不是合法标识符（要用作 get ${rawName}()）`)
      continue
    }
    // 访问器按表装到原型上，原型链上已有同名键时会被跳过，资源静默不可用。
    if (RESERVED_NAMES.has(rawName)) {
      fail(
        member, dec,
        `${CODE}: 资源名 '${rawName}' 与 CompElem 原型链上的成员同名——` +
        `访问器不会安装，this.${rawName} 取不到资源视图。请改用其它字段名`,
      )
      continue
    }
    // 下面两条不报错会静默改变语义：字段整段删除后换成 getter，
    // 初始值与 static 成员上的内容都会消失。
    if (member.static === true) {
      fail(member, dec, `${CODE}: 不支持静态资源（'${rawName}'）——注入的是实例 getter，static 成员会被整段删掉`)
      continue
    }
    if (member.value != null) {
      fail(
        member, dec,
        `${CODE}: 字段不能带初始值（'${rawName} = …'）——值只由 loader 提供，` +
        `写在字段上的初始值会被删掉，且不会报错`,
      )
      continue
    }
    if (emitted.has(rawName)) {
      fail(member, dec, `${CODE}: '${rawName}' 已经有另一个 @resource，资源名必须唯一`)
      continue
    }
    const otherDecos = (member.decorators ?? [])
      .map(decoratorName)
      .filter((d: string | null) => d && !isResourceDeco(d))
    if (otherDecos.length) {
      fail(member, dec, `${CODE}: @resource 不能与其它装饰器同用（'${rawName}' 上还有 @${otherDecos.join(' / @')}）`)
      continue
    }

    // ---- 参数：@resource(loader, options?) ----
    const callArgs: any[] = dec.expression?.type === 'CallExpression' ? (dec.expression.arguments ?? []) : []
    if (callArgs.length < 1 || callArgs.length > 2) {
      fail(member, dec, `${CODE}: @resource 需要 (loader, options?) 两个参数以内${MIGRATE}`)
      continue
    }

    const loaderNode = unwrapTsExpr(callArgs[0])
    if (loaderNode?.type !== 'ArrowFunctionExpression') {
      // 旧形态（loader 写在选项对象里）落到这条分支，错误信息给出可照抄的签名
      fail(
        member, dec,
        loaderNode?.type === 'ObjectExpression'
          ? `${CODE}: 形态已改为 @resource(loader, options?)——loader 从选项对象移到第一个参数${MIGRATE}`
          : `${CODE}: 第一个参数须是内联箭头函数 (self, signal) => …——编译期要把这段表达式搬进实例方法，引用式写法拿不到组件实例`,
      )
      continue
    }
    // 装饰器实参里的 this 是 globalThis（TS7041），实例只能显式传。
    // 形参个数必须对上，否则调用时 signal 会串到 self 上。
    if ((loaderNode.params ?? []).length !== 2) {
      fail(
        member, dec,
        `${CODE}: loader 必须声明两个形参 (self, signal) —— 装饰器实参里没有 this，组件实例要显式传进来`,
      )
      continue
    }

    /** loader 表达式切片（搬进方法体后 `this` 才是实例） */
    const loaderExpr = `(${code.slice(loaderNode.start, loaderNode.end)})`
    let sourceExpr: string | undefined
    const keep: string[] = []
    let optsBad = false

    // ---- 选项（第二个参数，可选）：必须是内联对象字面量 ----
    let optsNode: any
    if (callArgs.length === 2) {
      optsNode = unwrapTsExpr(callArgs[1])
      if (optsNode?.type !== 'ObjectExpression') {
        fail(member, dec, `${CODE}: 第二个参数须是内联对象字面量（变量/import 无法静态前移）`)
        continue
      }
    }

    for (const p of optsNode?.properties ?? []) {
      if (p.type === 'SpreadElement' || p.type === 'ExperimentalSpreadProperty') {
        fail(member, dec, `${CODE}: 选项不支持展开（spread 无法静态前移），请逐项写出`)
        optsBad = true
        break
      }
      if (p.computed) {
        fail(member, dec, `${CODE}: 选项键无法静态解析（计算属性键不支持）`)
        optsBad = true
        break
      }
      const k = keyName(p.key)
      if (!k) {
        fail(member, dec, `${CODE}: 选项键无法静态解析（计算属性键不支持）`)
        optsBad = true
        break
      }
      if (!OPT_KEYS.has(k)) {
        // 三代键名（loader / fetch / fetcher）都点名，错误信息直接给出正确形态
        const moved =
          k === 'loader' || k === 'fetch' || k === 'fetcher'
            ? `'${k}' 不是选项——loader 是第一个参数，写成 @resource((self, signal) => …)${MIGRATE}`
            : ''
        fail(member, dec, `${CODE}: ${moved}未知选项 '${k}'——ResourceDecoratorOptions 仅支持 ${[...OPT_KEYS].join(' / ')}`)
        optsBad = true
        break
      }
      if (k === 'source') {
        const v = unwrapTsExpr(p.value)
        if (v?.type !== 'ArrowFunctionExpression') {
          fail(
            member, dec,
            `${CODE}: source 须是内联箭头函数 (self) => …——` +
            `编译期要把这段表达式搬进实例方法，引用式写法拿不到组件实例`,
          )
          optsBad = true
          break
        }
        if ((v.params ?? []).length > 1) {
          fail(member, dec, `${CODE}: source 最多接收一个形参 (self)`)
          optsBad = true
          break
        }
        sourceExpr = `(${code.slice(v.start, v.end)})`
        continue
      }
      keep.push(code.slice(p.start, p.end))
    }
    if (optsBad) continue

    // ---- 通过：生成私有方法 + 视图访问器 ----
    emitted.add(rawName)
    const keyLit = JSON.stringify(rawName)

    accessors +=
      `${DEBUG_DIV} resource ${rawName}\n` +
      `${LOADER_PREFIX}${rawName}(__signal) { return ${loaderExpr}(this, __signal) }\n` +
      (sourceExpr ? `${SOURCE_PREFIX}${rawName}() { return ${sourceExpr}(this) }\n` : '')

    const parts = keep.slice()
    if (sourceExpr) parts.push('source: true')
    entries.push(`${keyLit}: { ${parts.join(', ')} }`)

    removals.push(lineSpan(code, Math.min(member.start, dec.start ?? member.start), member.end))
  }

  if (!removals.length) return result

  result.accessors = accessors
  result.removals = removals
  result.resourcesCode = `{ ${entries.join(', ')} }`
  return result
}
