/**
 * 编译产物注入。
 *
 * 用 MagicString 做**最小侵入**的源码改写：在 class 体开头插入一个
 * `static __ce_static__ = { ... }`（+ 可选合成 constructor），在已有
 * constructor 的 super 语句后插入 prop/state 初始值写入，并扩展/新增
 * compelem 运行时函数 import；其余源码逐字节不动（保留原始 sourcemap 映射）。
 */
import MagicString from 'magic-string'
import type { ComponentAnalysis } from '../types'
import { DEBUG_DIV } from '../types'
import { IDENT_RE, unwrapExpr } from '../utils/ast'

export interface InjectOptions {
  /** 无视图组件标记：注入 noView: true（不创建 Shadow DOM）*/
  noView?: boolean
}

/** `buildStaticLiteral` 可选生成物（任一缺失则对应字段不注入）。 */
export interface StaticLiteralCodes {
  /** per-point effect 工厂数组（值/指令点的订阅与写 DOM） */
  pointEffects?: string
  /**
   * `fx`：与 ups 逐项 1:1 的工厂数组。值点返回 effect，指令点返回 DirectiveInstance，
   * 事件/ref 点返回 handler / ref 对象。renderTemplate 借它取首屏值，运行时按
   * up 上的 `ux` 下标索引（Q2 的前提：ups 与工厂 1:1 后才能互查）。
   */
  fx?: string
  /** watch effect 工厂数组 */
  watchEffects?: string
  /** `entries` 是否已内联**同文件**基类的 @watch —— 决定 watchEffects 是否还拼父类数组 */
  inlinedWatchAncestors?: boolean
  /** cssVars effect 工厂（读 CSS 依赖信号 → 更新自定义属性） */
  cssEffect?: string
  buildTemplate?: string
  /** 子视图表（结构指令的子模板元数据）：`subViews: { <subId>: { buildTemplate, fx } }` */
  subViews?: string
  /**
   /** `__ce_static__.props` 字面量值（@prop 前移，analyze/field-extract.ts） */
  props?: string
  /** `__ce_static__.states` 字面量值（@state 前移） */
  states?: string
  /** `__ce_static__.computedGetters` 字面量值（@computed 前移，原 getter 体外提） */
  computedGetters?: string
  /** 类体访问器源码（prop/state/computed 的 get/set + `@tag` 类的 observedAttributes），
   *  接在 static 字面量之后注入。无 `@tag` 的类不带 observedAttributes —— 它们永不被
   *  `customElements.define`，浏览器不会读它们的表。 */
  accessors?: string
}

/** prop/state 初始值写入语句的构造体插入点计划。 */
export interface CtorInsertPlan {
  /** 插入点（原始源码偏移） */
  pos: number
  /** true = 类无构造体 → 合成 `constructor(...__a){ super(...__a); ... }` */
  synthesize: boolean
  /**
   * 警告级诊断（W 通道）：super(…) 不在构造体顶层语句位时给出——
   * 插入点只能退到构造体末尾，prop/state 初始值写入晚于分支内用户语句，
   * 与原生字段初始化时机不严格等价。调用方转成 severity:'warn' 诊断。
   */
  warn?: string
}

/**
 * 构造体内**非顶层**位置（分支/try/循环/带标签语句）是否存在 super(…) 调用。
 * 不下钻嵌套函数/类：其中的 `super()` 要么非法（嵌套函数）、要么属于嵌套类自己的构造器。
 */
function hasNestedSuperCall(node: any): boolean {
  if (!node || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(hasNestedSuperCall)
  if (typeof node.type !== 'string') return false
  if (node.type === 'CallExpression' && node.callee?.type === 'Super') return true
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassDeclaration' ||
    node.type === 'ClassExpression'
  ) {
    return false
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'parent' || key === 'start' || key === 'end') continue
    if (hasNestedSuperCall(node[key])) return true
  }
  return false
}

/**
 * 计算 prop/state 初始值写入的构造体插入点。
 * 与原字段初始化时机等价：super() 返回后、构造体其余语句之前；
 * super 语句不在顶层（分支/try 内）时退到构造体末尾（闭合 `}` 前，保证执行且在
 * super 后），并给出 warn 级诊断说明时序取舍。
 */
export function planCtorInsert(
  comp: ComponentAnalysis,
  clsNode: any,
  code: string,
): CtorInsertPlan | undefined {
  // 与 injectInto 同理：定位类体左花括号必须优先用 AST 的 `cls.body.start`。
  // 从 class 起始处往后扫第一个 `{` 会扫进 `extends mixin({ a: 1 })` 的对象字面量，
  // 把构造体插进那个对象里 —— 模块直接语法错误（mixin 工厂内的组件必中）。
  const braceIdx =
    comp.bodyStart >= 0 && comp.bodyStart < comp.end
      ? comp.bodyStart
      : code.indexOf('{', comp.start)
  if (braceIdx < 0 || braceIdx > comp.end) return undefined
  const ctor = (clsNode?.body?.body ?? []).find(
    (m: any) => m.type === 'MethodDefinition' && m.kind === 'constructor',
  )
  if (!ctor) return { pos: braceIdx + 1, synthesize: true }
  const body = ctor.value?.body
  const stmts = body?.body ?? []
  // 顶层 super(…) 语句按 **AST** 判定：`super (…)` 带空格、`(super(…))` 带括号、
  // TS 包装形态都能命中（旧文本判据 `code.startsWith('super(')` 全部漏掉，
  // 初始值写入被静默推到构造体末尾、晚于用户语句）
  for (const st of stmts) {
    if (st.type !== 'ExpressionStatement') continue
    const e = unwrapExpr(st.expression)
    if (e?.type === 'CallExpression' && e.callee?.type === 'Super') {
      return { pos: st.end, synthesize: false }
    }
  }
  if (!body) return undefined
  if (hasNestedSuperCall(body)) {
    return {
      pos: body.end - 1,
      synthesize: false,
      warn:
        `W-CTOR-SUPER: 组件 '${comp.className}' 构造器的 super(…) 位于分支/嵌套结构内，` +
        `prop/state 初始值写入已退到构造体末尾（保证在 super 后执行，但晚于构造体内的用户语句，` +
        `与原生字段初始化时机不严格等价）；如需严格时序请把 super(…) 移回构造体顶层语句位`,
    }
  }
  return { pos: body.end - 1, synthesize: false }
}

/** 文件级运行时函数 import 注入参数。 */
export interface ImportInjectOptions {
  /** 需要导入的运行时函数名（已定名，含可能的 __ce_ 别名） */
  helpers?: string[]
  /**
   * helper 的本地名 → 原始导出名。仅当本地名与导出名不同（冲突别名）时需要；
   * 缺省按同名导入。例如 `{ __ce_signal: 'signal' }` →
   * `import { signal as __ce_signal } from 'compelem'`。
   */
  helperAliases?: Record<string, string>
  /** 定位到的 compelem import 声明：有命名 specifier 则原位扩展，否则新增独立行 */
  helperImport?: { decl: any; source: string }
  /** 新增独立 import 行时的锚点（首个 import 起点或首语句起点） */
  helpersAnchor?: number
  /** 需要从 **myfx** 注入的运行时函数名（方法装饰器前移的 debounce/throttle/once） */
  myfxHelpers?: string[]
  /** myfx helper 的本地名 → 原始导出名（同 helperAliases） */
  myfxAliases?: Record<string, string>
  /** 定位到的 myfx import 声明：有命名 specifier 则原位扩展，否则新增独立行 */
  myfxImport?: { decl: any; source: string }
  /**
   * 顶层语句（模块级常量，如子模板 carrier `const __ce_t0 = Object.assign(...)`），
   * 插在 `topLevelAnchor` 之后（通常取最后一个 import 声明的末尾偏移）。
   */
  topLevel?: string
  /** topLevel 的插入锚点（紧跟其后的偏移） */
  topLevelAnchor?: number
  /** inline 预变换的原始坐标编辑；在 class 注入前统一 overwrite。 */
  inlineEdits?: Array<{ start: number; end: number; text: string }>
}

/**
 * 家族字段（props/states/computedGetters）的父类合并表达式。
 *
 * 用 `Reflect.getPrototypeOf(this)` 而非 `super`：
 *   - 静态字段初始化器里 `this` 即类本身，`super` 只在有 extends 子句时合法
 *     （无 extends 的类上写 `super` 是 SyntaxError，整个模块加载失败）；
 *   - `super.__ce_static__` 需要 AST 知道 extends 子句的**源码文本**，而
 *     `extends FieldContainer(CompElem)` 这类 mixin 形态重放该表达式等于
 *     **二次调用 mixin 工厂**，拿到的是另一个类；
 *   - 构造器原型链是 mixin / 跨文件 / node_modules 预构建包的**唯一共同通道**，
 *     运行时查找天然穿透这三者，不需要模块图。
 */
const SUPER_STATIC = 'Reflect.getPrototypeOf(this).__ce_static__'

/** `superProps` 表达式：取父类（可能未编译 → undefined）的家族表。 */
const superFamily = (name: 'props' | 'states' | 'computedGetters') => `${SUPER_STATIC}?.${name}`

/**
 * 家族字段的 emit 形态 —— **浅替换**语义。
 *
 * - 有 own 条目：`{ ...super?.<name>, ...<own> }`。own 后置 → 同名 key 整体
 *   替换父类选项对象（不做逐字段深合并，见 DESIGN「prop 选项浅替换」）。
 * - 无 own 条目：直接别名父类表（不复制）。表对象本身从不被改写，
 *   只有条目上的 `_defaultValue`/`_typeAry` 派生缓存会被写，且其值是
 *   「本类信号默认值」的纯函数 → 同链同 key 必然一致，共享安全。
 *
 * 无论哪种都必须 emit：own `__ce_static__` 会**遮蔽**父类的整个静态字段，
 * 漏掉就会把祖先的 prop/state 定义一并遮没（这正是连续两层无自有 prop
 * 子类丢失整张定义表的根因）。
 */
export function emitFamily(name: 'props' | 'states' | 'computedGetters', ownCode?: string): string {
  const sup = superFamily(name)
  return ownCode === undefined ? sup : `{ ...${sup}, ...${ownCode} }`
}

/**
 * `watchEffects` 的 emit 形态 —— **数组拼接**语义（props/states 是浅替换，语义相反）。
 *
 * @watch effect 是**要执行的行为**而非可替换的表：子类 own 数组必须把祖先的执行
 * 序列接在**自己前面**，而不是覆盖掉它
 *
 * @param ownCode 本类 @watch 生成的数组字面量（`[...]`）；无则 undefined
 * @param inlinedAncestors `entries` 是否已内联**同文件**基类的 @watch。
 *   为 true 时原样返回 ownCode：同文件继承由 watch-extract 把祖先条目并入 entries，
 *   而父类 `__ce_static__.watchEffects` 与该前缀内容完全相同，拼接会让同一批
 *   处理器执行两次（immediate 处理器副作用翻倍）。
 */
export function emitWatchEffects(ownCode?: string, inlinedAncestors?: boolean): string | undefined {
  if (inlinedAncestors) return ownCode
  const sup = `(${SUPER_STATIC}?.watchEffects ?? [])`
  return ownCode === undefined ? `[...${sup}]` : `[...${sup}, ...${ownCode}]`
}

/** 生成 `static __ce_static__ = {...}` 的源码文本。 */
export function buildStaticLiteral(
  opts: InjectOptions,
  codes: StaticLiteralCodes = {},
): string {
  /** 字段块分隔注释（`//////// …… <标签>` 整行，纯注释、不改行为）。 */
  const mark = (label: string, body: string) => `${DEBUG_DIV} ${label}\n${body}`
  /** `{ … }` 展开逐字段一行（分隔注释须行首）。 */
  const wrap = (ps: string[]) => `static __ce_static__ = {\n${ps.join(',\n')}\n};\n`
  const parts: string[] = []

  if (codes.buildTemplate) {
    // buildTemplate：编译期生成的直接建 DOM 函数（docs/TEMPLATE-CODEGEN.md §2）
    parts.push(mark('buildTemplate', `buildTemplate: ${codes.buildTemplate}`))
  }

  if (codes.subViews) {
    // subViews：结构指令模板回调的子视图。与主 buildTemplate 同生共死。
    parts.push(mark('subViews', `subViews: ${codes.subViews}`))
  }

  // ---- 五族访问器前移（field-extract）：与视图无关，必须注入 ----
  // props/states/computedGetters 一律 emit（own 浅替换叠加父类表，见 emitFamily）：
  // own 静态字面量会遮蔽父类整张表，漏 emit 即丢祖先定义。
  parts.push(mark('props', `props: ${emitFamily('props', codes.props)}`))
  parts.push(mark('states', `states: ${emitFamily('states', codes.states)}`))
  parts.push(mark('computedGetters', `computedGetters: ${emitFamily('computedGetters', codes.computedGetters)}`))

  // watchEffects 与 props/states 的 emit 形态**不同**：那边是浅替换，这边是拼接
  // （effect 是要执行的行为，own 数组必须把祖先的执行序列接在自己前面）。
  // 同样「无论哪种都必须 emit」—— own `__ce_static__` 遮蔽父类整个静态对象，
  // 漏 emit 即丢祖先全部 @watch。inlinedWatchAncestors 为真时返回 undefined
  // （不注入 own 键），让父类数组原样透下来。
  const watchCode = emitWatchEffects(codes.watchEffects, codes.inlinedWatchAncestors)
  if (watchCode !== undefined) {
    // watch effect 工厂数组（祖先在前、自己在后）。
    // 每个工厂 (rc) => effectFn：读信号 → 变更时调用处理器。
    parts.push(mark('watchEffects', `watchEffects: ${watchCode}`))
  }

  if (codes.cssEffect) {
    // cssVars effect 工厂（读 CSS 依赖信号 → 更新自定义属性）。
    parts.push(mark('cssEffect', `cssEffect: ${codes.cssEffect}`))
  }

  if (codes.pointEffects) {
    // per-point effect 工厂数组：
    // 每个工厂 (rc, nodes) => effectFn，订阅一个信号，取值 → 守卫 → 写 DOM 在微任务里。
    parts.push(mark('pointEffects', `pointEffects: ${codes.pointEffects}`))
  }

  if (codes.fx) {
    // fx：与 ups 1:1。值点的项与 pointEffects 中对应项**是同一份源码**（同一工厂），
    // 指令点返回 DirectiveInstance、事件/ref 点返回 handler/ref 对象 —— 后两类
    // 不订阅信号，故不出现在 pointEffects 里，却仍需在 fx 占位以维持 1:1。
    parts.push(mark('fx', `fx: ${codes.fx}`))
  }

  // 静态分析结论**不注入产物**：未通过的组件由 `assertStaticAnalysis` / 模板 codegen
  // 直接抛 `StaticAnalysisError`，走不到这里。产物里只留运行时需要的东西。

  if (opts.noView) {
    // 无视图组件：只注入 noView，不注入任何视图加速字段
    // （访问器/家族元数据与视图无关，仍须随字面量注入）
    parts.push(mark('noView', `noView: true`))
    return wrap(parts) + (codes.accessors ?? '')
  }

  let literal = wrap(parts)
  // 访问器（get/set/observedAttributes）
  literal += codes.accessors ?? ''
  return literal
}

/**
 * 把生成物注入到源文件。
 *
 * 多个组件在同文件时按 **end 倒序** 插入，避免前一次插入改变后一次偏移。
 */
export function injectInto(
  code: string,
  edits: Array<{
    comp: ComponentAnalysis
    literal: string
    removals?: Array<{ start: number; end: number }>
    fieldInits?: Array<{ name: string; initText: string; computed?: boolean }>
    ctor?: CtorInsertPlan
    /** 方法装饰器（@debounced/@throttled/@onced）构造体注入语句 */
    methodDecoCtor?: string
    /** 方法装饰器 destroy 注入语句（插到 destroy() 内） */
    methodDecoDestroy?: string
  }>,
  id: string,
  extras: ImportInjectOptions = {},
): { code: string; map: any; injected: string[]; additions: string[] } {
  const s = new MagicString(code)
  const injected: string[] = []
  const additions: string[] = []
  const removalSpans = edits.flatMap((e) => e.removals ?? [])
  // inline 预变换与 class 注入共用同一个 MagicString（原始源码坐标），这样 map
  // 直接指回用户源码；落在 remove 区间里的 inline 编辑是死代码，跳过以免区间重叠。
  for (const e of extras.inlineEdits ?? []) {
    if (removalSpans.some((r) => e.start < r.end && r.start < e.end)) continue
    s.overwrite(e.start, e.end, e.text)
  }

  const sorted = [...edits].sort((a, b) => b.comp.start - a.comp.start)
  for (const { comp, literal, removals, fieldInits, ctor, methodDecoCtor, methodDecoDestroy } of sorted) {
    // 定位 class 体的左花括号。优先用 AST 给出的 `cls.body.start` —— 从 class 起始处
    // 往后扫第一个 `{` 会在 `extends mixin({ a: 1 })` 上扫进 extends 子句的对象字面量，
    // 把 static 字段插进对象里，产出整模块语法错误。AST 不可用时才回退扫描。
    const braceIdx =
      comp.bodyStart >= 0 && comp.bodyStart < comp.end
        ? comp.bodyStart
        : code.indexOf('{', comp.start)
    if (braceIdx < 0 || braceIdx > comp.end) continue
    s.appendLeft(braceIdx + 1, '\n' + literal)
    // 记入 additions：`literal` 是本次注入的 `static __ce_static__ = {...}` 全文。
    // 必须记录，否则「移除 additions + 应用 removals 还原源码」的校验无法把它删掉 ——
    // 那个校验（inject-e2e / field-e2e 的「removals 字节恒等」）会因残留字面量而失败。
    additions.push('\n' + literal)
    // prop/state 初始值与 computed 信号体写入构造体（字段声明已随 removals 整体删除；
    // 插入点在 super() 语句后 / 合成 constructor 内，时机与原字段初始化等价）
    // 方法装饰器注入（@debounced/@throttled/@onced）**接在 fieldInits 之后**同一插入点：
    // 编译器已算好直线语句（`this.onX = throttle(this.onX, 100)`），运行时零遍历。
    // 次序：super() → this.__s ??= {} → fieldInits → methodDecoCtor。
    // （方法体在构造期不会被调用，但"信号先建"更稳 —— 见 method-deco-extract 头注释）
    const hasFieldInits = fieldInits?.length && ctor
    if ((hasFieldInits || methodDecoCtor) && ctor) {
      const inits = hasFieldInits
        ? fieldInits!
          .map((i) =>
            i.computed
              ? `this.__s.${i.name} = signalComputed(function()${i.initText}.bind(this));`
              : `this.__s.${i.name} = signal(${i.initText});`,
          )
          .join(' ')
        : ''
      const md = methodDecoCtor ? (inits ? ' ' : '') + methodDecoCtor : ''
      const stmts = inits + md
      // `this.__s ??= {}` 而非 `this.__s = {}`：
      // 继承链上 super() 已把**父类**的信号建好（CompElem 构造函数里初始化），
      // 子类若直接 `= {}` 会把父类信号整体抹掉 —— 随后父类访问器读
      // `this.__s.<父键>.value` 即抛 "Cannot read properties of undefined"。
      // 实测：skipInjection 子类（无 own render，继承父类视图）必现。
      // 前导分号是**必需的**，不是保险：ctor.pos = 顶层 `super(...)` 语句的 st.end，
      // 该位置落在其终止分号**之前**，直接 appendLeft 会把 `super(...a)` 的分号顶掉，
      // 产出 `super(...a) this.__s ??= {}; …` —— 同一行两个表达式语句，ASI 不生效，
      // 整个组件产物语法错误（`';' expected.`），组件直接加载失败。
      // 若某些解析器的 st.end 已含分号，多出的 `;` 只是一个空语句，无副作用。
      const text = ctor.synthesize
        ? `\nconstructor(...__a) { super(...__a); this.__s ??= {}; ${stmts} }\n`
        : `; this.__s ??= {}; ${stmts}`
      s.appendLeft(ctor.pos, text)
      additions.push(text)
    }
    // 方法装饰器 destroy 清理：**不注入到基类 `destroy()`**（那是基类代码，用户源码里没有），
    // 而是生成一个 `beforeDestroyed()` 重写 —— 基类 `destroy()`:393 会调用它，且它本身
    // 是空钩子（CompElem.ts:376）。必须 `super.beforeDestroyed?.()` 保留用户/祖先实现。
    //
    // 用户已声明 `beforeDestroyed` 的情形在**分析层**（method-deco-extract）就已拦截：
    // 有 own `beforeDestroyed` → 整个方法装饰器前移放弃并报 E 码，故这里不必再判
    // （若在此"跳过清理但保留包装"会造成包装了却永不清理的泄漏，比不包装更难查）。
    if (methodDecoDestroy) {
      const text = `\n  beforeDestroyed() { ${methodDecoDestroy} super.beforeDestroyed?.() }\n`
      s.appendLeft(braceIdx + 1, text)
      additions.push(text)
    }
    // @watch 装饰器删除（span 均为原始源码偏移，MagicString 自动组合）。
    // 必须与注入同成功/同失败：装饰器被删而 watchers 未注入会丢 watch。
    for (const r of removals ?? []) s.remove(r.start, r.end)
    injected.push(comp.className)
  }

  // 运行时函数 import：优先扩展现有 compelem 命名导入（`}` 处 appendLeft）；
  // 仅 default/namespace/无 compelem import 时新增独立行（锚点=首 import 或首语句前）
  const injectHelperImport = (
    namesIn: string[] | undefined,
    aliases: Record<string, string> | undefined,
    importDecl: { decl: any; source: string } | undefined,
    anchor: number | undefined,
    fallbackSource: string,
  ) => {
    // local → imported。local 是生成代码里实际使用的名字；imported 是包的导出名。
    const specs = new Map<string, string>()
    for (const local of namesIn ?? []) {
      const imported = aliases?.[local] ?? local
      if (!IDENT_RE.test(local)) continue
      if (!IDENT_RE.test(imported)) continue
      specs.set(local, imported)
    }
    if (!specs.size) return

    const decl = importDecl?.decl
    // `import type { … }` 是纯类型声明，绝不能把运行时 helper 追加进去。
    const isTypeOnly = decl?.importKind === 'type'
    const hasNamed =
      !isTypeOnly &&
      !!decl &&
      (decl.specifiers ?? []).some((sp: any) => sp.type === 'ImportSpecifier')
    const existing = new Set<string>(
      (decl?.specifiers ?? []).map((sp: any) => sp.local?.name).filter(Boolean),
    )
    const pending = [...specs].filter(([local]) => !existing.has(local))
    if (!pending.length) return
    const specText = pending
      .map(([local, imported]) => (local === imported ? local : `${imported} as ${local}`))
      .join(', ')
    const braceIdx = decl ? code.lastIndexOf('}', decl.end) : -1
    if (decl && hasNamed && braceIdx > decl.start) {
      // 源码 `}` 前已是尾逗号（多行命名导入风格）→ 只补空格，否则 `, ,` 双逗号语法错误
      const needComma = !/,\s*$/.test(code.slice(decl.start, braceIdx))
      const text = (needComma ? ', ' : ' ') + specText
      s.appendLeft(braceIdx, text)
      additions.push(text)
    } else {
      const at = anchor ?? 0
      const text = `import { ${specText} } from ${JSON.stringify(importDecl?.source ?? fallbackSource)};\n`
      s.appendLeft(at, text)
      additions.push(text)
    }
  }
  injectHelperImport(extras.helpers, extras.helperAliases, extras.helperImport, extras.helpersAnchor, 'compelem')
  // 方法装饰器前移注入的 `debounce/throttle/once` 是 **myfx** 的实现，不是 compelem 的
  // 出口 —— 走独立的 myfx 通道：优先扩展源码已有的 `from "myfx"` 命名导入。
  injectHelperImport(extras.myfxHelpers, extras.myfxAliases, extras.myfxImport, extras.helpersAnchor, 'myfx')

  // 模块级常量（子模板 carrier 等）：插在最后一个 import 之后。
  // 与 class 体内注入同批记入 additions —— 「removals 还原源码」的字节恒等校验
  // 要能把它一并删掉。
  if (extras.topLevel) {
    const anchor = extras.topLevelAnchor ?? 0
    const text = `\n${extras.topLevel}\n`
    s.appendLeft(anchor, text)
    additions.push(text)
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: id, hires: true, includeContent: true }),
    injected,
    additions,
  }
}
