/**
* per-point effect codegen：UpOut 描述符 → effect 工厂函数源码。
 *
 * 主模板：每个更新点一个工厂 `(rc, nodes) => effectFn`，读 `rc.__s[root].value`。
 * 子模板：整个子模板**合并成一个**工厂 `(rc, nodes, __ceGet, __ceDep) => effectFn`，
 *   内部逐点守卫写 DOM（见 generateSubRenderEffect）。
 *
 * 守卫一律写作 `值 !== 旧值 || rc.__f`：`rc.__f` 是 CompElem 的强制刷新标志，
 * 由 `forceUpdate()` 在重跑本组件全部 view effect 期间置位 —— 纯信号模型下
 * 值未变就没有别的强制重渲染通道，靠它让各点重新落盘。常态下它只是一个布尔
 * 字段读取，`||` 短路后无额外开销。
 *
 * **写入步一律 emit 成模块级自由函数调用（`wText(...)` 等），不内联函数体，也不走 `rc._wXxx(...)`。**
 * `_t2s` 的转换逻辑、`if (t !== n.textContent)` 这类幂等守卫、`setAttribute` 的
 * 字符串拼接，全部由运行时**模块级**写入器 `wText/wAttr/wAttrT/wProp/wToggleProp/wCssVars`
 * 承担（`wProp`/`wCssVars` 首参显式传宿主 `rc`；render.ts 的解释路径共用同一批实现）。
 * 而 `classes(...)`/`styles(...)`/`bind(...)` 这类 TAG 位指令没有专用写入器——它们 emit 成
 * `execDir(rc, ...)`，由指令自身在运行期写 DOM（见 RC_INTERNAL 上方说明）。
 * 产物里每个点因此只留「取哪个信号、写哪个节点、什么形态」三个信息，逻辑单点可改 ——
 * 内联时同一段逻辑要按点数复制，且静态路径与解释路径会各自漂移出不同语义。
 * 抽象的**边界**就在守卫处：每个点仍各自订阅各自那一个根信号、取值仍内联
 * `rc.__s.<k>.value`，per-point 粒度与内联取值都不受影响；写入调用只发生在
 * 值真的变了之后。
 */
import type { UpOut } from './template-dom'
import { PLACEHOLDER_FIRST_RE, PLACEHOLDER_ONLY_RE } from '../analyze/template-tree'
import { applySubIdWraps, stripTsChecked, type SubCandidate } from '../analyze/template-subs'
import { varsByUpIndex, type TemplateVarInfo } from '../analyze/template-extract'
import { rewriteThis } from './build-vars'
import { stringify } from '../utils/ast'


/**
 * 正则元字符转义：prelude 名字是合法标识符，可含 `$`（如 `price$`）——
 * 未转义直接内插进 `new RegExp` 会让 `$` 变成尾锚点 ⇒ 边界断言永不匹配 ⇒
 * prelude 不注入 ⇒ 运行期 ReferenceError 且零诊断。稳妥起见按通用元字符集转义。
 */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** prelude 名 → 词边界匹配正则（名字已转义，见 escapeRe）。 */
const preludeNameRe = (name: string): RegExp =>
  new RegExp(`(?<![\\w$])${escapeRe(name)}(?![\\w$])`)

/**
 * ⚠️⚠️ **工厂隐式形参名必须不可能与用户标识符撞名。**
 *
 * 工厂体里内联的是**用户源码**（只把 `this` 重写成 `rc`，其余原样保留），因此用户
 * 完全可以在模板插值里调用模块级函数。历史形态把第 3/4 个形参命名为 `get` / `dep`：
 *
 * ```ts
 * // 用户源码
 * import { get } from 'myfx'
 * h`<span title="${this.labelMap.get(f) + ' - ' + get(data, [f])}"></span>`
 *
 * // 旧 codegen 产物（形参 get 与模块级 get 同名 ⇒ 用户那次调用被解析成形参）
 * pe: [(rc, nodes, get, dep, ov, f) => () => { const a5 = rc.labelMap.get(f) + ' - ' + get(data, [f]); … }]
 * ```
 *
 * JS 词法作用域下那个 `get(data, [f])` 绑到**形参**，而运行期在子视图路径上第 3/4
 * 实参**恒为 `undefined`**（`render.ts` 的 `registerSubViewEffects`：
 * `(curPe[0])(component, nodes, undefined, undefined, ov, …)`）⇒ 首次求值即
 * `TypeError: get is not a function`。经 esbuild 做作用域改名后报错变成
 * `get4 is not a function`，且模块里的 `import { …, get, … }` 会被判定「未被引用」
 * 而删掉 —— 现象上完全看不出与「形参撞名」有关（2026-10-09 实测于 `Board.ts` /
 * `BoardBar.ts`，esbuild 产物里 0 处 `get4` 声明）。
 *
 * 这两个形参**从未被运行期赋过真值**：`render.ts` / `buildStaticView` 的注释原话是
 * 「每个点的取值表达式都内联在 fx 工厂里，工厂不需要额外的取值解析实参」，保留它们
 * 只为与运行期调用点保持**位置**稳定（第 1/2/5 位才是 rc / nodes / ov）。因此改名
 * 是纯粹的 codegen 内部行为，不触及任何运行期约定。
 *
 * 运行时 helper（`wText`/`execDir`/…）与 `rc` / `nodes` / `ov` 三个真正被生成的代码
 * 读写的名字不动：它们紧邻形参表前部，用户回调形参排在后面（`paramsCode` 追加），
 * 真要撞就是**重复形参名**（ES module 严格模式下直接 SyntaxError），早就在构建期暴露。
 */
const P_GET = '__ceGet'
const P_DEP = '__ceDep'

/**
 * ⚠️⚠️ **工厂体内生成的局部名同样必须不可撞名。**
 *
 * 与上面形参名同一类事故，但更隐蔽（2026-10-22 审查 C-1 实证）：
 *
 * ```ts
 * render() { const a = this.n; return h`<div>${show(a > 0)}</div>`; }
 * // 产物：const a = rc.n;            ← prelude 原样注入
 * //       const a = (show(a > 0));  ← 指令工厂的局部名
 * //       ⇒ SyntaxError: Identifier 'a' has already been declared（整模块加载失败）
 *
 * render() { const ov = this.n; return h`<div>${ov.length}</div>`; }
 * // 产物：let ov; … const ov = rc.n;  ← 用户 prelude 遮蔽了旧值槽
 * //       ⇒ 守卫比的是 `ov.length` 与 `ov`；末尾 `ov = nv` 给 const 赋值
 * //       ⇒ 每轮 effect 抛 TypeError，文本永不更新（异常被隔离，最难查）
 * ```
 *
 * 注意 `const ov` 这一类**不会被形参表暴露**：prelude 注入在 effect **体内**，
 * 而 `ov` 声明在工厂体外层，属于"内层遮蔽外层"——不报重复声明，只是静默用错。
 * 因此三处局部名（旧值 / 新值 / 点值）一律走 `__ce` 前缀。
 */
const L_OLD = '__ceOv'
const L_NEW = '__ceNv'
/** 点值局部名（子模板按点序号编号，避免同一函数体内重复声明）。 */
const lA = (i: number | string): string => `__ceA${i}`

export interface RenderEffectGen {
  /** `pointEffects:` 右侧完整数组表达式（只有「会随信号变化」的点） */
  arrayExpr: string
  /**
   * `fx:` 右侧完整数组表达式 —— 与 `ups` **逐项 1:1**。
   *
   * 每个工厂签名统一为 `(rc, nodes, __ceGet) => …`，按点的种类返回不同的东西：
   * - 值点（text / attr / prop / toggle）：返回 effect 函数
   * - 指令点：返回 `DirectiveInstance`（供 renderTemplate 首屏执行）
   * - 事件 / ref / refAttr 点：返回 handler / `createRef()` 对象 / 属性值
   *
   * 事件与 ref 点没有 effect（不订阅任何信号），但仍在 fx 占位，
   * 从而 pointEffects 与 ups 保持 1:1、可按下标互查（ups 用 `ux` 直接索引 fx）。
   */
  fxExpr: string
  /**
   * 产物里是否出现了 `get(varIndex)` 回退路径。
   *
   * 这是**编译期硬报错信号**：compile.ts 看到 `usedGet` 即写入 `tmplErrors`，
   * 随后抛 `StaticAnalysisError`。主模板每个更新点都必须把表达式内联进 fx /
   * pointEffects 工厂；出现回退说明该表达式含无法静态化的语法（render() 局部
   * 标识符 / TS 专有残留），应在构建期暴露。
   */
  usedGet: boolean
  /**
   * 本次 emit 用到的**模块级**写入器 / 分派入口名
   * （`wText` / `wAttr` / `wAttrT` / `wProp` / `wToggleProp` / `wCssVars` /
   * `execDir` / `execEach` / `execCond` …）。
   *
   * compile.ts 据此把名字并进 compelem 的 helper import —— 只注入实际用到的，
   * 产物里不会出现「import 了但没用」的写入器。
   */
  writers: WriterSet
}

/** 纯 `this.a` / `this.a.b` 链：可安全改写成 `rc.__s.a.value[.b]` */
const THIS_CHAIN_RE = /^this((?:\.[A-Za-z_$][\w$]*)+)$/

/**
 * varIndex → 读取表达式。
 *
 * 两级策略（见 signalExprFor / inlineExprFor）：
 * 1. 纯 `this.a` / `this.a.b` 链（`THIS_CHAIN_RE`）→ 内联 `rc.__s.a.value[.b]`。
 *    值与根信号**严格同一**，可直接建链，省掉一次访问器调用。
 * 2. 其余一切（算术 / 三元 / 比较 / 方法调用 / 混合模板属性…）→ 把原始表达式
 *    内联进 effect 体（`this`→`rc`）；无法内联时退回 `get(varIndex)`，
 *    由 `usedGet` 触发构建期报错。
 *
 * 决不能按 `varIndexToRoot` 内联**裸根信号**（`rc.__s.<root>.value`）：
 * `varIndexToRoot` 只说明「该 var **依赖**此根信号」，并不说明「该 var 的**值**
 * 就是此根信号」—— 于是 `${this.n > 0 ? 'pos' : 'neg'}` 会把数字写进文本节点
 * （正确值是 `'pos'`），`${this.a + this.b}` 还会把 `b` 整个从依赖里丢掉。
 */
/**
 * 内联所需的额外上下文。缺任何一项都退化为「只做 this 改写、不套 wraps」。
 */
export interface InlineCtx {
  /** 完整源文件文本（wraps 靠绝对偏移切片） */
  source?: string
  /** 子模板候选（`applySubIdWraps` 据此定位要包 `__subId` 的回调） */
  candidates?: readonly SubCandidate[]
  /** C1 闭包提升的附加属性片段（`, __bv: function(...){}`） */
  extras?: ReadonlyMap<number, string>
  /** subId → 模块级 carrier 常量名（自洽子模板，省每次更新的 Object.assign + 闭包） */
  carriers?: ReadonlyMap<number, string>
  /** varIndex → 源码绝对区间 [start, end) */
  ranges?: Map<number, [number, number]>
  /**
   * 主模板 prelude（render() 中 return h`` 之前的顶层语句）——已完成
   * stripTs / TS 复检 / rewriteThis('rc') 的注入版本。
   * 引用了 prelude 局部变量的工厂会把 prelude 注入 effect 体内（每轮重算，
   * 与 render() 每次执行重算局部变量的语义一致；读 `rc.route` getter 即订阅信号）。
   */
  prelude?: string
  /** prelude 顶层声明的局部变量名（含解构 pattern），`usesPrelude` 据此判断注入点 */
  preludeNames?: ReadonlySet<string>
  /**
   * `@state({ trigger: true })` 的成员名。
   *
   * 这些 state 不一定出现在任何插值表达式里，但变化时必须让每个视图点重算。
   * 生成器在每个 point effect 体开头注入 `void rc["<name>"]`（读取即注册依赖）；
   * 与作者手写 `void this.x` 语义相同，但不依赖 prelude 是否被引用 —— 后者在
   * 没有插值引用 prelude 局部变量时会整段丢弃，手写的注册会静默失效。
   */
  triggers?: readonly string[]
}

/**
 * 把一个 var 的原始表达式**内联**进 effect 工厂（`this` → `rc`）。
 *
 * 管线（顺序不能换）：`applySubIdWraps` → `stripTs` → TS 专有语法复检 → `rewriteThis`。
 *
 * 为什么指令点也能内联：`applySubIdWraps` 是纯文本拼接，只依赖
 * `source` / `candidates` / `extras`。若因反引号拒绝内联，指令点的 `__subId` 会丢失，
 * `resolveSubTemplateMeta` 返回 undefined 的 tmplM，运行时直接崩。
 *
 * 失败返回 null（引号上下文异常 / TS 语法残留），调用方退回 `get(varIndex)`
 * 并由 `usedGet` 触发构建期报错。
 */
export function inlineExprFor(
  varIndex: number,
  varIndexToExpr?: Map<number, string>,
  ctx?: InlineCtx,
): string | null {
  let src = varIndexToExpr?.get(varIndex)
  const range = ctx?.ranges?.get(varIndex)
  if (typeof range?.[0] === 'number' && ctx?.source) {
    src = applySubIdWraps(range[0], range[1], ctx.source, ctx.candidates ?? [], ctx.extras, ctx.carriers)
  }
  if (src == null) return null
  // C-G6⑤：本函数处理的是**主模板**插值（varIndexToExpr 来自主 ups），其旧式尖括号断言 /
  // 显式实例化已在 template-extract ①（AST 节点直达）拦下；wraps 只做纯文本拼接、不会
  // 新引入 TS 专有语法。故这里只需与 ① 同源的 as/satisfies/非空断言复检——复用
  // stripTsChecked 的全局 memo（与 build-vars 处理同一 wrapped 串，命中即省一次 strip+recheck）。
  const c = stripTsChecked(src)
  if (c.tsHit) return null
  return rewriteThis(c.stripped, 'rc')
}

export function signalExprFor(
  varIndex: number,
  varIndexToExpr?: Map<number, string>,
  signalKeys?: Set<string>,
): string {
  const expr = varIndexToExpr?.get(varIndex)
  if (expr && signalKeys) {
    const m = THIS_CHAIN_RE.exec(expr.trim())
    if (m) {
      // m[1] 以 '.' 开头（".a.b"），先去掉再切分，否则 root 会变成空串
      const segs = m[1].slice(1).split('.')
      // ⚠️ 根必须是**真信号键**。`__s` 只装 @prop/@state/@computed 的键
      // （field-extract 注入的 fieldInits）+ 框架自带的 `slots`；普通实例字段、
      // `@query` 查询属性都不在其中。对它们内联出 `rc.__s.x.value` 会在
      // effect 首次执行时抛 `Cannot read properties of undefined (reading 'value')`，
      // 且因 field-extract 视其为「保守收录」而无任何诊断。
      // 非信号根一律退回 `get(i)`，由访问器按真实语义取值。
      if (segs.length && segs[0] && signalKeys.has(segs[0])) {
        const root = segs[0]
        const rest = segs.slice(1)
        return `rc.__s.${root}.value${rest.map((s) => '.' + s).join('')}`
      }
    }
  }
  return `get(${varIndex})`
}

/** 单个更新点拆成「取值 / 守卫 / 写」三段，供主模板与子模板两种装配方式复用。 */
interface Point {
  /** 与旧值比较的表达式，形如 `nv !== ov` / `a3 !== ov[3]` */
  guard: string
  /** 写 DOM 的语句串（引用 `${val}` 与 `${node}`） */
  write: (val: string, node: string) => string
  /** 节点表达式；null 表示该点不需要节点（无） */
  node: string | null
  /** 旧值赋值语句 */
  store: (val: string, old: string) => string
}

/**
 * 产物写入器的 emit 名（compelem 运行时**模块级**函数）。
 *
 * **为什么 emit 成自由函数调用而不是 `rc._wXxx(...)`**：这些写入器不碰 ES 私有
 * 字段（需要的状态早已下沉到 `CompElemHelper` / `UpdatePointMeta` / 公开字段），
 * 做成实例方法只会在 `CompElem` 的公开类型面上多出一批「产物专用」的成员（作者的
 * 类型提示里挨着 `_execDir`），而产物本来就是在类体**之外**调用它们 —— 每次调用还
 * 多一次属性查找。emit 成 `wText(n, v)` 后作者的组件类型面上一个写入器都不剩，
 * 产物也更短。
 *
 * 需要实例参数的（`wProp`/`wCssVars`/`execDir`）由 emit 点显式传 `rc`。
 */
const RC_INTERNAL = {
  /** 通用指令分派：TAG 位指令 / slot() / 第三方自定义指令（模块级，首参 rc） */
  execDir: 'execDir',
  /** forEach 专用分派：多一条 UPDATE（keyed diff） */
  execEach: 'execEach',
  /** 条件类专用分派：ifTrue / ifElse / when，三者 tag 空间相同 */
  execCond: 'execCond',
  /** 写函数名（模块级） */
  wText: 'wText',
  wAttr: 'wAttr',
  wAttrT: 'wAttrT',
  /** prop / toggle 点：模块级，首参是宿主 rc（slot 分支要写宿主 slot 映射） */
  wProp: 'wProp',
  wToggleProp: 'wToggleProp',
  /** cssVars 宿主镜像：模块级，首参是宿主 rc */
  wCssVars: 'wCssVars',
} as const

/**
 * 按指令名选运行时分派入口。
 *
 * 结构指令的 tag 空间是互斥的：只有 forEach 需要 keyed diff（UPDATE），
 * ifTrue / ifElse / when 只会 REFRESH / REMOVE / REPLACE / NONE。给它们发各自
 * 瘦一层的入口，运行期就不必为一堆用不到的分支付代价。
 *
 * 判据是 `up.directiveName`（模板解析期就确定的真名），**不是** `directiveType`
 * —— 后者只是锚点位置（'text' | 'slot'），与指令种类无关。
 */
function dirEntryOf(up: UpOut): string {
  const kind = up.directiveName || ''
  if (kind === 'forEach') return RC_INTERNAL.execEach
  if (kind === 'ifTrue' || kind === 'ifElse' || kind === 'when') return RC_INTERNAL.execCond
  return RC_INTERNAL.execDir
}

/** 本次生成实际 emit 到的模块级写入器名（并集后由 compile.ts 走 compelem import 注入） */
export type WriterSet = Set<string>

/**
 * 生成主模板的 per-point effect 工厂数组。
 * @param ups 更新点描述符
 * @param varIndexToExpr varIndex → 该 var 的原始表达式（判纯 `this` 链，决定能否内联）
 */
export function generateRenderEffect(
  ups: UpOut[],
  varIndexToExpr?: Map<number, string>,
  signalKeys?: Set<string>,
  inlineCtx?: InlineCtx,
): RenderEffectGen {
  // 两类点分开装配：
  //
  // A. 能内联成 `rc.__s.<k>.value` 的点 —— 值与根信号严格同一，**每点一个工厂**。
  //    这是 per-point 粒度的核心：只订阅自己那一个信号，改 A 不唤醒 B。
  // B. 复杂表达式点（算术/三元/方法调用/模块级函数）—— **把表达式内联进 effect 体**
  //    （`this`→`rc`）。
  //
  // 内联后不再有 get 的缓存分桶问题，慢点与快点一样可以一点一个工厂；
  // 改写失败时仍退回 `get(varIndex)`，那种情况并入末尾的合并工厂。
  const fast: string[] = []
  /** fx：与 ups 1:1 的工厂数组（见 RenderEffectGen.fxExpr） */
  const fx: string[] = []
  /** 是否退回过 get(vi)（见 RenderEffectGen.usedGet） */
  let usedGet = false
  /** 本次 emit 到的模块级写入器名（供 compile.ts 注入 import） */
  const writers: WriterSet = new Set()
  const ictx: InlineCtx | undefined = inlineCtx
  // 主模板 prelude 注入支持：表达式引用了 prelude 局部变量的工厂，
  // 在 effect 体（每轮重算处）注入 prelude；表达式形态工厂（fx 的
  // prop/directive/event 返回值）则块体化后注入。未引用的工厂零开销。
  const fxPrelude = ictx?.prelude
  // 预编译一次：否则每个 point 的每次 usesPrelude 都要为每个 prelude 名 new RegExp。
  const preludeRes = fxPrelude && ictx?.preludeNames?.size
    ? [...ictx.preludeNames].map((n) => preludeNameRe(n))
    : undefined
  const usesPrelude = (src: string): boolean =>
    !!preludeRes && preludeRes.some((re) => re.test(src))
  /** 表达式形态工厂块体化：引用 prelude 变量时注入声明，否则原样返回。 */
  const exprFx = (inst: string): string =>
    usesPrelude(inst) ? `(rc) => { ${fxPrelude}\nreturn (${inst}) }` : `(rc) => (${inst})`
  /** effect 体工厂的内层取值前缀：引用 prelude 变量时注入声明。 */
  const bodyPrelude = (src: string): string => (usesPrelude(src) ? fxPrelude + '\n' : '')
  /**
   * trigger 依赖注册：每个 effect 体开头读一次。
   *
   * 用 `rc["name"]` 而不是 `rc.name`：state 名允许 `$` 前缀（合法标识符），方括号
   * 写法对任何字符串键都成立，且同样走访问器 getter（读信号 → 建立订阅）。
   */
  const depRead = ictx?.triggers?.length
    ? ictx.triggers.map((name) => `void rc[${JSON.stringify(name)}];`).join(' ') + ' '
    : ''
  let n = 0
  const nodeOf = (up: UpOut) => `nodes[${up.nodeSn}]`
  for (const up of ups) {
    // 占位点（event/ref/refAttr）不读任何信号 → **不注册 effect**，但仍要在 fx 里
    // 占位保持 1:1（事件 handler / ref 对象 / refAttr 值由 fx 交给 renderTemplate）。
    if (up.isEvent || up.isRef || up.isRefAttr) {
      const inst = inlineExprFor(up.varIndex, varIndexToExpr, ictx)
      if (inst) fx.push(exprFx(inst))
      else {
        fx.push(`(rc, nodes, ${P_GET}) => ${P_GET}(${up.varIndex})`)
        usedGet = true
      }
      continue
    }
    // 指令点（含 TAG 位 show/classes/styles/bind/model）：var 的值是 DirectiveInstance
    // 而非内层信号，必须交回运行时按指令语义执行 —— 内联写法会把内层信号当值用。
    // fx[i] 返回 DirectiveInstance 供 renderTemplate 首屏执行；updates 里另有一个
    // `execDir` effect 负责后续变更 —— 一个点两处，这是「只 emit 不写本地」之外的
    // 又一处「工厂要同时满足首屏与更新」的需求，故 pointEffects 仍是 fx 的真子集。
    if (up.isDirective) {
      const inst = inlineExprFor(up.varIndex, varIndexToExpr, ictx)
      const val = inst ?? `${P_GET}(${up.varIndex})`
      if (!inst) usedGet = true
      const entry = dirEntryOf(up)
      writers.add(entry)
      // 第 5 实参传完整 DirectiveInstance：同一元素可叠多个 TAG 指令（classes+styles+show），
      // __dirNodeMap 按 node 反查会互相覆盖，运行时据实例的 diFn 挑回正确的 UpdatePoint
      const f = `(rc, nodes, ${P_GET}) => { let ${L_OLD}; return () => { ${depRead}${bodyPrelude(val)}const ${lA('')} = (${val}); if (${lA('')}[1][0] !== ${L_OLD} || rc.__f) { ${entry}(rc, ${nodeOf(up)}, ${lA('')}[1][0], ${L_OLD}, ${lA('')}); ${L_OLD} = ${lA('')}[1][0] } } }`
      fast.push(f)
      // fx 返回 DirectiveInstance 供 renderTemplate 首屏执行（与 pointEffects 共用工厂源码）
      fx.push(exprFx(val))
      continue
    }
    const value = signalExprFor(up.varIndex, varIndexToExpr, signalKeys)
    // ⚠️ 只在 signalExprFor 退回 `get(vi)` 时才需要内联。若它已经给出
    // `rc.__s.<k>.value`，就必须用那个 —— 访问器 `rc.a` 只差一次调用，但
    // signalExprFor 里那道根信号校验（普通实例字段 / @query 不在 __s 里，
    // 内联出 __s 会抛 undefined.value）就不能生效了。
    // 顺带省掉一次源码切片与改写（内联不是廉价的）。
    const usesGet = value.startsWith('get(')
    const inlined = usesGet ? inlineExprFor(up.varIndex, varIndexToExpr, ictx) : null
    // 退回 get(vi) 时**必须**置位：用于触发构建期报错；漏置位会产出含未解析
    // get(vi) 的产物，运行期静默不更新。
    if (usesGet && inlined == null) usedGet = true
    const src = inlined ?? value
    const p = buildPoint(up, L_NEW, L_OLD, writers)
    if (p === undefined) {
      // buildPoint 拆不出静态形态 → 该点无 effect，但 fx 仍要占位保持 1:1
      fx.push(`() => undefined`)
      n++
      continue
    }
    const factory = `(rc, nodes, ${P_GET}) => { let ${L_OLD}; return () => { ${depRead}${bodyPrelude(src)}const ${L_NEW} = ${src}; if (${p.guard} || rc.__f) { ${p.write(L_NEW, p.node!)}; ${p.store(L_NEW, L_OLD)} } } }`
    // prop 点：fx 必须返回**值**而不是 effect 工厂。
    //
    // 原因在 renderTemplate：子组件首帧还是 wrapper（见
    // ComponentUninitializedWrapperComponentMap），此时 `_setProp` 写不进去 ——
    // 值只认 `addUninitializedSubComponentProp` 的 props 通道。所以 prop 初值必须
    // 在 renderTemplate 当场就有值；effect 那次求值只负责之后的变更。
    // 代价是首帧把表达式算两遍（fx 一次、effect 首 run 一次）：prop 点都是跨组件
    // 边界那一跳，本就不是热路径，而漏掉初值的症状是「子组件停在默认值」，很难查。
    if (up.isProp) {
      fast.push(factory)
      fx.push(usesPrelude(src)
        ? `(rc, nodes, ${P_GET}) => { ${fxPrelude}\nreturn (${src}) }`
        : `(rc, nodes, ${P_GET}) => (${src})`)
    } else {
      // 去重：值点工厂在 pointEffects 与 fx 各 emit 一份相同源码，minifier 无法
      // 去重数组字面量里的函数体。pointEffects 存 fx 下标（运行时按 typeof 解引用），
      // 工厂源码只 emit 一份，effect 注入块体积近半。
      const fxIdx = fx.length
      fx.push(factory)
      fast.push(String(fxIdx))
    }
    n++
  }
  return {
    arrayExpr: `[${fast.join(',')}]`,
    fxExpr: `[${fx.join(',')}]`,
    usedGet,
    writers,
  }
}

/**
 * 子模板内联器。产出一个「varIndex → 已内联取值表达式」+ prelude 的构造器。
 *
 * 管线与 `generateSubBuildVars` **逐字同构**（顺序都不能换）：
* `applySubIdWraps` → `stripTs` → TS 专有语法复检 → `rewriteThis('rc')`。
  * `this` 改写目标为 `rc`（另一条取值函数生成路径改写为 `__comp`，两者须同构）。
  *
 * 为什么 prelude **也必须**做 `rewriteThis('rc')`（2026-10-14 回归修复）：prelude 会被
 * `generateSubInlinedEffect` 原样注入 `__ce_static__` **静态上下文**里的 pointEffects/fx
 * 工厂 `(rc, nodes, …) => …`，该处 `this` 词法绑定到**类本身** —— 不改写则 `this.xxx`
 * 编译成 `ClassName.xxx`（恒 undefined），运行期当场抛（白屏，例：`d.rowId` on
 * undefined）；且 prelude 里的 `void this.sig` 依赖注册同样静默失效（子模板冻结在首帧，
 * 右栏面板停在第 0 行）。旧 buildVars 路径的 prelude 在 `function(__comp…)` 里经
 * `.call(component)` 求值所以 `this` 可用 —— 不能把那个假设照搬到内联路径。
 */
export function buildSubInliner(
  cand: SubCandidate,
  source: string,
  candidates: readonly SubCandidate[],
  extras: ReadonlyMap<number, string> | undefined,
  carriers: ReadonlyMap<number, string> | undefined,
): { val: (vi: number) => string | null; prelude: string | null } {
  // 键必须是 **ups 序**（= 非片段 var 的序号），不是 `v.index`：`${html(CONST)}`
  // 片段不占 varIndex，两序会错开，把 varIndex 解到片段 var 上（见 varsByUpIndex）。
  const byIndex = new Map<number, TemplateVarInfo>()
  const upsVars = varsByUpIndex(cand.vars)
  for (let vi = 0; vi < upsVars.length; vi++) byIndex.set(vi, upsVars[vi])
  const val = (vi: number): string | null => {
    const v = byIndex.get(vi)
    if (!v) return null
    let src: string | null =
      typeof v.start === 'number' && typeof v.end === 'number'
        ? applySubIdWraps(v.start, v.end, source, candidates, extras, carriers)
        : v.exprSource
    if (src == null) return null
    // C-G6：子插值的旧式尖括号断言 / 显式实例化已在 generateSubBuildVars ②（AST 直达）拦下；
    // 此处 wrapped 串与 ② 完全同一 ⇒ stripTsChecked memo 命中，只做同源的 as/satisfies/非空复检。
    const c = stripTsChecked(src)
    if (c.tsHit) return null
    return rewriteThis(c.stripped, 'rc')
  }
  let prelude: string | null = ''
  if (cand.preludeSrc) {
    const out0 = applySubIdWraps(cand.preludeStart, cand.preludeEnd, source, candidates, extras, carriers)
    const c = stripTsChecked(out0)
    if (c.tsHit) prelude = null
    // this → rc：注入点在 __ce_static__ 静态上下文（见函数头注释的回归说明）。
    // rewriteThis 仅在做引号配对复检失败时返回 null（合法 JS 不可能出现），
    // 与 TS 语法失败同一语义：prelude = null ⇒ 调用方构建期报错，不产出静默坏产物。
    else prelude = rewriteThis(c.stripped, 'rc')
  }
  return { val, prelude }
}

/** 结构指令点语句（内联取值版）。与 get 版 dirStmt 语义一致，只是 value 由调用方给出。 */
function dirStmtVal(up: UpOut, a: string, value: string, old: string, writers: WriterSet): string {
  const entry = dirEntryOf(up)
  const node = `nodes[${up.nodeSn}]`
  writers.add(entry)
  return (
    `const ${a} = ${value}; ` +
    `if (${a}[1][0] !== ${old} || rc.__f) { ${entry}(rc, ${node}, ${a}[1][0], ${old}, ${a}); ${old} = ${a}[1][0] }`
  )
}

/**
 * **自洽子模板**的 effect/fx 生成（把取值表达式内联进工厂，不产 `get(vi)`）。
 *
 * - 自洽子模板（表达式只引用自身形参 + `this` + 模块名）→ 本函数，内联。
 * - 跨层子模板（表达式引用祖先回调形参，如 `row[c]`）→ 顶层工厂无法解析，走 `__fx`
 *   闭包路径（在祖先作用域物化，见 compile.ts）。
 *
 * 工厂签名 `(rc, nodes, __ceGet, __ceDep<params>)`：前四个是运行时统一形参，`<params>` 为回调
 * 原始形参（运行时按 (v,k,i) 位置传参）。
 * 自洽子模板下 `__ceGet`/`__ceDep` 不被读，保留只为与运行时调用点保持位置稳定 ——
 * **命名必须防撞**（详见文件顶部 `P_GET`/`P_DEP` 的长注释）。
 *
 * fx 与 ups **逐项 1:1**：指令点返回 DirectiveInstance，prop 点返回值，事件/ref 点位；
 * 值点只在 fx 占位（`undefined`），其值由合并 effect 的首次 run 写入（deferValueFill）。
 */
export function generateSubInlinedEffect(
  ups: UpOut[],
  inlineVal: (vi: number) => string | null,
  prelude: string,
  paramsCode: string,
  preludeNames?: Set<string>,
  triggers?: readonly string[],
): RenderEffectGen {
  const stmts: string[] = []
  const fx: string[] = []
  let usedGet = false
  const writers: WriterSet = new Set()
  let n = 0
  const fxSig = `(rc, nodes, ${P_GET}, ${P_DEP}${paramsCode})`
  // 合并 effect 工厂额外多一个**外部传入**的旧值槽数组 ov：工厂在 effect 体**每轮**被
  // 调用（item 实参读 cell.value → 订阅 + 当前值），ov 必须跨轮持久，由运行时提供。
  // ⚠️ 形参名必须不可撞名（见 `L_OLD` 注释）：子模板回调形参由 `paramsCode` 追加在
  // 后面，叫 `ov` 的用户形参会让整个合并工厂直接 SyntaxError（重复形参）。
  const peSig = `(rc, nodes, ${P_GET}, ${P_DEP}, ${L_OLD}${paramsCode})`
  /**
   * 表达式是否引用 `prelude` 里声明的局部变量。
   *
   * 子模板回调体可以带**前置语句**（`forEach(list, k, (item) => { const x = f(item); return h`…` })`），
   * 编译期把它们原样保留为 prelude。`pointEffects` 的工厂体每轮开头注入 prelude，所以
   * `const a0 = svgName;` 这类 `stmts` 没问题；但 **`fx` 工厂是另一份独立函数**，
   * 历史实现**没有**注入 prelude ⇒ 表达式里的 `svgName` 在 fx 作用域里根本不存在。
   *
   * 症状（2026-10-09 实测于 compelem-ui-website 的 `IconPage.ts`）：
   * ```ts
   * ${forEach(this.filteredIcons, n => n, (name) => {
   *   const svgName = toSvgName(name)      // ← prelude
   *   return h`<button title="${svgName}" …>`
   * })}
   * ```
   * 产物：`pe` 有 `const svgName = toSvgName(name);`，`fx` 却是
   * `(rc, nodes, __ceGet, __ceDep, name) => (svgName)` ⇒ `renderTemplate` 的
   * `callFx` 当场求值即 `ReferenceError: svgName is not defined`，**整页不渲染**
   * （加载期异常，`setup()` 直接抛出）。
   */
  const preludeRes = prelude && preludeNames?.size
    ? [...preludeNames].map((nm) => preludeNameRe(nm))
    : undefined
  const usesPrelude = (src: string): boolean =>
    !!preludeRes && preludeRes.some((re) => re.test(src))
  /**
   * `fx` 工厂体化：表达式引用 prelude 变量时把 prelude 注入工厂体再 `return`。
   *
   * ⚠️ 必须写成**块体**（`{ prelude; return (expr) }`）而不是默认参数或逗号表达式 ——
   * prelude 是多语句声明序列（`const` 必须处于块作用域），且事件点形态
   * `() => navigator.clipboard?.writeText(svgName)` 需要靠这层块作用域让内层箭头
   * **闭包捕获** `svgName`（否则点击时同样 ReferenceError）。
   * 未引用 prelude 的工厂保持原样（单表达式箭头），不引入多余块作用域。
   */
  const fxOf = (sig: string, body: string): string =>
    usesPrelude(body) ? `${sig} => { ${prelude}\nreturn (${body}) }` : `${sig} => (${body})`
  for (const up of ups) {
    if (up.isEvent || up.isRef || up.isRefAttr) {
      const inst = inlineVal(up.varIndex)
      if (inst == null) {
        usedGet = true
        fx.push('() => undefined')
      } else fx.push(fxOf(fxSig, inst))
      continue
    }
    const inlined = inlineVal(up.varIndex)
    if (inlined == null) usedGet = true
    const value = inlined ?? `${P_GET}(${up.varIndex})`
    if (up.isDirective) {
      fx.push(inlined == null ? '() => undefined' : fxOf(fxSig, value))
      if (inlined != null) stmts.push(dirStmtVal(up, lA(n), value, `${L_OLD}[${n}]`, writers))
      n++
      continue
    }
    if (up.isProp) fx.push(inlined == null ? '() => undefined' : fxOf(fxSig, value))
    // 值点：fx 占位；值由合并 effect 首次 run 写入
    else fx.push('() => undefined')
    if (inlined == null) {
      n++
      continue
    }
    const p = buildPoint(up, lA(n), `${L_OLD}[${n}]`, writers)
    if (p === undefined) {
      n++
      continue
    }
    stmts.push(
      `const ${lA(n)} = ${value}; if (${p.guard} || rc.__f) { ${p.write(lA(n), p.node!)}; ${p.store(
        lA(n),
        `${L_OLD}[${n}]`,
      )} }`,
    )
    n++
  }
  const pe = stmts.length
    ? `[${peSig} => () => { ${triggers?.length ? triggers.map((name) => `void rc[${JSON.stringify(name)}];`).join(' ') + ' ' : ''}${prelude ? prelude + '\n' : ''}${stmts.join(' ')} }]`
    : '[]'
  return { arrayExpr: pe, fxExpr: `[${fx.join(',')}]`, usedGet, writers }
}

/**
 * 把一个 UpOut 拆成「守卫 + 写」；形态无法静态化时返回 undefined（该点不生成 effect）。
 * @param value 取值表达式
 * @param old 旧值记号：主模板为闭包标量 `ov`，子模板为该点槽位 `ov[n]`
 */
function buildPoint(up: UpOut, value: string, old: string, writers: WriterSet): Point | undefined {
  const node = `nodes[${up.nodeSn}]`
  const store = (v: string, o: string) => `${o} = ${v}`

  // 模块级写入器（纯 DOM 写，emit 成自由函数调用；见 RC_INTERNAL 上方说明）
  const w = (name: string, write: (v: string, nd: string) => string) => {
    writers.add(name)
    return write
  }

  // 本函数**只处理非指令点**。指令点在两个调用方（generateRenderEffect /
  // generateSubInlinedEffect）里都已先行 `continue`：结构指令走 dirEntryOf 选定的
  // exec*/TAG 位指令走各自的内联 emit，两处都带完整 DirectiveInstance。
  //
  // 这里早前还留着一份指令分支（forEach/if*/show/bind/classes/styles…），已经不可达，
  // 且 emit 的是**过期的 4 参形态** `execDir(rc, nd, v, old)` —— 新签名下 inst 为
  // undefined，运行期首行 `if (!inst) return` 会让该点静默不响应且零报错。
  // 保留它等于埋雷：谁把某个调用方的 continue 去掉，指令就会「安静地坏掉」。
  if (up.isDirective) return undefined

  if (up.isText) {
    return {
      guard: `${value} !== ${old}`,
      node,
      write: w(RC_INTERNAL.wText, (v, nd) => `${RC_INTERNAL.wText}(${nd}, ${v})`),
      store,
    }
  }
  if (up.isToggleProp) {
    const attr = stringify(up.attrName!)
    return {
      guard: `(!!${value}) !== ${old}`,
      node,
      write: w(RC_INTERNAL.wToggleProp, (v, nd) => `${RC_INTERNAL.wToggleProp}(${nd}, ${attr}, !!${v})`),
      store,
    }
  }
  if (up.isProp) {
    const attr = stringify(up.attrName!)
    return {
      guard: `${value} !== ${old}`,
      node,
      write: w(RC_INTERNAL.wProp, (v, nd) => `${RC_INTERNAL.wProp}(rc, ${nd}, ${attr}, ${v})`),
      store,
    }
  }
  if (up.attrName != null) {
    // attr（含纯插值与混合模板）
    const name = stringify(up.attrName)
    const tmpl = up.attrTmpl
    const isPure = !!up.isPureTmpl || !tmpl || PLACEHOLDER_ONLY_RE.test(tmpl)
    if (isPure) {
      return { guard: `${value} !== ${old}`, node, write: w(RC_INTERNAL.wAttr, (v, nd) => `${RC_INTERNAL.wAttr}(${nd}, ${name}, ${v})`), store }
    }
    // 混合模板：切分 pre/post
    const m = tmpl!.match(PLACEHOLDER_FIRST_RE)
    if (m) {
      const idx = tmpl!.indexOf(m[0])
      const pre = stringify(tmpl!.slice(0, idx))
      const post = stringify(tmpl!.slice(idx + m[0].length))
      return {
          guard: `${value} !== ${old}`,
        node,
        write: w(RC_INTERNAL.wAttrT, (v, nd) => `${RC_INTERNAL.wAttrT}(${nd}, ${name}, ${pre}, ${post}, ${v})`),
        store,
      }
    }
    return undefined
  }
  return undefined
}
