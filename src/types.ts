/**
 * @compelem/compiler — 类型定义
 *
 * 与 compelem 侧 `CompiledStatic`（src/types.ts）保持结构一致。
 * 双份定义的取舍：compiler 不应强依赖 compelem 的类型包（peer 可选），
 * 因此本地镜像一份，并在 `test/` 里做一致性断言防止漂移。
 */

/**
 * 每个类的 `props`/`states`/`computedGetters` 都是**沿构造器原型链浅替换合并后的
 * 完整表**（子类字面量叠加 `Reflect.getPrototypeOf(this).__ce_static__`）。
 */

/** debug 分块产物的整行注释前缀：`//////// …… <标签>`（纯注释、不改行为）。产物默认按块生成，无开关。 */
export const DEBUG_DIV = '////////////////////////////////////'

/**
 * 编译器注入到组件类上的静态成员。
 * 强制编译插件模式：`buildTemplate` 准入静态视图路径（缺失 = 无视图，无运行时回退）；
 * 其余字段可选。取值表达式一律内联进 fx/pointEffects 工厂，产物不携带取值函数或
 * 静态依赖元数据；依赖在 effect 运行期动态建立（DepSummary 仅在 compile.ts 内部
 * 计算，供 verbose 展示）。
 */
export interface CompiledStatic {
  version: number
  /**
   * `buildTemplate` 静态实现：纯 `document` API 建 DOM 函数
   * （以首个组件实例为 `this` 调用；与 compelem 侧 `CompiledStatic.buildTemplate` 同形）。
   */
  buildTemplate?: (this: any) => {
    fragment: any
    ups: any[]
    emptyEvents?: Record<number, string[]>
    /** 文档序元素+文本节点（与 nodeSn 对齐；运行时免 collectNodes 回扫） */
    nodes?: any[]
    updateSns?: number[]
    updatePaths?: number[][]
  }
  /** `@watch` 编译期解析产物（`analyze/watch-extract.ts` 序列化，装饰器被删时必须注入） */
  watchers?: CompiledWatcher[]
  /**
   * 结构指令模板回调的子视图 codegen：`__subId` → 独立 buildTemplate + fx/pointEffects。
   * 运行时结构指令经 `fn.__subId` 查表消费；缺失按构建期报错处理。
   */
  subViews?: Record<
    number,
    {
      buildTemplate?: (this: any) => {
        fragment: any
        ups: any[]
        emptyEvents?: Record<number, string[]>
        nodes?: any[]
        updateSns?: number[]
        updatePaths?: number[][]
      }
    }
  >
  /**
   * 无视图组件标记：render() 不存在 / 返回 null / 继承链终点为 CompElem（其
   * `render()` 返回 null）。注入后运行时不创建 Shadow DOM，仅支持 HOST/GLOBAL 样式。
   */
  noView?: boolean
  /*
   * `diag` 不在产物契约里：降级信息只经 `compileResult.diagnostics` 出口。
   * 未通过静态分析的组件直接抛 `StaticAnalysisError`，不存在带 `degraded: true`
   * 的产物。
   */
}

/** `@watch` 编译期解析条目（与 compelem `CompiledWatcher` 同形） */
export interface CompiledWatcher {
  name: string
  sources: string[]
  deep?: boolean
  immediate?: boolean
  once?: boolean
  static?: boolean
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
  /** 本类自身定义的实例方法名（用于 D2 降级判定） */
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
  /** 降级原因；null 表示未降级 */
  degradeReason: string | null
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
  /** 关闭指定生成步骤（用于 A/B 实测对照） */
  disable?: {
    buildVars?: boolean
  }
}
