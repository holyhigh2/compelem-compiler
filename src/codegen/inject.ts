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

export interface InjectOptions {
  /** 是否生成取值函数 */
  buildVars?: boolean
  /** 无视图组件标记：注入 noView: true（不创建 Shadow DOM） */
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
  /** cssVars effect 工厂（读 CSS 依赖信号 → 更新自定义属性） */
  cssEffect?: string
  /** 结构指令元数据占位字段，运行时从不读取（分派参数在 pointEffects 内） */
  dirMeta?: string
  buildTemplate?: string
  /** 子视图表（结构指令的子模板元数据）：`subViews: { <subId>: { buildTemplate, fx } }` */
  subViews?: string
  /**
   * 抽出的表达式中用到的 `super.METHOD` 名。注入到 class 体：
   * `__ce_s_METHOD(...a){return super.METHOD(...a)}`，
   * 保留 home-object 的 super 绑定，供静态取值函数经 `__comp` 调用。
   */
  superHelpers?: string[]
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
}

/**
 * 计算 prop/state 初始值写入的构造体插入点。
 * 与原字段初始化时机等价：super() 返回后、构造体其余语句之前；
 * 顶层无 super 语句（嵌套形态）时退到构造体末尾（闭合 `}` 前，保证执行且在 super 后）。
 */
export function planCtorInsert(
  comp: ComponentAnalysis,
  clsNode: any,
  code: string,
): CtorInsertPlan | undefined {
  const braceIdx = code.indexOf('{', comp.start)
  if (braceIdx < 0 || braceIdx > comp.end) return undefined
  const ctor = (clsNode?.body?.body ?? []).find(
    (m: any) => m.type === 'MethodDefinition' && m.kind === 'constructor',
  )
  if (!ctor) return { pos: braceIdx + 1, synthesize: true }
  const stmts = ctor.value?.body?.body ?? []
  for (const st of stmts) {
    if (st.type === 'ExpressionStatement' && code.startsWith('super(', st.start)) {
      return { pos: st.end, synthesize: false }
    }
  }
  const body = ctor.value?.body
  if (!body) return undefined
  return { pos: body.end - 1, synthesize: false }
}

/** 文件级运行时函数 import 注入参数。 */
export interface ImportInjectOptions {
  /** 需要导入的运行时函数名（已定名，含可能的 __ce_ 别名） */
  helpers?: string[]
  /** 定位到的 compelem import 声明：有命名 specifier 则原位扩展，否则新增独立行 */
  helperImport?: { decl: any; source: string }
  /** 新增独立 import 行时的锚点（首个 import 起点或首语句起点） */
  helpersAnchor?: number
  /** 需要从 **myfx** 注入的运行时函数名（方法装饰器前移的 debounce/throttle/once） */
  myfxHelpers?: string[]
  /** 定位到的 myfx import 声明：有命名 specifier 则原位扩展，否则新增独立行 */
  myfxImport?: { decl: any; source: string }
  /**
   * 顶层语句（模块级常量，如子模板 carrier `const __ce_t0 = Object.assign(...)`），
   * 插在 `topLevelAnchor` 之后（通常取最后一个 import 声明的末尾偏移）。
   */
  topLevel?: string
  /** topLevel 的插入锚点（紧跟其后的偏移） */
  topLevelAnchor?: number
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

  // ---- 五族访问器前移（field-extract）：与降级无关，必须注入 ----
  // props/states/computedGetters 一律 emit（own 浅替换叠加父类表，见 emitFamily）：
  // own 静态字面量会遮蔽父类整张表，漏 emit 即丢祖先定义。
  parts.push(mark('props', `props: ${emitFamily('props', codes.props)}`))
  parts.push(mark('states', `states: ${emitFamily('states', codes.states)}`))
  parts.push(mark('computedGetters', `computedGetters: ${emitFamily('computedGetters', codes.computedGetters)}`))

  if (codes.watchEffects) {
    // watch effect 工厂数组。
    // 每个工厂 (rc) => effectFn：读信号 → 变更时调用处理器。
    parts.push(mark('watchEffects', `watchEffects: ${codes.watchEffects}`))
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

  // `diag` 不注入产物：降级信息只经 `compileResult.diagnostics` 出口
  // （按类记录，每条带 `degraded` 与 `reason`）。**不要把降级信息写进产物**。

  if (opts.noView) {
    // 无视图组件：只注入 noView，不注入任何视图加速字段
    // （访问器/家族元数据与视图无关，仍须随字面量注入）
    parts.push(mark('noView', `noView: true`))
    return wrap(parts) + (codes.accessors ?? '')
  }

  let literal = wrap(parts)
  // super 转发方法：仅当某处抽出的表达式用到 super.METHOD 时注入。
  //
  // ⚠️ 判据只看 `codes.superHelpers` 是否非空：它已经是**全量汇流**
  // （compile.ts 把子模板的 superHelpers 与 fx 内联时的都 push 进同一数组）。
  if (codes.superHelpers?.length) {
    literal += `${DEBUG_DIV} super-forwarders\n`
    for (const name of codes.superHelpers) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
      literal += `__ce_s_${name}(...__a){return super.${name}(...__a)}\n`
    }
  }
  // 访问器（get/set/observedAttributes）：与 super 转发方法同批 appendLeft
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
    importDecl: { decl: any; source: string } | undefined,
    anchor: number | undefined,
    fallbackSource: string,
  ) => {
    const names = [...new Set((namesIn ?? []).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)))]
    if (!names.length) return
    const decl = importDecl?.decl
    const hasNamed = !!decl && (decl.specifiers ?? []).some((sp: any) => sp.type === 'ImportSpecifier')
    const braceIdx = decl ? code.lastIndexOf('}', decl.end) : -1
    if (decl && hasNamed && braceIdx > decl.start) {
      // 源码 `}` 前已是尾逗号（多行命名导入风格）→ 只补空格，否则 `, ,` 双逗号语法错误
      const needComma = !/,\s*$/.test(code.slice(decl.start, braceIdx))
      const text = (needComma ? ', ' : ' ') + names.join(', ')
      s.appendLeft(braceIdx, text)
      additions.push(text)
    } else {
      const at = anchor ?? 0
      const text = `import { ${names.join(', ')} } from ${JSON.stringify(importDecl?.source ?? fallbackSource)};\n`
      s.appendLeft(at, text)
      additions.push(text)
    }
  }
  injectHelperImport(extras.helpers, extras.helperImport, extras.helpersAnchor, 'compelem')
  // 方法装饰器前移注入的 `debounce/throttle/once` 是 **myfx** 的实现，不是 compelem 的
  // 出口 —— 走独立的 myfx 通道：优先扩展源码已有的 `from "myfx"` 命名导入。
  injectHelperImport(extras.myfxHelpers, extras.myfxImport, extras.helpersAnchor, 'myfx')

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
