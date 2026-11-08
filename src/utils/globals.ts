/**
 * 模板插值里允许出现的**全局白名单**
 *
 * 判据：**浏览器/JS 平台真实存在的全局** 一律收录；不收的只有「不存在的名字」（拼错的
 * 本地变量、未 import 的模块成员）。D3 的目的是抓「自由标识符拼错 / 忘记 import」，
 * 不是抓「用了平台 API」—— 后者运行期完全合法，收窄白名单只会制造硬失败。
 */
/**
 * `lib.dom.d.ts` 全部顶层 `declare var` 的大写名（构造器 / 接口），共 516 条。
 *
 * 大写开头不会与业务变量混淆，且都是浏览器真实绑定：这类名字出现在插值里只可能是
 * 「用了平台 API」而不是「拼错本地变量」，收窄白名单只会制造 D3 硬失败。
 */
const DOM_CONSTRUCTOR_GLOBALS: readonly string[] = [
  'AbstractRange', 'AnalyserNode', 'AnimationEffect', 'AnimationPlaybackEvent', 'AnimationTimeline', 'Attr',
  'AudioBuffer', 'AudioBufferSourceNode', 'AudioContext', 'AudioData', 'AudioDecoder', 'AudioDestinationNode',
  'AudioEncoder', 'AudioListener', 'AudioNode', 'AudioParam', 'AudioParamMap', 'AudioProcessingEvent',
  'AudioScheduledSourceNode', 'AudioWorklet', 'AudioWorkletNode', 'AuthenticatorAssertionResponse', 'AuthenticatorAttestationResponse', 'AuthenticatorResponse',
  'BarProp', 'BaseAudioContext', 'BiquadFilterNode', 'BlobEvent', 'ByteLengthQueuingStrategy', 'CDATASection',
  'CSPViolationReportBody', 'CSSAnimation', 'CSSConditionRule', 'CSSContainerRule', 'CSSCounterStyleRule', 'CSSFontFaceRule',
  'CSSFontFeatureValuesRule', 'CSSFontPaletteValuesRule', 'CSSGroupingRule', 'CSSImageValue', 'CSSImportRule', 'CSSKeyframeRule',
  'CSSKeywordValue', 'CSSLayerBlockRule', 'CSSLayerStatementRule', 'CSSMathClamp', 'CSSMathInvert', 'CSSMathMax',
  'CSSMathMin', 'CSSMathNegate', 'CSSMathProduct', 'CSSMathSum', 'CSSMathValue', 'CSSMatrixComponent',
  'CSSNamespaceRule', 'CSSNestedDeclarations', 'CSSNumericArray', 'CSSNumericValue', 'CSSPageRule', 'CSSPerspective',
  'CSSPropertyRule', 'CSSRotate', 'CSSScale', 'CSSScopeRule', 'CSSSkew', 'CSSSkewX',
  'CSSSkewY', 'CSSStartingStyleRule', 'CSSStyleRule', 'CSSStyleValue', 'CSSTransformComponent', 'CSSTransformValue',
  'CSSTransition', 'CSSTranslate', 'CSSUnitValue', 'CSSUnparsedValue', 'CSSVariableReferenceValue', 'CSSViewTransitionRule',
  'Cache', 'CacheStorage', 'CanvasCaptureMediaStreamTrack', 'CanvasGradient', 'CanvasPattern', 'CanvasRenderingContext2D',
  'CaretPosition', 'ChannelMergerNode', 'ChannelSplitterNode', 'CharacterData', 'Clipboard', 'ClipboardItem',
  'CloseEvent', 'CompressionStream', 'ConstantSourceNode', 'ContentVisibilityAutoStateChangeEvent', 'ConvolverNode', 'CookieChangeEvent',
  'CookieStore', 'CookieStoreManager', 'CountQueuingStrategy', 'Credential', 'CredentialsContainer', 'Crypto',
  'CryptoKey', 'CustomElementRegistry', 'CustomStateSet', 'DOMImplementation', 'DOMMatrix', 'DOMMatrixReadOnly',
  'DOMPoint', 'DOMPointReadOnly', 'DOMQuad', 'DOMStringList', 'DOMStringMap', 'DataTransfer',
  'DataTransferItem', 'DataTransferItemList', 'DecompressionStream', 'DelayNode', 'Document', 'DocumentType',
  'DynamicsCompressorNode', 'EncodedAudioChunk', 'EncodedVideoChunk', 'EventCounts', 'External', 'FileList',
  'FileSystem', 'FileSystemDirectoryEntry', 'FileSystemDirectoryHandle', 'FileSystemDirectoryReader', 'FileSystemEntry', 'FileSystemFileEntry',
  'FileSystemFileHandle', 'FileSystemHandle', 'FileSystemWritableFileStream', 'FontFace', 'FontFaceSet', 'FontFaceSetLoadEvent',
  'FormDataEvent', 'FragmentDirective', 'GainNode', 'Gamepad', 'GamepadButton', 'GamepadHapticActuator',
  'Geolocation', 'GeolocationCoordinates', 'GeolocationPosition', 'GeolocationPositionError', 'HTMLAllCollection', 'HTMLAreaElement',
  'HTMLBRElement', 'HTMLBaseElement', 'HTMLBodyElement', 'HTMLDListElement', 'HTMLDataElement', 'HTMLDataListElement',
  'HTMLDirectoryElement', 'HTMLDocument', 'HTMLEmbedElement', 'HTMLFieldSetElement', 'HTMLFontElement', 'HTMLFormControlsCollection',
  'HTMLFrameElement', 'HTMLFrameSetElement', 'HTMLHRElement', 'HTMLHeadElement', 'HTMLHeadingElement', 'HTMLHtmlElement',
  'HTMLLegendElement', 'HTMLLinkElement', 'HTMLMapElement', 'HTMLMarqueeElement', 'HTMLMenuElement', 'HTMLMetaElement',
  'HTMLMeterElement', 'HTMLModElement', 'HTMLObjectElement', 'HTMLOptGroupElement', 'HTMLOptionsCollection', 'HTMLOutputElement',
  'HTMLParagraphElement', 'HTMLParamElement', 'HTMLPictureElement', 'HTMLPreElement', 'HTMLProgressElement', 'HTMLQuoteElement',
  'HTMLSourceElement', 'HTMLTableCaptionElement', 'HTMLTableCellElement', 'HTMLTableColElement', 'HTMLTableRowElement', 'HTMLTableSectionElement',
  'HTMLTimeElement', 'HTMLTitleElement', 'HTMLTrackElement', 'Highlight', 'HighlightRegistry', 'History',
  'IDBCursor', 'IDBCursorWithValue', 'IDBDatabase', 'IDBFactory', 'IDBIndex', 'IDBKeyRange',
  'IDBObjectStore', 'IDBOpenDBRequest', 'IDBRequest', 'IDBTransaction', 'IDBVersionChangeEvent', 'IIRFilterNode',
  'IdleDeadline', 'ImageBitmapRenderingContext', 'ImageCapture', 'ImageDecoder', 'ImageTrack', 'ImageTrackList',
  'InputDeviceInfo', 'LargestContentfulPaint', 'Location', 'Lock', 'LockManager', 'MIDIAccess',
  'MIDIConnectionEvent', 'MIDIInput', 'MIDIInputMap', 'MIDIMessageEvent', 'MIDIOutput', 'MIDIOutputMap',
  'MIDIPort', 'MediaCapabilities', 'MediaDeviceInfo', 'MediaDevices', 'MediaElementAudioSourceNode', 'MediaEncryptedEvent',
  'MediaError', 'MediaKeyMessageEvent', 'MediaKeySession', 'MediaKeyStatusMap', 'MediaKeySystemAccess', 'MediaKeys',
  'MediaList', 'MediaMetadata', 'MediaQueryList', 'MediaRecorder', 'MediaSession', 'MediaSource',
  'MediaSourceHandle', 'MediaStream', 'MediaStreamAudioDestinationNode', 'MediaStreamAudioSourceNode', 'MediaStreamTrack', 'MediaStreamTrackEvent',
  'MimeType', 'MimeTypeArray', 'NavigationActivation', 'NavigationHistoryEntry', 'NavigationPreloadManager', 'Navigator',
  'NavigatorLogin', 'NodeFilter', 'NodeIterator', 'OfflineAudioCompletionEvent', 'OfflineAudioContext', 'OffscreenCanvasRenderingContext2D',
  'OscillatorNode', 'OverconstrainedError', 'PageRevealEvent', 'PageSwapEvent', 'PannerNode', 'PaymentAddress',
  'PaymentMethodChangeEvent', 'PaymentRequest', 'PaymentRequestUpdateEvent', 'PaymentResponse', 'Performance', 'PerformanceEventTiming',
  'PerformanceMark', 'PerformanceMeasure', 'PerformanceNavigation', 'PerformanceNavigationTiming', 'PerformanceObserverEntryList', 'PerformancePaintTiming',
  'PerformanceResourceTiming', 'PerformanceServerTiming', 'PerformanceTiming', 'PeriodicWave', 'PermissionStatus', 'Permissions',
  'PictureInPictureEvent', 'PictureInPictureWindow', 'Plugin', 'PluginArray', 'ProcessingInstruction', 'PublicKeyCredential',
  'PushManager', 'PushSubscription', 'PushSubscriptionOptions', 'RTCCertificate', 'RTCDTMFSender', 'RTCDTMFToneChangeEvent',
  'RTCDataChannel', 'RTCDataChannelEvent', 'RTCDtlsTransport', 'RTCEncodedAudioFrame', 'RTCEncodedVideoFrame', 'RTCError',
  'RTCErrorEvent', 'RTCIceCandidate', 'RTCIceTransport', 'RTCPeerConnection', 'RTCPeerConnectionIceErrorEvent', 'RTCPeerConnectionIceEvent',
  'RTCRtpReceiver', 'RTCRtpScriptTransform', 'RTCRtpSender', 'RTCRtpTransceiver', 'RTCSctpTransport', 'RTCSessionDescription',
  'RTCStatsReport', 'RTCTrackEvent', 'RadioNodeList', 'Range', 'ReadableByteStreamController', 'ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest', 'ReadableStreamDefaultController', 'ReadableStreamDefaultReader', 'RemotePlayback', 'Report', 'ReportBody',
  'ReportingObserver', 'SVGAElement', 'SVGAngle', 'SVGAnimateElement', 'SVGAnimateMotionElement', 'SVGAnimateTransformElement',
  'SVGAnimatedAngle', 'SVGAnimatedBoolean', 'SVGAnimatedEnumeration', 'SVGAnimatedInteger', 'SVGAnimatedLength', 'SVGAnimatedLengthList',
  'SVGAnimatedNumber', 'SVGAnimatedNumberList', 'SVGAnimatedPreserveAspectRatio', 'SVGAnimatedRect', 'SVGAnimatedString', 'SVGAnimatedTransformList',
  'SVGAnimationElement', 'SVGCircleElement', 'SVGClipPathElement', 'SVGComponentTransferFunctionElement', 'SVGDefsElement', 'SVGDescElement',
  'SVGEllipseElement', 'SVGFEBlendElement', 'SVGFEColorMatrixElement', 'SVGFEComponentTransferElement', 'SVGFECompositeElement', 'SVGFEConvolveMatrixElement',
  'SVGFEDiffuseLightingElement', 'SVGFEDisplacementMapElement', 'SVGFEDistantLightElement', 'SVGFEDropShadowElement', 'SVGFEFloodElement', 'SVGFEFuncAElement',
  'SVGFEFuncBElement', 'SVGFEFuncGElement', 'SVGFEFuncRElement', 'SVGFEGaussianBlurElement', 'SVGFEImageElement', 'SVGFEMergeElement',
  'SVGFEMergeNodeElement', 'SVGFEMorphologyElement', 'SVGFEOffsetElement', 'SVGFEPointLightElement', 'SVGFESpecularLightingElement', 'SVGFESpotLightElement',
  'SVGFETileElement', 'SVGFETurbulenceElement', 'SVGFilterElement', 'SVGForeignObjectElement', 'SVGGElement', 'SVGGeometryElement',
  'SVGGradientElement', 'SVGGraphicsElement', 'SVGImageElement', 'SVGLength', 'SVGLengthList', 'SVGLineElement',
  'SVGLinearGradientElement', 'SVGMPathElement', 'SVGMarkerElement', 'SVGMaskElement', 'SVGMatrix', 'SVGMetadataElement',
  'SVGNumber', 'SVGNumberList', 'SVGPathElement', 'SVGPatternElement', 'SVGPoint', 'SVGPointList',
  'SVGPolygonElement', 'SVGPolylineElement', 'SVGPreserveAspectRatio', 'SVGRadialGradientElement', 'SVGRect', 'SVGRectElement',
  'SVGSVGElement', 'SVGScriptElement', 'SVGSetElement', 'SVGStopElement', 'SVGStringList', 'SVGStyleElement',
  'SVGSwitchElement', 'SVGSymbolElement', 'SVGTSpanElement', 'SVGTextContentElement', 'SVGTextElement', 'SVGTextPathElement',
  'SVGTextPositioningElement', 'SVGTitleElement', 'SVGTransform', 'SVGTransformList', 'SVGUnitTypes', 'SVGUseElement',
  'SVGViewElement', 'Screen', 'ScreenOrientation', 'ScriptProcessorNode', 'Selection', 'ServiceWorker',
  'ServiceWorkerContainer', 'ServiceWorkerRegistration', 'SharedWorker', 'SourceBuffer', 'SourceBufferList', 'SpeechRecognitionAlternative',
  'SpeechRecognitionResult', 'SpeechRecognitionResultList', 'SpeechSynthesis', 'SpeechSynthesisErrorEvent', 'SpeechSynthesisEvent', 'SpeechSynthesisUtterance',
  'SpeechSynthesisVoice', 'StaticRange', 'StereoPannerNode', 'Storage', 'StorageManager', 'StylePropertyMap',
  'StylePropertyMapReadOnly', 'StyleSheet', 'StyleSheetList', 'SubtleCrypto', 'TextDecoderStream', 'TextEncoderStream',
  'TextEvent', 'TextMetrics', 'TextTrack', 'TextTrackCue', 'TextTrackCueList', 'TextTrackList',
  'TimeRanges', 'ToggleEvent', 'Touch', 'TouchList', 'TrackEvent', 'TransformStreamDefaultController',
  'TreeWalker', 'UserActivation', 'VTTCue', 'VTTRegion', 'ValidityState', 'VideoColorSpace',
  'VideoDecoder', 'VideoEncoder', 'VideoFrame', 'VideoPlaybackQuality', 'ViewTransition', 'ViewTransitionTypeSet',
  'VisualViewport', 'WakeLock', 'WakeLockSentinel', 'WaveShaperNode', 'WebGL2RenderingContext', 'WebGLActiveInfo',
  'WebGLBuffer', 'WebGLContextEvent', 'WebGLFramebuffer', 'WebGLProgram', 'WebGLQuery', 'WebGLRenderbuffer',
  'WebGLRenderingContext', 'WebGLSampler', 'WebGLShader', 'WebGLShaderPrecisionFormat', 'WebGLSync', 'WebGLTexture',
  'WebGLTransformFeedback', 'WebGLUniformLocation', 'WebGLVertexArrayObject', 'WebKitCSSMatrix', 'WebTransport', 'WebTransportBidirectionalStream',
  'WebTransportDatagramDuplexStream', 'WebTransportError', 'Window', 'Worklet', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter',
  'XMLDocument', 'XMLHttpRequestEventTarget', 'XPathEvaluator', 'XPathExpression', 'XPathResult', 'XSLTProcessor',
]

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
  // Event 子类族：构造函数常直接出现在插值里（`new MouseEvent(...)`），
  // 也是 `instanceof` 的常见右操作数。族内名字不会与普通变量混淆。
  'UIEvent', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'TouchEvent', 'WheelEvent',
  'DragEvent', 'InputEvent', 'FocusEvent', 'SubmitEvent', 'ProgressEvent', 'AnimationEvent',
  'TransitionEvent', 'ClipboardEvent', 'CompositionEvent', 'ErrorEvent', 'MessageEvent',
  'PopStateEvent', 'HashChangeEvent', 'StorageEvent', 'PageTransitionEvent', 'BeforeUnloadEvent',
  'PromiseRejectionEvent', 'SecurityPolicyViolationEvent', 'MediaQueryListEvent', 'GamepadEvent',
  'DeviceMotionEvent', 'DeviceOrientationEvent',
  // 网络 / 并发 / 图形
  'XMLHttpRequest', 'XMLHttpRequestUpload', 'Atomics', 'WebAssembly', 'caches',
  'ReadableStream', 'WritableStream', 'TransformStream', 'createImageBitmap',
  'OffscreenCanvas', 'ImageBitmap', 'ImageData', 'Path2D', 'reportError',
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
  // window 的度量属性：只有精确拼写才命中，且都是只读值（不可能撞本地声明）
  // 不收录 self/top/parent/name/status/length/origin：与普通变量名高度重名
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'scrollX', 'scrollY',
  'pageXOffset', 'pageYOffset', 'screen', 'screenX', 'screenY', 'screenLeft', 'screenTop',
  'visualViewport', 'isSecureContext',
  // window 上可直接裸调的方法：与 scroll/alert 同类，名字足够独特
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'getSelection', 'postMessage',
  'moveBy', 'moveTo', 'resizeBy', 'resizeTo', 'cookieStore', 'crossOriginIsolated',
  'speechSynthesis', 'webkitURL',
  // lib.dom.d.ts 的全部顶层构造器 / 接口（见 DOM_CONSTRUCTOR_GLOBALS）
  ...DOM_CONSTRUCTOR_GLOBALS,
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
  'caches', 'cookieStore', 'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'scrollX', 'scrollY',
  'pageXOffset', 'pageYOffset', 'screen', 'screenX', 'screenY', 'screenLeft', 'screenTop',
  'visualViewport', 'isSecureContext',
])
