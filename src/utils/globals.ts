/**
 * 模板插值里允许出现的**全局白名单**
 */
export const KNOWN_GLOBALS: ReadonlySet<string> = new Set([
  // 值类型与构造
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'RegExp', 'Date',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'Proxy', 'Reflect', 'Intl',
  // 字面量与纯函数
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
  'Math', 'JSON', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'escape', 'unescape', 'structuredClone',
  // 平台 / DOM
  'console', 'window', 'document', 'globalThis', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'performance', 'crypto',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'URL', 'URLSearchParams',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget', 'MessageChannel',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLTemplateElement', 'HTMLSlotElement', 'HTMLAnchorElement', 'HTMLImageElement', 'SVGElement',
  'Text', 'Comment', 'DocumentFragment', 'ShadowRoot', 'CSSStyleSheet', 'CSSStyleDeclaration',
  'DOMParser', 'XMLSerializer', 'Image', 'Audio', 'Option', 'TextEncoder', 'TextDecoder',
  'atob', 'btoa',
  'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'PerformanceObserver',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
])

/**
 * 上述全局中**不纯**的子集：取值依赖外部状态 / 时钟，静态依赖映射无法归因
 * → 引用它们的表达式整体归入「常脏」（任一视图更新都重算，与全量求值行为一致）。
 */
export const IMPURE_GLOBALS: ReadonlySet<string> = new Set([
  'Date', 'console', 'window', 'document', 'globalThis', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'performance', 'crypto', 'fetch', 'Math', 'JSON',
  'Event', 'CustomEvent', 'EventTarget', 'MessageChannel',
])
