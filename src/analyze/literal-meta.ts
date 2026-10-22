/**
 * @prop/@state 初始值的**编译期**类型推导。
 *
 * 字段声明在 field-extract 里被整体删除，初始值只流向构造体的 `signal(<init>)`；
 * 为了让 `__ce_static__.props` 在首实例之前就带类型，这里从初始化器推导
 * `typeName`。值本身不再写进静态表（`defaultValue` 早已移除）——静态表里的
 * 对象/数组与实例信号不是同一个对象，写进去只会误导。
 *
 * 推导规则严格镜像 compelem 运行时 `PropTypeMap`：
 * boolean→Boolean / string→String / number→Number / object→Object /
 * array→Array / function→Function；null / bigint / regex 不携带可靠类型信息，不写。
 */
import { unwrapTsExpr } from './conventions'

export interface InitMeta {
  /** 推导出的构造器名（String / Number / Boolean / Array / Object / Function）。 */
  typeName?: string
}

const EMPTY: InitMeta = {}

/** ESTree 形态（`Literal` + value/regex/bigint），babel 原生形态也一并认。 */
export function isNumericLit(n: any): boolean {
  return n?.type === 'NumericLiteral' || (n?.type === 'Literal' && typeof n.value === 'number')
}
export function isStringLit(n: any): boolean {
  return n?.type === 'StringLiteral' || (n?.type === 'Literal' && typeof n.value === 'string')
}
export function isBooleanLit(n: any): boolean {
  return n?.type === 'BooleanLiteral' || (n?.type === 'Literal' && typeof n.value === 'boolean')
}
/** 一元 `+` / `-` 作用在数值字面量上（`-1`、`+0`）—— typeof 仍是 number。 */
export function isNumericUnary(n: any): boolean {
  return (
    n?.type === 'UnaryExpression' &&
    (n.operator === '+' || n.operator === '-') &&
    isNumericLit(unwrapTsExpr(n.argument))
  )
}

/**
 * 推导字段初始值的编译期类型。
 * @param rawNode `PropertyDefinition.value`（undefined = 无初始值）
 */
export function inferInitMeta(rawNode: any): InitMeta {
  const node = unwrapTsExpr(rawNode)
  if (!node) return EMPTY

  if (isStringLit(node)) return { typeName: 'String' }
  if (isNumericLit(node)) return { typeName: 'Number' }
  if (isBooleanLit(node)) return { typeName: 'Boolean' }
  // null / bigint / regex：运行时分别推成 Object / undefined / Object，都不比“不写”更可靠。
  if (node.type === 'Literal' || node.type === 'NullLiteral' || node.type === 'BigIntLiteral' || node.type === 'RegExpLiteral') {
    return EMPTY
  }
  if (node.type === 'TemplateLiteral') return { typeName: 'String' }
  if (node.type === 'UnaryExpression') {
    if (isNumericUnary(node)) return { typeName: 'Number' }
    if (node.operator === '!') return { typeName: 'Boolean' }
    return EMPTY
  }
  if (node.type === 'ArrayExpression') return { typeName: 'Array' }
  if (node.type === 'ObjectExpression') return { typeName: 'Object' }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    return { typeName: 'Function' }
  }
  return EMPTY
}
