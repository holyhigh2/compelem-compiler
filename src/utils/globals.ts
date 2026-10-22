/**
 * 模板插值里允许出现的**全局白名单**
 *
 * 判据：**浏览器/JS 平台真实存在的全局** 一律收录；不收的只有「不存在的名字」（拼错的
 * 本地变量、未 import 的模块成员）。D3 的目的是抓「自由标识符拼错 / 忘记 import」，
 * 不是抓「用了平台 API」—— 后者运行期完全合法，收窄白名单只会制造硬失败。
 */
export const KNOWN_GLOBALS: ReadonlySet<string> = new Set([
  // 值类型与构造
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'RegExp', 'Date',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry', 'Promise',
  'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'AggregateError', 'Proxy', 'Reflect', 'Intl',
  // 字面量与纯函数
  'undefined', 'null', 'true', 'false', 'NaN', 'Infinity',
  'Math', 'JSON', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  'escape', 'unescape', 'structuredClone',
  // 平台 / DOM
  'console', 'window', 'document', 'globalThis', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'performance', 'crypto', 'devicePixelRatio',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'FileReader',
  'URL', 'URLSearchParams', 'WebSocket', 'Worker', 'EventSource', 'Notification', 'indexedDB',
  'AbortController', 'AbortSignal', 'Event', 'CustomEvent', 'EventTarget', 'MessageChannel',
  'MessagePort', 'BroadcastChannel',
  // DOM 节点 / 元素
  'Node', 'NodeList', 'NamedNodeMap', 'HTMLCollection', 'DocumentFragment', 'ShadowRoot',
  'Element', 'HTMLElement', 'SVGElement', 'MathMLElement', 'Text', 'Comment',
  'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLTemplateElement',
  'HTMLSlotElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLButtonElement',
  'HTMLLabelElement', 'HTMLFormElement', 'HTMLOptionElement', 'HTMLCanvasElement',
  'HTMLDialogElement', 'HTMLTableElement', 'HTMLDetailsElement', 'HTMLLIElement',
  'HTMLUListElement', 'HTMLOListElement', 'HTMLDivElement', 'HTMLSpanElement',
  'HTMLStyleElement', 'HTMLScriptElement', 'HTMLVideoElement', 'HTMLAudioElement',
  'HTMLMediaElement', 'HTMLIFrameElement', 'HTMLUnknownElement',
  // 平台对象 / 度量
  'customElements', 'ElementInternals', 'CSS', 'CSSStyleSheet', 'CSSStyleDeclaration',
  'CSSRule', 'CSSRuleList', 'CSSMediaRule', 'CSSSupportsRule', 'CSSKeyframesRule',
  'DOMRect', 'DOMRectReadOnly', 'DOMRectList', 'DOMTokenList', 'DOMException',
  'DOMParser', 'XMLSerializer', 'Image', 'Audio', 'Option',
  'Animation', 'KeyframeEffect', 'DocumentTimeline',
  'TextEncoder', 'TextDecoder', 'atob', 'btoa',
  'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback',
  'ResizeObserver', 'ResizeObserverEntry', 'ResizeObserverSize',
  'IntersectionObserver', 'IntersectionObserverEntry', 'MutationObserver', 'MutationRecord',
  'PerformanceObserver', 'PerformanceEntry',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  // window 上可直接裸调的方法（不收录 focus/blur/stop/find/moveTo/resizeTo：
  // 这些词太容易与本地函数重名，收录反而会吞掉真正的拼写错误）
  'scroll', 'scrollTo', 'scrollBy', 'alert', 'confirm', 'prompt', 'print', 'open', 'close',
])

/**
 * 上述全局中**不纯**的子集：取值依赖外部状态 / 时钟，静态依赖映射无法归因
 * → 引用它们的表达式整体归入「常脏」（任一视图更新都重算，与全量求值行为一致）。
 */
export const IMPURE_GLOBALS: ReadonlySet<string> = new Set([
  'Date', 'console', 'window', 'document', 'globalThis', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'performance', 'crypto', 'fetch', 'Math', 'JSON',
  'Event', 'CustomEvent', 'EventTarget', 'MessageChannel',
  // 读取浏览器/注册表等外部可变状态：结果不随本组件信号变化，只能常脏
  'customElements', 'devicePixelRatio', 'indexedDB', 'matchMedia', 'getComputedStyle',
])
