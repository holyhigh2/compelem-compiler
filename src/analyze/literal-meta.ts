/**
 * @prop/@state 初始值的**编译期**元数据推导（`defaultValue` / `type`）。
 *
 * 背景：`__ce_static__.props/states` 的条目若只带**装饰器自己给的 options**，
 * 则 `@prop title = 'untitled'` 会产出 `props: { "title": {} }` —— 默认值与类型
 * 两个最基本的信息全部丢失。因为字段声明（含初始值）在 field-extract 里被**整体
 * 删除**，初始值只流向构造体的 `signal(<init>)`，从不回流到元数据表。
 *
 * 运行时其实一直有推导能力，但那是**首实例构造期**的惰性补写
 * （CompElem#initProps：从 `__s[key].value` 反推 `propDef.type` 并就地改写
 * ctor 级共享表）。把它前移到编译期有三个好处：产物自解释（devtools / 序列化 /
 * 肉眼 review 都能直接看到默认值与类型）、省掉首实例的一次惰性写入、类型信息在
 * 任何实例创建之前就已就位。
 *
 * 推导规则**严格镜像运行时**（compelem/src/constants.ts 的 `PropTypeMap`：
 * `boolean→Boolean` / `string→String` / `number→Number` / `object→Object` /
 * `array→Array` / `function→Function`），否则编译期与运行期会给出两套答案。
 *
 * 两条独立的判定，宽松程度不同 —— 因为**求值**比**分类**危险得多：
 *
 *   - `typeName`（分类）不需要求值，所以范围可以宽：`new Foo()`、标识符、
 *     成员表达式都能靠 `typeof` 语义分类。
 *   - `valueText`（求值）要求「原样复制进 `static __ce_static__ = { … }` 后
 *     求值安全」：`static` 类字段在**模块作用域**求值，`this` 不可用（那会是类
 *     自身而非实例），且任何有副作用的表达式都会在类定义时提前跑一次。故只接受
 *     **纯字面量**：字符串 / 数字 / 布尔 / null / 正则 / 无插值模板 / 一元数值 /
 *     全纯字面量的数组与对象字面量。标识符、调用、`new`、成员访问、含展开或
 *     标识符值的容器一律**不写** `defaultValue`（运行时会照旧从信号读真值）。
 *
 * 已知的表达力取舍（有意为之，不是遗漏）：
 *   - `defaultValue` 对对象 / 数组 / 函数**不写**，避免静态表里的对象被误当成
 *     实例真值 —— 构造体里 `signal([])` 建的是**另一个**数组，`!==`。函数尤其
 *     危险：两边是两个不同的函数对象。只给不可变原始值（string/number/boolean/
 *     null/RegExp）写 `defaultValue`，值相等即可安全比较。
 *   - `null` 写 `defaultValue` 但**不推 type**：`null` 不携带类型信息，而运行时
 *     会把 `typeof null` 推成 `Object`（`PropTypeMap.object`），写 `Object` 是
 *     谎报；不写则运行期仍会补上，行为不变。
 *   - BigInt / 正则同理：运行时分别推成 `undefined`（`PropTypeMap` 无 `bigint` 键）
 *     与 `Object`，都不比「不写」更诚实。
 *   - `type` 恒不覆盖装饰器里显式写出的 `type`（`@prop({ type: Number })` 是
 *     作者的显式声明，优先级高于从默认值反推）。
 */
import { unwrapTsExpr } from './conventions'

export interface InitMeta {
  /**
   * 纯字面量的源码文本（可原样复制进静态字段求值）。非纯字面量、或对象/数组/
   * 函数默认值（静态表与实例真值不同一）时为 undefined。
   */
  valueText?: string
  /**
   * 推导出的构造器名（`String` / `Number` / `Boolean` / `Array` / `Object` /
   * `Function`），与运行时 `PropTypeMap` 的取值域一致。不可推导时 undefined。
   */
  typeName?: string
}

const EMPTY: InitMeta = {}

/** oxc 走 ESTree 形态（`Literal` + `value`/`regex`/`bigint`），babel 形态（`NumericLiteral` 等）也一并认。 */
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
 * 是否是「复制进静态字段求值安全」的纯字面量。
 *
 * 判据：无 `this`、无副作用、无标识符/绑定引用、无展开。容器要求**逐元素**递归
 * 通过 —— `{ a: 1, b: SOME_CONST }` 里的 `SOME_CONST` 是自由引用，类定义时求值
 * 会踩模块绑定（顺序/TDZ），故整条链一起否决。
 */
export function isPureLiteral(node: any): boolean {
  const n = unwrapTsExpr(node)
  if (!n) return false
  switch (n.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'RegExpLiteral':
      return true
    case 'Literal':
      // oxc ESTree 形态：null / bigint / 正则 同为 `Literal`，靠 regex / bigint 字段区分
      return !n.regex && n.bigint === undefined
    case 'TemplateLiteral':
      // 有插值就不是纯字面量（插值内是自由表达式求值）
      return !(n.expressions ?? []).length
    case 'UnaryExpression':
      return (
        (n.operator === '+' || n.operator === '-' || n.operator === '!') && isPureLiteral(n.argument)
      )
    case 'ArrayExpression':
      // 空洞（`[1,,3]` 的 elisions）元素为 null，同样否决
      return (n.elements ?? []).every((e: any) => e != null && isPureLiteral(e))
    case 'ObjectExpression':
      return (n.properties ?? []).every(
        (p: any) =>
          p.type === 'Property' &&
          !p.computed &&
          !p.shorthand &&
          (p.kind ?? 'init') === 'init' &&
          isPureLiteral(p.value),
      )
    default:
      return false
  }
}

/** 纯字面量的源码文本（`unwrapTsExpr` 后取 span，剥掉 `as T` / 非空断言等 TS 包装）。 */
function literalText(n: any, code: string): string | undefined {
  if (typeof n?.start !== 'number' || typeof n?.end !== 'number') return undefined
  return code.slice(n.start, n.end)
}

/**
 * 推导字段初始值的编译期元数据。
 * @param rawNode `PropertyDefinition.value`（可能为 undefined = 无初始值）
 * @param code 源文件全文（用于取字面量源码文本）
 */
export function inferInitMeta(rawNode: any, code: string): InitMeta {
  const node = unwrapTsExpr(rawNode)
  if (!node) return EMPTY

  // ---- 原始值：可写 defaultValue（不可变原始值跨副本仍然相等）----
  if (isStringLit(node)) return { valueText: literalText(node, code), typeName: 'String' }
  if (isNumericLit(node)) return { valueText: literalText(node, code), typeName: 'Number' }
  if (isBooleanLit(node)) return { valueText: literalText(node, code), typeName: 'Boolean' }
  if (node.type === 'Literal') {
    // 未覆盖的 Literal：null（纯、无类型信息）/ bigint / 正则
    return isPureLiteral(node) ? { valueText: literalText(node, code) } : EMPTY
  }
  if (node.type === 'NullLiteral' || node.type === 'BigIntLiteral' || node.type === 'RegExpLiteral') {
    return isPureLiteral(node) ? { valueText: literalText(node, code) } : EMPTY
  }
  if (node.type === 'TemplateLiteral') {
    if (!(node.expressions ?? []).length) return { valueText: literalText(node, code), typeName: 'String' }
    // 有插值 → 类型可判（拼出来必是 string），但求值含自由表达式，不写值
    return { typeName: 'String' }
  }
  if (node.type === 'UnaryExpression') {
    const out: InitMeta = {}
    if (isPureLiteral(node)) out.valueText = literalText(node, code)
    const op = node.operator
    if (isNumericUnary(node)) out.typeName = 'Number'
    else if (op === '!') out.typeName = 'Boolean'
    return out
  }
  if (node.type === 'ArrayExpression') return { typeName: 'Array' }
  if (node.type === 'ObjectExpression') return { typeName: 'Object' }
  if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
    return { typeName: 'Function' }
  }
  return EMPTY
}
