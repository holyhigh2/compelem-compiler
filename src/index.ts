/**
 * @compelem/compiler — 编译器
 */
export { analyzeFile, collectCompelemImports, isCompelemSource } from './analyze/component'
export { assertStaticAnalysis, StaticAnalysisError } from './analyze/static-gate'
export { analyzeRender } from './analyze/render-body'
export type { RenderAnalysis } from './analyze/render-body'
export { buildStaticLiteral, injectInto } from './codegen/inject'
export { compileFile, defaultInclude } from './compile'
export type { CompileResult, DepSummary } from './compile'
export { DEBUG_DIV } from './types'
export type {
  CompiledStatic,
  CompilerOptions,
  ComponentAnalysis,
  ReactiveField,
  ReactiveKind
} from './types'
export { compelemCompiler } from './vite'
export type { VitePluginOptions } from './vite'

