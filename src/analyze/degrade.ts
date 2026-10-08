/**
 * 静态分析校验闸门（D-rules）—— **compelem 不允许降级**。
 *
 * ## 架构前提
 *
 * 基于signal 模型的 compelem **必须依赖编译器编译后执行**：
 * 值从哪来、何时更新、依赖怎么建，全部由编译期产物的 `pointEffects` / `fx` /
 * `subCells` 决定。运行时**没有**「解析 `render()` + 解释执行」的回退路径。
 *
 * 因此当静态分析无法保证正确性（D 系列命中）时，唯一正确的做法是
 * **编译期报错**，而不是产出一个降级产物 —— 后者在运行时的表现只有两种：
 * ① `__ce_static__.buildTemplate` 缺失 → 组件静默渲染成空白；
 * ② 依赖漏建 → DOM 不更新，且**没有任何报错**。
 * 两种都比构建失败难查一个数量级。
 *
 * 只有两种结果：**通过**，或**抛错**。
 *
 * | 规则 | 含义 | 处理 |
 * |---|---|---|
 * | D0 | 无 render() 或 render 体不是 BlockStatement | 报错 |
 * | D3 | 自由标识符（不在 import / 模块级声明 / 词法作用域内） | 报错 |
 * | D4 | render() 无顶层 return | 报错 |
 * | D5 | render() 有多个顶层 return | 报错 |
 * | D6 | 跨文件继承 render（基类不在本文件） | 报错 |
 * | D7 | 模板插值位置直接嵌套 h`` 模板（可修的写法违规） | 报错 |
 *
 * 动态成员访问（D1）与访问非响应式 getter（D2）：内联产物每轮求值 + 动态建链兜住，
 * 不需要拒绝。
 *
 * ## 错误如何被消费
 *
 * - **Vite 插件**（`vite.ts`）：`res.diagnostics` 里 `degraded === true`
 *   的条目**一律**走 `reportErrors(..., 'error')` 阻断构建，无力度选项。
 * - **API `compileFile`**：`decideDegrade` 命中**直接抛 `StaticAnalysisError`**，
 *   不返回产物。
 *
 */
import type { ComponentAnalysis } from '../types'
import type { RenderAnalysis } from './render-body'

/**
 * 汇总单个组件的静态分析结论。
 * 命中任何一条 ⇒ 抛错（调用方拿不到「凑合能跑」的产物）。
 */
export function decideDegrade(comp: ComponentAnalysis, ra: RenderAnalysis): { degraded: false; reason: null; errors: RenderAnalysis['errors'] } {
  const reasons: string[] = []
  if (comp.degradeReason) reasons.push(comp.degradeReason)
  reasons.push(...ra.degrades)
  // D7 命中的模板其 vars 编号非线性，编译期无法可靠生成扁平取值代码 → 同样不可编译
  for (const e of ra.errors) reasons.push(e.message)
  if (reasons.length) {
    throw new StaticAnalysisError(comp.className, [...new Set(reasons)], ra.errors)
  }
  return { degraded: false, reason: null, errors: [] }
}

/**
 * 静态分析未通过。`name` 让它在堆栈里一眼可辨。 */
export class StaticAnalysisError extends Error {
  readonly className: string
  readonly reasons: string[]
  readonly errors: RenderAnalysis['errors']

  constructor(className: string, reasons: string[], errors: RenderAnalysis['errors'] = []) {
    super(
      `[compelem] 组件 ${className} 未通过静态分析，compelem 不支持降级：` +
        reasons.map((r) => `\n  · ${r}`).join(''),
    )
    this.name = 'StaticAnalysisError'
    this.className = className
    this.reasons = reasons
    this.errors = errors
  }
}
