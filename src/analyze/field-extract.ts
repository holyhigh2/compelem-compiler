/**
 * @prop/@state/@computed/@query/@queryAll 编译期访问器前移。
 *
 * 与 @watch 前移同构（analyze/watch-extract.ts）：
 *   - 静态提取五族装饰器配置 → 生成类体访问器（get/set）+ `__ce_static__` 元数据
 *     （props/states/computedGetters），并从源码中删除成员：
 *     prop/state 字段**整体删除**，初始值改写入构造体 `this.__data_[key]=v`
 *     （无构造则合成；#initProps/#initStates 以 this.__data_[key] 为默认值，
 *     不依赖 own 字段遮蔽与 delete）；computed 整体替换为缓存读取 getter
 *     （原体外提为 computedGetters）；query 整体删除字段（注入懒查询 getter）；
 *   - 访问器经模块级运行时函数直调（`signal` / `signalComputed` / `writeModelProp` /
 *     `_queryGet` / `_observedAttrs`，见 RUNTIME_HELPERS）；编译注入 compelem import，
 *     模块绑定冲突时改用 __ce_ 前缀别名；
 *   - **逐族 all-or-nothing + 失败即报错（E 码，error 级默认阻断构建）**：
 *     族内任一成员不可静态解析 → 该族整体放弃（不删不注）并产出约定错误。
 *     运行时五族装饰器已无定义路径（@prop 运行时为 no-op）——E 码是唯一保护。
 *
 * 静态解析范围（文件内静态分析）：
 *   - options：对象字面量，或模块级 `const OPTS = {...}` 标识符（init 源码原样
 *     内联进注入字面量——同模块作用域下与装饰器参数等价求值）；
 *   - selector：字符串字面量 / 模块级 const 字符串（resolveSources）；
 *   - 不支持 → E 码：import 的 options/selector、let/运行时拼接、computed 体内
 *     super、族外/多族装饰器同居（须拆分独立成员，E-DECO-COEXIST）。
 *
 * 已知限制（有意）：
 *   - query 字段被整体删除 → mounted 前读取从「字段 undefined」变为「即时查询结果」；
 *   - skipInjection 类照常提取并注入：`__ce_static__` 以 `...父类.__ce_static__`
 *     spread 继承视图字段，own 家族字段（props/states/computedGetters）
 *     显式覆盖——缺失时显式写 `[]`/`undefined`，防止 spread 把父类条目误当 own。
 */
import type { ComponentAnalysis } from '../types'
import { DEBUG_DIV } from '../types'
import { keyName } from '../utils/oxc'
import { superClassName } from './component'
import { decoratorName, unwrapTsExpr, type ConventionError, type ConventionsContext } from './conventions'
import { inferInitMeta } from './literal-meta'
import { lineSpan, resolveSources } from './watch-extract'

export interface FieldExtractResult {
  /** 需从源码删除的 span（prop/state/computed/query 整个成员），已做整行清理 */
  removals: Array<{ start: number; end: number }>
  /** 类体注入的访问器代码（prop/state/computed 的 get/set，以及 **`@tag` 类**的
   *  `static get observedAttributes()`），每行以 \n  结尾。无 `@tag` 的类不带
   *  observedAttributes。 */
  accessors: string
  /** `__ce_static__.props` 字面量值（prop 族无成员时 undefined） */
  propsCode?: string
  /** `__ce_static__.states` 字面量值 */
  statesCode?: string
  /** `__ce_static__.computedGetters` 字面量值（方法简写 name(){...}） */
  computedCode?: string
  /** prop/state 初始值 → 构造体写入语句素材（原字段声明改写为构造体赋值） */
  fieldInits: Array<{ name: string; initText: string }>
  /** 本组件访问器所需的模块级运行时函数名（已按 bindings 定名） */
  runtimeHelpers: string[]
  /**
   * 提取期约定错误：E-PROP-ARG / E-STATE-ARG / E-COMPUTED-ARG / E-QUERY-ARG /
   * E-DECO-COEXIST。与条目互斥的族级约定（该族有错 → 不删不注），其余族不受影响。
   */
  errors: ConventionError[]
}

type Family = 'prop' | 'state' | 'computed' | 'query'

/** 访问器生成所需的模块级运行时函数（编译注入 compelem import）。 */
export const RUNTIME_HELPERS = ['signal', 'signalComputed', 'writeModelProp', '_queryGet', '_observedAttrs'] as const

const IDENT_RE = /^[A-Za-z_$][\w$]*$/

const FAM_CODE: Record<Family, string> = {
  prop: 'E-PROP-ARG',
  state: 'E-STATE-ARG',
  computed: 'E-COMPUTED-ARG',
  query: 'E-QUERY-ARG',
}

/**
 * `static get observedAttributes()` 的注入体。
 *
 * 体只有一句 `_observedAttrs(this)`：属性名表由**运行时**从合并后的
 * `__ce_static__.props` 推导（compelem/src/CompElem.ts），编译器不生成 kebab 名单。
 *
 * 为什么不能采用「own 属性字面量 + `super.observedAttributes` 并集」的写法：
 * 那样**有 `@tag` 子类的属性表是沿整条继承链拼出来的**，于是无 `@tag` 的基类也必须
 * 带一份自己的表（哪怕它永不被 `customElements.define`、浏览器根本不会读它）。
 * 一旦基类不带，子类就再也拿不到继承来的属性 —— attribute 驱动静默失效
 * （`attributeChangedCallback` 永不触发），链上没有任何 `@tag` 类带 own prop 时更会
 * 整个表变成 undefined。从 props 表推导则不依赖任何祖先的 getter，
 * 「只有 @tag 类带 observedAttributes」才真正安全，且跨文件基类 / mixin 工厂
 * （编译器看不见后代）也照样正确 —— props 表的合并是运行时的展开。
 *
 * 生成物必须是**纯 JS**（注入产物可能被 new Function/JS 环境求值，不得携带类型断言）。
 */
function observedGetter(h: (canon: string) => string): string {
  return `static get observedAttributes() { return ${h('_observedAttrs')}(this) }\n`
}

/**
 * 剔除「同文件祖先已经提供、且与本类要发的**逐字节相同**」的访问器行。
 *
 * 背景：`@prop/@state/@computed` 的访问器是**纯名字驱动**的 ——
 * `get title() { return this.__s.title.value }`，与声明处的初始值无关。于是子类
 * 重新声明同名成员时（为了覆盖默认值，本仓库的基类/子类模式就是这么用的：
 * `ScCommon` 声明 `title = 'untitled'`，`ScPartial` 声明 `title = 'A. 局部更新'`），
 * 它发出的那一行与祖先装在**祖先原型**上的那一行完全相同 —— 遮蔽掉祖先的，且不遮蔽
 * 就毫无区别。属纯死代码：三层链（基类→子类→孙类）能把同一行复制 3 份。
 *
 * **判据是「逐字节相同」而不是「同名」，因为同名不同语义是真实存在的**：
 *   · `@prop({model:true}) value` 的 setter 是 `writeModelProp(...)`（按宿主类型
 *     三路分派），而子类 `@prop value` 的 setter 是 `this.__s.value.value = __v`。
 *     两者文本不同 ⇒ 不跳过。若按「同名就跳」，子类会静默把 model prop 降级成普通
 *     prop，父级再也收不到 `update:value` —— 无报错。
 *   · `@state` 与 `@prop` 同名时文本相同（都是读 `__s.<n>.value`）⇒ 可跳。
 *   · `@computed` 只有 getter，文本与同名 prop 的 getter 相同 ⇒ 可跳。
 *
 * 只沿**同文件** super 链（`ctx.localClasses`）上溯：跨文件基类与 mixin 工厂的成员
 * 编译器看不见（`unknownSuperAdmitted`），它们的访问器无从比较，一律保留。
 * 也只信任 `inheritedAccessors` 里**确实有条目**的祖先 —— 那意味着该祖先的族已成功
 * 提交（族级 all-or-nothing，失败则一行都不发）。祖先没条目就不跳，即使这在理论上
 * 漏掉了可跳的行，也只是多留一行死代码，不会出错。
 */
function dedupeAncestorAccessors(
  comp: ComponentAnalysis,
  ctx: ConventionsContext,
  accessors: string,
  inherited: Map<string, string[]> | undefined,
): string {
  if (!inherited) return accessors
  // 本类自己提供的行（回填累加器，让更下层的子类也能剔）
  const own = accessors.split('\n').filter((l) => l !== '')
  inherited.set(comp.className, own)
  if (own.length <= 1) return accessors // 只有族分块标记，没有访问器

  // 同文件 super 链上，祖先们已提供的所有行
  const provided = new Set<string>()
  const seen = new Set<string>()
  let cur: any = comp.cls ?? ctx.localClasses.get(comp.className)
  while (cur) {
    const sup = superClassName(cur)
    if (!sup || seen.has(sup)) break
    seen.add(sup)
    for (const line of inherited.get(sup) ?? []) provided.add(line)
    cur = ctx.localClasses.get(sup)
  }
  if (!provided.size) return accessors

  // 只删访问器行，保留 `//////// <族名>` 分块标记（它们是给人看的结构注释，
  // 且 inject-e2e 会统计分块数）。分块标记在过滤后可能出现空块，无害。
  return accessors
    .split('\n')
    .filter((l) => l === '' || l.startsWith(DEBUG_DIV) || !provided.has(l))
    .join('\n')
}

/**
 * 提取组件类上可静态化的五族成员。返回的 errors 非空时调用方应把错误并入
 * conventionErrors（error 级阻断构建）；出错的族不删除、不注入。
 *
 * @param inheritedAccessors **文件级**累加器：`类名 → 该类实际生成的访问器行`。
 *   由 compile.ts 在同文件逐个组件调用时传入并回填，用于剔除「同文件祖先已经提供
 *   的、逐字节相同的」访问器行（见文件末 dedupeAncestorAccessors）。传 undefined
 *   时不做任何剔除。
 */
export function extractFieldAccessors(
  comp: ComponentAnalysis,
  code: string,
  ctx: ConventionsContext,
  bindings: Record<string, string> = {},
  inheritedAccessors?: Map<string, string[]>,
): FieldExtractResult {
  const empty: FieldExtractResult = { removals: [], accessors: '', fieldInits: [], runtimeHelpers: [], errors: [] }
  // 组件自身 class 节点：优先 comp.cls（覆盖 mixin 工厂内的函数作用域类），
  // 回退按名查 localClasses（只收模块顶层 class 声明）
  const cls = comp.cls ?? ctx.localClasses.get(comp.className)
  if (!cls) return empty
  /** 运行时函数定名：默认原名，模块绑定冲突时用 __ce_ 前缀别名。 */
  const h = (canon: string) => bindings[canon] ?? canon

  /**
   * 「只有 @tag、没有五族成员」时仍要注入的那部分：`observedAttributes` getter。
   *
   * 与函数末尾的 emit 走同一个生成器，保证两条路径产物完全一致。
   * 条件只看 `comp.tagName`，**不看自有 prop** —— 自有 prop 一个都没有的 @tag 类
   * （属性整张来自无 @tag 基类）同样必须带这个 getter，否则浏览器注册它时读到的
   * observedAttributes 是 undefined，attribute 驱动全部静默失效。
   */
  const tagOnlyObservedAttrs = (): Pick<FieldExtractResult, 'accessors' | 'runtimeHelpers'> => {
    if (!comp.tagName) return { accessors: '', runtimeHelpers: [] }
    return {
      accessors: `${DEBUG_DIV} observedAttributes\n${observedGetter(h)}`,
      runtimeHelpers: ['_observedAttrs'],
    }
  }

  const famOf = (local: string | null): Family | null => {
    if (!local) return null
    const imported = comp.compelemImports.get(local)
    if (imported === 'prop') return 'prop'
    if (imported === 'state') return 'state'
    if (imported === 'computed') return 'computed'
    if (imported === 'query' || imported === 'queryAll') return 'query'
    return null
  }

  // ---- 第一遍：成员分类 + 前置校验（族级 all-or-nothing，失败 → E 码）----
  interface Cand {
    member: any
    family: Family
    dec: any
    /** query 族区分 query / queryAll */
    decLocal: string
  }
  const cands: Cand[] = []
  const failed = new Set<Family>()
  const errors: ConventionError[] = []
  const failMember = (family: Family, member: any, message: string) => {
    errors.push({ start: member.start, end: member.end, message })
    failed.add(family)
  }

  for (const member of cls.body?.body ?? []) {
    const decs: any[] = member.decorators ?? []
    if (!decs.length) continue
    const famDecs = new Map<Family, any[]>()
    let foreign = false
    for (const dec of decs) {
      const fam = famOf(decoratorName(dec))
      if (fam) {
        let arr = famDecs.get(fam)
        if (!arr) famDecs.set(fam, (arr = []))
        arr.push(dec)
      } else foreign = true
    }
    if (!famDecs.size) continue

    const name = keyName(member.key)
    const shownName = name ?? '(匿名)'

    // 族外装饰器（含 @watch/@debounced 等 compelem 装饰器与用户自定义装饰器）同居：
    // 删除范围与语义无法证明互不干扰 → 报错，要求拆分独立成员（决策4）
    if (foreign) {
      const foreignNames = decs
        .filter((d) => !famOf(decoratorName(d)))
        .map((d) => '@' + decoratorName(d))
        .join(' ')
      for (const f of famDecs.keys()) {
        errors.push({
          start: member.start,
          end: member.end,
          message: `E-DECO-COEXIST: 五族成员 '${shownName}' 与其他装饰器（${foreignNames}）同居——请把其他装饰器拆分到独立成员声明`,
        })
        failed.add(f)
      }
      continue
    }
    if (famDecs.size > 1) {
      const famNames = decs.map((d) => '@' + decoratorName(d)).join(' ')
      for (const f of famDecs.keys()) {
        errors.push({
          start: member.start,
          end: member.end,
          message: `E-DECO-COEXIST: 成员 '${shownName}' 同时挂载多个五族装饰器（${famNames}）——请拆分为独立成员声明`,
        })
        failed.add(f)
      }
      continue
    }
    const family = famDecs.keys().next().value as Family
    const nodes = famDecs.get(family)!
    const decLocal = decoratorName(nodes[0])!
    if (nodes.length !== 1) {
      failMember(family, member, `${FAM_CODE[family]}: 成员 '${shownName}' 重复挂载 @${decLocal}`)
      continue
    }

    if (!name || !IDENT_RE.test(name)) {
      failMember(
        family,
        member,
        `${FAM_CODE[family]}: 成员名 '${shownName}' 非法（须为合法标识符）`,
      )
      continue
    }

    if (family === 'prop' || family === 'state') {
      if (member.type !== 'PropertyDefinition' || member.static) {
        failMember(family, member, `${FAM_CODE[family]}: @${decLocal} 只能用于非 static 实例字段（'${name}' 是 ${member.static ? 'static ' : ''}${member.kind ?? member.type}）`)
        continue
      }
    } else if (family === 'computed') {
      if (member.type !== 'MethodDefinition' || member.kind !== 'get') {
        // 非 getter 目标由 conventions E-COMPUTED-NOT-GETTER 报告（避免同点重复）；
        // 此处仅放弃该族——运行时 computed 装饰器仍可兜底。
        failed.add(family)
        continue
      }
      if (member.static) {
        failMember(family, member, `${FAM_CODE[family]}: @computed 只能用于非 static getter（'${name}'）`)
        continue
      }
      if (!member.value?.body || member.value.body.type !== 'BlockStatement') {
        failMember(family, member, `${FAM_CODE[family]}: getter '${name}' 体无法外提（缺块状函数体）`)
        continue
      }
      const bodyText = code.slice(member.value.body.start, member.value.body.end)
      if (/\bsuper\b/.test(bodyText)) {
        // 原体外提为 __ce_static__ 内的普通方法后 super 的 home-object 语义丢失（决策2：不支持
        failMember(family, member, `${FAM_CODE[family]}: getter '${name}' 体内含 super——外提为 __ce_static__ 方法后 home-object 语义丢失，不支持该场景`)
        continue
      }
      const expr = nodes[0].expression ?? nodes[0]
      if (expr.type !== 'Identifier') {
        failMember(family, member, `${FAM_CODE[family]}: @computed 不接受参数（'${name}'）`)
        continue
      }
    } else {
      // query
      if (member.type !== 'PropertyDefinition') {
        // 非字段目标由 conventions E-DECO-TARGET 报告；仅放弃该族
        failed.add(family)
        continue
      }
      if (member.static) {
        failMember(family, member, `${FAM_CODE[family]}: @${decLocal} 只能用于非 static 实例字段（'${name}'）`)
        continue
      }
      const expr = nodes[0].expression ?? nodes[0]
      if (expr.type !== 'CallExpression') {
        failMember(family, member, `${FAM_CODE[family]}: @${decLocal} 必须以调用形式使用（@${decLocal}(selector, cache?)）`)
        continue
      }
      const args = expr.arguments ?? []
      if (args.length === 0 || args.length > 2) {
        failMember(family, member, `${FAM_CODE[family]}: @${decLocal} 参数个数非法（须 1-2 个）`)
        continue
      }
      if (args[0]?.type === 'ArrayExpression') {
        failMember(family, member, `${FAM_CODE[family]}: selector 不支持数组字面量（'${name}'）`)
        continue
      }
      const sel = resolveSources(args[0], ctx)
      if (!sel) {
        failMember(family, member, `${FAM_CODE[family]}: selector 无法静态解析（须字符串字面量或文件内 const 字符串——'${name}'；import/动态值不支持）`)
        continue
      }
      if (sel.length !== 1) {
        failMember(family, member, `${FAM_CODE[family]}: selector 不支持多值（'${name}'）`)
        continue
      }
      // cache 参数：缺省 false；静态字符串按 === QueryCache.ONCE('once') 判定
      if (args[1]) {
        const cacheStrs = resolveSources(args[1], ctx)
        if (cacheStrs && cacheStrs.length === 1) {
          // 'once' 字面量即可；其他字符串按非 ONCE 处理（与运行时 === 语义一致）
        } else if (
          args[1]?.type === 'MemberExpression' &&
          !args[1].computed &&
          keyName(args[1].property) === 'ONCE' &&
          args[1].object?.type === 'Identifier' &&
          comp.compelemImports.get(args[1].object.name) === 'QueryCache'
        ) {
          // QueryCache.ONCE（枚举跨模块无法求值，按绑定精确识别）
        } else {
          failMember(family, member, `${FAM_CODE[family]}: cache 参数无法静态解析（须 'once' 字符串或 QueryCache.ONCE——'${name}'）`)
          continue
        }
      }
    }
    cands.push({ member, family, dec: nodes[0], decLocal })
  }

  if (!cands.length) {
    // 一个五族成员都没有的 @tag 类（如属性全部来自无 @tag 基类的子类）**仍要**
    // emit observedAttributes —— 它的属性表整张来自父表。早退会把它连同
    // runtimeHelpers 一起丢掉，故这里补上，不能直接返回 empty。
    return { ...empty, ...tagOnlyObservedAttrs(), errors }
  }

  // ---- 第二遍：按族生成（任一成员失败 → 整族丢弃 + 已产出 E 码）----
  interface Acc {
    removals: Array<{ start: number; end: number }>
    accessors: string[]
    items: AccItem[]
  }
  interface AccItem {
    name: string
    optsText?: string
    bodyText?: string
    model?: boolean
    attr?: boolean
    selector?: string
    all?: boolean
    once?: boolean
    initText?: string
    /** 编译期推导的构造器名（与运行时 PropTypeMap 同域） */
    inferredType?: string
    /** options 里已显式写了 type → 推导值不得覆盖 */
    explicitType?: boolean
    /** options 里已显式写了 defaultValue → 不得重复 emit */
    explicitDefault?: boolean
    /**
     * `@state m = this.<prop>` 的播种源。
     *
     * 真值由编译器注入 `prop`（运行期键），运行期 `CompElem#initStates` 从
     * `__data_[prop]` 深拷贝回灌信号 —— 声明处的初始值是一句会被立刻覆盖的
     * **死代码**，据此推出来的 defaultValue / type 描述的是那个死值，
     * 写进元数据就是谎报，故播种字段一律不推导。
     */
    seedProp?: string
  }
  const accs: Record<Family, Acc> = {
    prop: { removals: [], accessors: [], items: [] },
    state: { removals: [], accessors: [], items: [] },
    computed: { removals: [], accessors: [], items: [] },
    query: { removals: [], accessors: [], items: [] },
  }

  const memberSpan = (member: any, dec: any) => {
    const dStart = dec.start ?? (dec.expression?.start ?? member.start)
    return lineSpan(code, Math.min(member.start, dStart), member.end)
  }

  /** options 实参 → 可注入的对象字面量节点：字面量直取；Identifier 经 moduleConsts 内联。 */
  const resolveOptsNode = (family: Family, member: any, a0: any): any | null => {
    if (!a0) return null
    if (a0.type === 'ObjectExpression') return a0
    if (a0.type === 'Identifier') {
      const src = a0.name
      if (ctx.importedLocals?.has(src)) {
        failMember(
          family,
          member,
          `${FAM_CODE[family]}: options 标识符 '${src}' 是跨文件导入——import 的 options 不支持（文件内静态分析范围外）`,
        )
        return null
      }
      const init = unwrapTsExpr(ctx.moduleConsts?.get(src))
      if (init?.type === 'ObjectExpression') return init
      failMember(family, member, `${FAM_CODE[family]}: options 标识符 '${src}' 无法解析为文件内 const 对象（须是模块级 const；import/let/运行时拼接不支持）`)
      return null
    }
    failMember(family, member, `${FAM_CODE[family]}: options 无法静态解析（须对象字面量或文件内 const 对象）`)
    return null
  }

  /**
   * `@state m = this.<ident>` → `<ident>`；其余形状（字面量 / 标识符 / 调用 /
   * 可选链 / 计算属性 / `this.a.b`）一律返回 undefined，按普通初始值处理。
   *
   * 注意只识别**非计算的单层** `this.x`：`this` 开头还有别的形状
   * （`this.get()`、`this.a.b`），它们的求值结果不是"播种源名字"，不能猜。
   */
  const parseSeedProp = (value: any): string | undefined => {
    if (value?.type !== 'MemberExpression') return undefined
    if (value.optional === true || value.computed === true) return undefined
    if (value.object?.type !== 'ThisExpression') return undefined
    return value.property?.type === 'Identifier' ? value.property.name : undefined
  }

  /**
   * 本类**本地声明**的 state / computed 字段名。
   *
   * 播种识别必须先把它们排除：`@state a = 1` + `@state b = this.a` 是
   * "抄兄弟字段的初值"，走构造期求值是**正确**的，不能被误判成 prop 播种
   * （播种会去读 `__data_[a]`，那时 `#initStates` 可能还没轮到 a）。
   * 反过来，prop（本类的或从祖先继承的）不在这个集合里，`this.<prop>`
   * 才会走播种分支。
   */
  const localStateishFields = new Set<string>(
    cands
      .filter((c) => c.family === 'state' || c.family === 'computed')
      .map((c) => keyName(c.member.key))
      .filter((k): k is string => !!k),
  )

  for (const { member, family, dec, decLocal } of cands) {
    if (failed.has(family)) continue
    const acc = accs[family]
    const name = keyName(member.key)!
    const expr = dec.expression ?? dec

    if (family === 'prop') {
      let optsText = '{}'
      let attr = true
      let model = false
      let explicitType = false
      let explicitDefault = false
      if (expr.type === 'CallExpression') {
        const args = expr.arguments ?? []
        if (args.length !== 1) {
          failMember(family, member, `${FAM_CODE[family]}: @prop 必须无参或以单参调用（@prop(options)）`)
          continue
        }
        const optsNode = resolveOptsNode(family, member, args[0])
        if (!optsNode) continue
        optsText = code.slice(optsNode.start, optsNode.end)
        for (const p of optsNode.properties ?? []) {
          if (p.type === 'SpreadElement' || p.type === 'ExperimentalSpreadProperty') continue
          const k = keyName(p.key)
          if (k === 'attribute' && p.value?.type === 'BooleanLiteral') attr = p.value.value !== false
          else if (k === 'attribute' && p.value?.type === 'Literal' && typeof p.value.value === 'boolean')
            attr = p.value.value !== false
          else if (k === 'attribute') {
            failMember(family, member, `E-PROP-ARG: attribute 必须是布尔字面量（'${name}'）`)
            break
          } else if (k === 'model') {
            const v = p.value
            const isBool = v?.type === 'BooleanLiteral' || (v?.type === 'Literal' && typeof v.value === 'boolean')
            if (!isBool) {
              failMember(family, member, `E-PROP-ARG: model 必须是布尔字面量（'${name}'）`)
              break
            }
            model = v.value === true
          } else if (k === 'type') {
            explicitType = true
          } else if (k === 'defaultValue') {
            // 默认值不应出现在 @prop/@state options 里 —— 它属于字段初始化器
            // （编译器对字面量推导出 `type`，对非字面量则信号初值即真值）；
            // 当初为旧运行时兜底的 defaultValue 键在信号管线下是死字段。
            failMember(family, member, `E-FIELD-ARG: @${family} 的 options 中不支持 defaultValue —— 直接在字段初始化器上声明改动` )
            explicitDefault = true
          }
        }
        if (failed.has(family)) continue
      }
      const meta = inferInitMeta(member.value, code)
      acc.removals.push(memberSpan(member, dec))
      acc.items.push({
        name,
        optsText,
        model,
        attr,
        initText: member.value ? code.slice(member.value.start, member.value.end) : undefined,
        inferredType: meta.typeName,
        explicitType,
        explicitDefault,
      })
      acc.accessors.push(
        `get ${name}() { return this.__s.${name}.value }\n`,
        // model prop 的 setter 语义按**宿主类型**三路分派，判据全在 writeModelProp 内：
        //   ① compelem 父端接了 update:<name> ⇒ 父端是权威，可能对值做加工（校验、
        //      clamp、格式化）。此时只 emit 不写本地：抢先写会白渲染一次，且用户看到
        //      中间值闪烁（子写 15 → 显示 15 → 父 clamp 到 10 → 回灌 → 又变 10）。
        //      值由父端回写后落回本地，Object.is 去重使其不会重复渲染。
        //   ② 无人接 ⇒ 只 emit 会让值彻底蒸发（CompElem#emit 在无 wrapperComponent 时
        //      直接 return，事件丢弃且本地不落值，用户输入凭空消失）⇒ 本地兜底。
        //   ③ 无人接但宿主声明 emit-native ⇒ 既本地兜底又发原生 CustomEvent。
        model
          ? `set ${name}(__v) { ${h('writeModelProp')}(${JSON.stringify(name)}, __v, this) }\n`
          : `set ${name}(__v) { this.__s.${name}.value = __v }\n`,
      )
    } else if (family === 'state') {
      // 播种：`@state m = this.p` → seedProp。
      //
      // 为什么不能真的当普通初始化求值：字段初始化跑在**构造期**，而 prop 的
      // 真值要到 setup() 里 #initProps() 才落定（父端 property、HTML 属性都
      // 晚于构造）。所以编译器识别出 `this.<ident>` 后**不** emit
      // `signal(this.p)`（那样只拿到默认值），改为注入 `prop`（运行期键），
      // 由 CompElem#initStates 读 `__data_[p]` 深拷贝回灌信号。
      //
      // `this.<x>` 指向本地 state / computed 字段时**不**算播种：
      // 那是"抄兄弟字段初值"，构造期求值才是对的（见 localStateishFields 注释）。
      const rawSeed = parseSeedProp(member.value)
      const seedProp = rawSeed && !localStateishFields.has(rawSeed) ? rawSeed : undefined
      let optsText = '{}'
      let explicitType = false
      let explicitDefault = false
      if (expr.type === 'CallExpression') {
        const args = expr.arguments ?? []
        if (args.length !== 1) {
          failMember(family, member, `E-STATE-ARG: @state 必须无参或以单参调用（@state(options)）`)
          continue
        }
        const optsNode = resolveOptsNode(family, member, args[0])
        if (!optsNode) continue
        optsText = code.slice(optsNode.start, optsNode.end)
        for (const p of optsNode.properties ?? []) {
          if (p.type === 'SpreadElement' || p.type === 'ExperimentalSpreadProperty') continue
          const k = keyName(p.key)
          if (k === 'type') {
            // state 的类型由 TS 标注保证，运行期从不做校验/转换（那是 prop 的 attribute
            // 通道才需要的），故 @state 不接受 type —— 写了也只是被忽略。
            failMember(family, member, `E-FIELD-ARG: @state 的 options 中不支持 type —— 类型由 TS 标注表达，运行期不校验`)
            explicitType = true
          }
          else if (k === 'defaultValue') {
            failMember(family, member, `E-FIELD-ARG: @state 的 options 中不支持 defaultValue —— 直接在字段初始化器上声明`)
            explicitDefault = true
          }
          else if (k === 'prop') {
            // 播种语义由**初始化器**表达（`@state m = this.<prop>`）。
            // 选项值本身就是 prop 名，直接把它翻译成新写法给用户 —— 这样提示
            // 永远是可粘贴的完整替换，不用用户再倒推一遍。
            const optName = typeof (p.value as any)?.value === 'string' ? (p.value as any).value as string : undefined
            const src = member.value ? code.slice(member.value.start, member.value.end) : ''
            const hint = optName !== undefined
              ? `@state ${name} = this.${optName}`
              : seedProp
                ? `@state ${name} = ${src}`
                : `@state ${name} = this.<prop>`
            failMember(
              family,
              member,
              `E-STATE-ARG: @state({prop}) 不是有效语法 —— 改用 ${hint}（初始化器形态；播种仍在 props 落定之后）`,
            )
          }
        }
      }
      // 播种字段的初始值是死代码 → 它的 defaultValue / type 描述的是死值，谎报
      const meta = seedProp ? {} : inferInitMeta(member.value, code)
      acc.removals.push(memberSpan(member, dec))
      acc.items.push({
        name,
        optsText,
        initText: member.value ? code.slice(member.value.start, member.value.end) : undefined,
        inferredType: meta.typeName,
        explicitType,
        explicitDefault,
        seedProp,
      })
      acc.accessors.push(
        `get ${name}() { return this.__s.${name}.value }\n`,
        `set ${name}(__v) { this.__s.${name}.value = __v }\n`,
      )
    } else if (family === 'computed') {
      const bodyText = code.slice(member.value.body.start, member.value.body.end)
      acc.removals.push(memberSpan(member, dec))
      acc.items.push({ name, bodyText })
      acc.accessors.push(`get ${name}() { return this.__s.${name}.value }\n`)
    } else {
      const args = expr.arguments ?? []
      const selector = resolveSources(args[0], ctx)![0]
      let once = false
      if (args[1]) {
        const cacheStrs = resolveSources(args[1], ctx)
        if (cacheStrs && cacheStrs.length === 1) once = cacheStrs[0] === 'once'
        else once = true
      }
      const all = comp.compelemImports.get(decLocal) === 'queryAll'
      acc.removals.push(memberSpan(member, dec)) // 字段声明整体删除（否则 own 字段遮蔽注入 getter）
      acc.items.push({ name, selector, all, once })
      acc.accessors.push(
        `get ${name}() { return ${h('_queryGet')}(${JSON.stringify(selector)}, ${all}, ${once}, this) }\n`,
      )
    }
  }

  // ---- 汇总（族级提交）----
  const removals: Array<{ start: number; end: number }> = []
  let accessors = ''
  let propsCode: string | undefined
  let statesCode: string | undefined
  let computedCode: string | undefined
  const committed = new Set<Family>()
  /** 族块标签（访问器 get/set 的分隔注释） */
  const familyLabel: Record<Family, string> = { prop: 'props', state: 'states', computed: 'computed', query: 'query' }

  /**
   * `__ce_static__.props/states` 单条目文本：`{ …options, type }`。
   *
   * options 保持**原样源码**（不重建属性），spread / 注释 / 多行写法一律原样保留；
   * 推导出来的 `type` 追加到这个对象字面量的属性位里。
   * 故取的是 options 切片的**花括号内部**（`slice(1,-1)`）——直接把整个 `{…}`
   * 当属性塞进去会产出 `{ { type: String }, … }` 这种嵌套字面量。
   *
   * 优先级：显式 `type` > 从默认值推导。
   * （`defaultValue` 已经不再 emit —— 运行期真值始终是信号 `__s[key].value`，
   * 静态表里那个字面量与实例信号是两个不同对象，拿它当默认值会误导。）
   */
  const NO_OPTS = '{}'
  /**
   * options 内部切片 → 去掉首尾空白与**尾逗号**。
   *
   * options 源码原样保留（含尾逗号），而 parts 之间靠 `join(', ')` 分隔：
   * 源码里 `{ type: Object, hasChanged(a,b){…}, }` 这种常见写法会把尾逗号带进来，
   * 与 join 叠加产出 `{ …},\n    ,, defaultValue: … }` —— 语法错误，产物整个文件
   * 解析失败（compelem-ui `base/ControlBox.ts`、`table/ColumnConfigPane.ts` 即此症状，
   * vite 报 `vite:oxc PARSE_ERROR Unexpected token`）。
   *
   * 只吃**最后一个**字符为 `,` 的情况，故注释里带逗号（`{ a: 1 ␟,␟ }` 形式）不受影响。
   */
  function optsInnerText(text: string): string {
    let t = text.trim()
    if (t.charCodeAt(t.length - 1) === 44 /* , */) t = t.slice(0, -1).trim()
    return t
  }
  /**
   * `type` 只对 prop 有意义（运行期 attribute 转换/类型校验要读它）；state 的
   * 类型由 TS 标注保证，运行期从不读 state 的 type，故**不 emit**（省产物字节，
   * 也避免「表里有 type ⇒ 运行时会校验」的错觉）。
   */
  function fieldEntryText(i: AccItem, family: Family): string {
    const parts: string[] = []
    // options 切片恒以 `{` 开头、`}` 结尾（node.start/node.end 即字面量两侧花括号）
    const opts = i.optsText === undefined || i.optsText === NO_OPTS ? '' : optsInnerText(i.optsText.slice(1, -1))
    if (opts) parts.push(opts)
    // 播种源。值是**标识符名字**而非表达式 —— 运行期由 CompElem#initStates
    // 去 `__data_[p]` 取真值，此刻的 `this.p` 求值太早。
    if (i.seedProp !== undefined) parts.push(`prop: ${JSON.stringify(i.seedProp)}`)
    if (family === 'prop' && i.inferredType !== undefined && !i.explicitType) {
      parts.push(`type: ${i.inferredType}`)
    }
    // 无任何可写字段（推导不出、options 为空）时仍是 `{}` 而不是 `{  }`
    if (!parts.length) return `${JSON.stringify(i.name)}: {}`
    return `${JSON.stringify(i.name)}: { ${parts.join(', ')} }`
  }

  const commit = (f: Family, fn: (acc: Acc) => string | undefined) => {
    if (failed.has(f)) return
    const acc = accs[f]
    if (!acc.items.length) return
    removals.push(...acc.removals)
    if (acc.accessors.length) accessors += `${DEBUG_DIV} ${familyLabel[f]}\n`
    accessors += acc.accessors.join('')
    committed.add(f)
    const code2 = fn(acc)
    if (code2 !== undefined) {
      if (f === 'prop') propsCode = code2
      else if (f === 'state') statesCode = code2
      else if (f === 'computed') computedCode = code2
    }
  }

  commit('prop', (a) => `{ ${a.items.map((i) => fieldEntryText(i, 'prop')).join(', ')} }`)
  commit('state', (a) => `{ ${a.items.map((i) => fieldEntryText(i, 'state')).join(', ')} }`)
  commit('computed', (a) => `{ ${a.items.map((i) => `${JSON.stringify(i.name)}()${i.bodyText}`).join(', ')} }`)
  commit('query', () => undefined)

  // prop/state 信号 + computed 信号体 → 构造体写入素材
  // （字段声明已整体删除；访问器统一读 `__s.<name>.value`，
  //  故**每个**已提交成员都必须建信号——无默认值者建 `signal(undefined)`，
  //  否则 `this.__s.x.value` 在无初始值的 @prop/@state 上直接抛 undefined.value）
  const fieldInits: Array<{ name: string; initText: string; computed?: boolean }> = []
  const runtimeHelpers: string[] = []
  if (committed.has('prop')) {
    for (const i of accs.prop.items) {
      fieldInits.push({ name: i.name, initText: i.initText ?? 'undefined' })
    }
    runtimeHelpers.push('signal')
    if (accs.prop.items.some((i) => i.model)) runtimeHelpers.push('writeModelProp')
  }
  if (committed.has('state')) {
    for (const i of accs.state.items) {
      // 播种字段（`@state m = this.p`）**不能**把 `this.p` 当初始值 emit：
      // 那是构造期求值，prop 真值那时还没落地（见 parseSeedProp 上方注释）。
      // 这里建 `signal(undefined)` 占位，实际值由 setup() 里的
      // #initStates 按 `prop`（运行期键） 从 `__data_[p]` 深拷贝回灌。
      fieldInits.push({ name: i.name, initText: i.seedProp !== undefined ? 'undefined' : i.initText ?? 'undefined' })
    }
    if (!runtimeHelpers.includes('signal')) runtimeHelpers.push('signal')
  }
  if (committed.has('computed')) {
    if (!runtimeHelpers.includes('signal')) runtimeHelpers.push('signal')
    if (!runtimeHelpers.includes('signalComputed')) runtimeHelpers.push('signalComputed')
    for (const i of accs.computed.items) {
      // bodyText 形如 `{ ... }`（getter 体，含花括号）
      if (i.bodyText === undefined) continue
      fieldInits.push({ name: i.name, initText: i.bodyText, computed: true })
    }
  }
  if (committed.has('query')) runtimeHelpers.push('_queryGet')

  // ---- 剔除同文件祖先已提供的、逐字节相同的访问器行 ----
  accessors = dedupeAncestorAccessors(comp, ctx, accessors, inheritedAccessors)

  // observedAttributes：**只给 @tag 类 emit**。
  //
  // 只有 `@tag` 类会被 `customElements.define`（tag.ts：immediate 直接 define，
  // 否则经 DefinitionComponentMap → defineComponents），也只有它的表会被浏览器读。
  // 无 `@tag` 的类（纯基类 / mixin 中间层 / 跨文件基类）永不被定义，带一份
  // observedAttributes 就是死代码。
  //
  // 条件只看 `comp.tagName`，**不看自有 prop**：一个自己一个 `@prop` 都没有的
  // @tag 类（属性全来自无 @tag 基类）同样必须 emit —— 它的表整张来自父表。
  //
  // 体是 `_observedAttrs(this)`（运行时从合并后的 props 表推导），因此**不依赖
  // 任何祖先的 getter**：这正是「基类可以不 emit」安全的前提。详见 observedGetter 注释。
  if (comp.tagName) {
    accessors += `${DEBUG_DIV} observedAttributes\n`
    accessors += observedGetter(h)
    if (!runtimeHelpers.includes('_observedAttrs')) runtimeHelpers.push('_observedAttrs')
  }
  return { removals, accessors, propsCode, statesCode, computedCode, fieldInits, runtimeHelpers, errors }
}
