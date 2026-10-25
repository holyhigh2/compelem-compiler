/**
 * @compelem/compiler — 编译器
 */
export { analyzeFile, collectCompelemImports, isCompelemSource } from './analyze/component'
export { inlineTemplateMethods } from './analyze/inline-template-methods'
export { parse } from './utils/ast'
export { assertStaticAnalysis, StaticAnalysisError } from './analyze/static-gate'
export { analyzeRender } from './analyze/render-body'
export type { RenderAnalysis } from './analyze/render-body'
export { buildStaticLiteral, injectInto } from './codegen/inject'
export { compileFile, compileSource, defaultInclude } from './compile'
export type { CompileResult, DepSummary } from './compile'
export {
  collectDiagnostics,
  newlineIndex,
  offsetToLineCol,
  relativeToRoot,
  reportConventionDiagnostics,
  reportDiagnostics,
} from './diagnostics'
export type { CollectedDiagnostics, ConventionMode } from './diagnostics'
export { DEFAULT_TAG_EXT, TAG_RE, scanKnownTags } from './tag-registry'
export type { ScanKnownTagsOptions } from './tag-registry'
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

