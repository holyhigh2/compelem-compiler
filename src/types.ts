/**
 * @compelem/compiler — 类型定义
 */

/**
 * debug 分块产物的整行注释前缀：`//////// …… <标签>`（纯注释、不改行为）。产物默认按块生成，无开关。
 */
export const DEBUG_DIV = '////////////////////////////////////'

/** 一次建树的返回结构：主 buildTemplate 与 subViews 元素同形。 */
export interface BuiltTemplateResult {
  fragment: any
  ups: any[]
  emptyEvents?: Record<number, string[]>
  /** 文档序元素+文本节点（与 nodeSn 对齐；运行时免 collectNodes 回扫） */
  nodes?: any[]
  updateSns?: number[]
  /** 从 fragment 根取节点的 childNodes 下标链（运行时 O(1) 定位，免 collectNodes） */
  updatePaths?: number[][]
}

/** 一个结构指令回调的子视图产物（`subViews[subId]`）。 */
export interface CompiledSubView {
  buildTemplate?: (this: any) => BuiltTemplateResult
  pointEffects?: any[]
  fx?: any[]
}

/**
 * 编译器注入到组件类上的静态成员
 */
export interface CompiledStatic {
  /**
   * 静态视图产物。与 `noView` 构成**互斥二选一**，两者皆无会被运行时判为
   * 「未编译」并抛错（`CompElem.ts` setup 的第三分支）。
   *
   * ⚠️ 所以**缺席不代表无视图**：缺席是错误态，专留给「插件没跑 / 该有视图却没编出来」。
   * 无视图组件必须由编译器显式写 `noView: true`。
   */
  buildTemplate?: (this: any) => BuiltTemplateResult
  /**
   * 结构指令模板回调的子视图 codegen：`__subId` → 独立 buildTemplate + fx/pointEffects。
   * 运行时结构指令经 provenance / `fn.__subId` 查表消费；缺失按构建期报错处理。
   */
  subViews?: Record<number, CompiledSubView>
  /** prop 定义表（沿构造器原型链浅替换合并后的**完整**表） */
  props?: Record<string, any>
  /** state 定义表（同上，合并语义） */
  states?: Record<string, any>
  /** `@computed` getter 函数外提（装饰器与成员被剥离）；仅 devtools 元数据消费 */
  computedGetters?: Record<string, () => any>
  /** `@watch` 产物：每个 watch 一个 effect 工厂，setup 期逐条 `effect(factory(this))` */
  watchEffects?: Array<(comp: any) => () => void>
  /** `cssVars` 的响应式 effect 工厂：工厂体内直接读 `rc.__s.<k>.value` 建依赖 */
  cssEffect?: (comp: any) => () => void
  /**
   * 值点（属性/文本/指令）per-point effect 工厂表。
   * 数值条目 = `fx` 下标（同一工厂源码在产物里只 emit 一份），其余为工厂本体。
   */
  pointEffects?: Array<number | ((rc: any, nodes: any[], ...params: any[]) => () => void)>
  /** 逐实例产物工厂表（指令实例 / 事件 handler / ref 等）；下标 = `up.ux` */
  fx?: any[]
  /**
   * 无视图组件标记：render() 不存在 / 返回 null / 继承链终点为 CompElem（其
   * `render()` 返回 null）。注入后运行时不创建 Shadow DOM，仅支持 HOST/GLOBAL 样式。
   *
   * ⚠️ 与 `buildTemplate` 互斥，且**必须有** —— 缺席不等于无视图（见上）。
   * 唯一豁免：继承链经 spread 从父类继承而来（`skipInjection`），以及
   * `CompElem` 自身声明的本字段（运行时基类兜底，非编译器产物）。
   */
  noView?: boolean
}

/**
 * `@watch` 的**分析期**条目（`analyze/watch-extract.ts` 产出）。
 *
 * 注意：它**不是**产物的一部分 —— 编译进产物的是 `watchEffects` 工厂数组，
 * 编译完成后本条目即丢弃。保留本类型是因为 generateBuildVars 要读 `extras`。
 */
export interface WatchEntry {
  name: string
  sources: string[]
  deep?: boolean
  immediate?: boolean
  once?: boolean
  /** 宿主成员是否为 static（决定 effect 里取 `rc.constructor` 还是 `rc`） */
  isStatic?: boolean
}

/** 响应式字段类别，用于判定「该成员是否会被推入依赖收集列表」。 */
export type ReactiveKind = 'prop' | 'state' | 'computed'

/** 组件内一个响应式成员的信息。 */
export interface ReactiveField {
  name: string
  kind: ReactiveKind
  /** 静态初始化器里的默认值表达式源码（用于静态取值内联），无则 undefined */
  init?: string
  /** 是否为深层对象（init 是对象/数组字面量），影响依赖路径展开 */
  shallow: boolean
}

/** 一个组件的完整静态分析结果。 */
export interface ComponentAnalysis {
  className: string
  /**
   * 该组件的 class AST 节点本体。
   *
   * 直接随分析结果下发节点本身：按名反查 `localClasses` 只覆盖**模块顶层**的
   * `ClassDeclaration`，mixin 工厂内的类在函数作用域里按名查不到，会让
   * `field-extract` / `watch-extract` / `conventions` 拿到 `undefined` 而静默
   * 什么都不做。
   */
  cls?: any
  /** 源文件中该 class 声明的起始/结束偏移（用于 MagicString 注入） */
  start: number
  end: number
  /**
   * 类体左花括号 `{` 的源码偏移（`cls.body.start`）。
   *
   * 注入锚点必须是它，不能用 `code.indexOf('{', start)` —— `extends mixin({ a: 1 })`
   * 里第一个 `{` 落在 extends 子句中，扫到那里会把 `static __ce_static__` 插进
   * 对象字面量里，产出整模块语法错误。-1 表示无 AST 可用（调用方应回退扫描）。
   */
  bodyStart: number
  /** `@tag` 名称，无则 undefined */
  tagName?: string
  /** 响应式字段（含继承链上收集到的，按声明顺序） */
  fields: Map<string, ReactiveField>
  /** 本类自身定义的实例方法名（D2：自有方法值不可变，不推入依赖，无需拒绝） */
  ownMethods: Set<string>
  /** 本类自身定义的 getter 名（`@computed` 之外的普通 getter，D2 视为方法） */
  ownGetters: Set<string>
  /** 是否有 render() */
  hasRender: boolean
  /** render() 函数体 AST（Program 级 node），无则 null */
  renderBody: any | null
  /** render() 函数体在源码中的偏移区间（不含大括号） */
  renderBodyStart: number
  renderBodyEnd: number
  /** `get cssVars()` 函数体语句数组（无则 null），供 cssDeps 静态提取 */
  cssVarsBody: any[] | null
  /** `@computed` getter 名 → 函数体语句数组，供 computedDeps 静态提取 */
  computedBodies: Map<string, any[]>
  /** `@query` / `@queryAll` 字段名（非响应式 DOM 查询属性，依赖提取按死条目记录） */
  queryFields?: Set<string>
  /** 本类方法 / getter / 箭头字段的函数体（name → BlockStatement 节点或表达式体），供依赖提取内联扫描 */
  bodies?: Map<string, any>
  /** 静态分析未通过的原因（D0/D4/D5/D6）；null 表示通过。非 null 即闸门抛错 */
  staticReason: string | null
  /** 无视图组件（render() 不存在 / 返回 null / 继承链终点为 CompElem）→ 注入 noView: true */
  noView: boolean
  /** 跳过注入（同文件继承链上有 render 的祖先，继承其 __ce_static__）→ 不生成注入语句 */
  skipInjection: boolean
  /**
   * **mixin 工厂内的 class 声明**（`export function mix(B) { class M extends B {} ; return M }`）。
   *
   * super 是调用方传入的形参 ⇒ 静态不可知链：不做 D6 报错、无 own render 时一律
   * `skipInjection`（绝不判 `noView`，否则基类有视图时会静默白屏）。
   * 家族表（props/states/computedGetters）的合并走 `Reflect.getPrototypeOf(this)`，
   * 与本标记无关，mixin 声明的 @prop 会沿链传递到具体组件。
   *
   * 写法约束：必须是 class **声明**，不能是 class **表达式** —— TS 禁止在 class
   * 表达式上写装饰器（TS1206），能带 `@prop` 的形态只有 class 声明。
   */
  isMixin?: boolean
  /** 静态导入绑定：本地名 → 从 compelem 导入的原始名 */
  compelemImports: Map<string, string>
  /**
   * 模块级绑定名（顶层 const/let/var/function/class，以及全部 import 的本地名）。
   * 用于 D3 判定：这些名字不是「自由标识符」。
   */
  moduleBindings: Set<string>
  /**
   * 模块级 `const` 的初始化器：名字 → VariableDeclarator（见 collectModuleConstInits）。
   * 供模板静态片段折叠判定 `${CONST}` 是不是模块级 `h` 标签模板常量。
   * 只收同文件声明 —— compileFile 是单文件纯函数，跨文件 import 不解析。
   */
  moduleConstInits: Map<string, any>
  /**
   * 外部指令名（options.knownDirectives，compile.ts 注入）。插值位置对这些
   * 导入名的调用按指令点分类（isDirectiveCall），同 COMpelem_DIRECTIVES。
   */
  knownDirectives?: Set<string>
}

/** 插件选项。 */
export interface CompilerOptions {
  /**
   * 参与编译的文件过滤。默认只处理 `.ts` 且源码里出现 `extends CompElem` 的文件。
   * ⚠️ 不要放宽到 `.js`：IIFE 打包产物里指令名不在 scope，会触发 D3 误报。
   */
  include?: (id: string, code: string) => boolean
  /**
   * verbose 日志：依赖清单人类可读打印（vite 插件侧同时打印每文件编译状态行）。
   * 也可用环境变量 `CE_DEPS_DEBUG`（非空且非 '0'）单独开启清单打印，无需改配置。
   * 注：产物的块分隔注释（`//////// …… <标签>`）默认始终生成，与本选项无关。
   */
  verbose?: boolean
  /**
   * 跨文件标签注册表：已知组件的 kebab 标签名（大小写不敏感）。
   * 用于 SLOT 判定与 `.prop` 目标校验；vite 插件可跨文件累积后注入
   * （TEMPLATE-CODEGEN.md §4）。
   */
  knownTags?: Iterable<string>
  /**
   * 外部指令注册表：经 `directive()` 包装、遵守 DirectiveInstance 契约的
   * 跨包导入函数名（如 compelem-router 的 `outlet`）。插值位置对这些名字的
   * 调用按指令点编译（vite 插件选项原样透传，无需跨文件累积）。
   * 不提供则模块绑定调用退回值点语义 —— 与 0.28 动态引擎「函数值即指令」
   * 的隐式契约断裂，外部指令将渲染成函数源码文本。
   */
  knownDirectives?: Iterable<string>
}
