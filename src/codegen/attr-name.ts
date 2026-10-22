/**
 * 模板属性名归一（编译期）。
 *
 * html 命名空间下，含大写的属性名转为 kebab-case —— 与运行期 html() 指令的
 * convertHTML（compelem/src/directives/Html.ts）同一语义、同一函数（myfx kebabCase），
 * 补齐编译期 h`` 模板对 camelCase prop 写法的支持（如 headerHeight → header-height）。
 * 运行期全链路已支持 kebab 属性名（#initProps 的 kebabCaseCached 查表 /
 * attributeChangedCallback 的 camelCaseCached 反查 / up.attrName → setAttribute）。
 *
 * 明确排除（调用点保证，本函数不管）：
 * - 事件名（@ev）：事件名是全小写单词（scroll / contextmenuselect / cellactive…），
 *   旧 toLowerCase 行为正好匹配，kebab 化反而破坏 —— 事件走 lowerName；
 * - *refAttr：自带 :camel/:kebab/:snake 显式格式控制；
 * - `.prop` 绑定：直接写 JS 属性，大小写天然保留。
 *
 * ⚠️ **kebab 只对自定义/组件标签生效**（2026-10-22 审查 C-5）。
 *
 * 理由：kebab 化的目的只有一个 —— 让 CompElem 的 camelCase **prop** 能通过
 * attribute 写（`headerHeight` → `header-height`，运行期 `kebabCaseCached` 反查回 prop）。
 * 原生标签没有这种 prop 通道，浏览器认的属性名是小写：`maxLength` 被 kebab 成
 * `max-length`、`tabIndex` → `tab-index` 之后**属性直接失效且零诊断** ——
 * 用户按 DOM property 习惯写（React 式）必然踩。原生标签回落 `toLowerCase()`
 * 至少能让 `colSpan` → `colspan`、`readOnly` → `readonly` 正确落地。
 *
 * `tagLower` 缺省时按"组件标签"处理（保持旧行为，兼容尚未补传的调用点）。
 */
import { kebabCase } from 'myfx'

export function normalizeAttrName(
  ns: 'html' | 'svg',
  name: string,
  tagLower?: string,
  knownTags?: { has(name: string): boolean },
): string {
  if (ns !== 'html') return name
  // 无大写：与旧 toLowerCase 行为恒等（产物零 diff），快速返回
  if (!/[A-Z]/.test(name)) return name
  const custom =
    tagLower === undefined ? true : !!knownTags?.has(tagLower) || tagLower.includes('-') || tagLower === 'slot'
  return custom ? kebabCase(name) : name.toLowerCase()
}
