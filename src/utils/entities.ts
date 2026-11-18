/**
 * 模板静态文本的 HTML 实体解码。
 *
 * compelem 的 h`` 模板外观是 HTML，开发者自然会写 `&nbsp;` / `&amp;` 这类实体。
 * 但 codegen 走的是「编译期解析 + createTextNode/序列化 HTML 串」，两条路径
 * 都不会像浏览器 innerHTML 那样自动解码实体，导致 `&nbsp;` 字面显示在界面上。
 *
 * 本模块在**编译期**把静态片段（文本与属性值）里的实体解码成真实字符，写进 codegen 字面量：
 * - createElement 路径：createTextNode("1.\u00A0标题") / setAttribute —— 直接是真字符
 * - innerHTML 路径：真字符经 escText/escAttr 重新转义后交给浏览器，显示为真字符
 *
 * 只处理静态片段；插值 ${...} 的值由运行时决定，绝不做实体解码。
 * 真 rawtext 标签（script/style/xmp 等）下的文本是真内容，调用方不传进来解码；
 * textarea/title 是 RCDATA、pre/listing 是普通元素，浏览器照常解码，不豁免。
 */

/**
 * 常用 HTML 命名实体表（取值与 WHATWG HTML5 named character references 一致，
 * 覆盖是文档/UI 高频**子集**）。匹配规则：小写、整词、分号可选；
 * 未列出的命名实体（含大小写变体如 &AMP;、带后缀如 &copycat）原样保留。
 */
const NAMED: Record<string, string> = {
  // 空白
  nbsp: '\u00A0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  zwnj: '\u200C',
  zwj: '\u200D',
  lrm: '\u200E',
  rlm: '\u200F',
  // 标点 / 常用符号
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  sect: '\u00A7',
  para: '\u00B6',
  middot: '\u00B7',
  bull: '\u2022',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
  frac12: '\u00BD',
  frac14: '\u00BC',
  frac34: '\u00BE',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',
  dollar: '$',
  // 数学
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  iss: '\u2272',
  sub: '\u2282',
  sup: '\u2283',
  infin: '\u221E',
  radic: '\u221A',
  sum: '\u2211',
  prod: '\u220F',
  int: '\u222B',
  alpha: '\u03B1',
  beta: '\u03B2',
  gamma: '\u03B3',
  delta: '\u03B4',
  pi: '\u03C0',
  sigma: '\u03C3',
  omega: '\u03C9',
  // 箭头 / 图形
  larr: '\u2190',
  uarr: '\u2191',
  rarr: '\u2192',
  darr: '\u2193',
  harr: '\u2194',
  varr: '\u2195',
  crarr: '\u21B5',
  check: '\u2713',
  cross: '\u2717',
  spades: '\u2660',
  clubs: '\u2663',
  hearts: '\u2665',
  diams: '\u2666',
}

/** 匹配一个完整 HTML 实体（命名带可选分号，或数字；十六进制前缀的 X 大小写均可）。 */
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g

/**
 * 只裁剪「布局空白」（ASCII 空格/Tab/CR/LF/换页），保留 U+00A0 等不换行空格。
 *
 * JS 原生 String.trim() 把 U+00A0、U+2000 系列等 Unicode 空格也算空白，
 * 于是 `&nbsp;` 解码出的不换行空格会在 codegen 的 trim 阶段被误删
 * （Slider.ts 已记录过这个坑：`.&nbsp;` → trim 后只剩 `.`）。
 * 但对模板文本来说 U+00A0 是**内容字符**，必须保留。
 */
export function trimLayout(s: string): string {
  return s.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
}

/**
 * HTML 规范对数字实体 C1 区（0x80–0x9F）的 windows-1252 替换表。
 * 未列出的码位（0x81/0x8D/0x8F/0x90/0x9D）按规范保留原码位。
 */
const C1_MAP: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
}

/**
 * 解码字符串里的 HTML 实体。
 * - 命名实体：小写整词命中 NAMED 表则替换（分号可选）；未命中则原样保留。
 *   `inAttr` 时对齐浏览器属性值规则：无分号且后随 `=` 的命名实体不解码
 *   （`href="?a=1&copy=2"` 里的 `&copy=` 保持字面）。
 * - 数字实体：解析为码点；C1 区按 HTML 规范映射 windows-1252（如 &#151; → —）。
 *   0、代理区、越界（>0x10FFFF）保守保留字面（浏览器会替换为 U+FFFD，
 *   此处选择不误伤源码，属文档化的保守偏差）。
 */
export function decodeEntities(s: string, inAttr = false): string {
  if (!s || s.indexOf('&') < 0) return s
  ENTITY_RE.lastIndex = 0
  return s.replace(ENTITY_RE, (whole: string, body: string, offset: number, str: string) => {
    if (body[0] === '#') {
      let cp: number
      if (body[1] === 'x' || body[1] === 'X') {
        cp = parseInt(body.slice(2), 16)
      } else {
        cp = parseInt(body.slice(1), 10)
      }
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF) return whole
      // 代理区不能单独成字符
      if (cp >= 0xD800 && cp <= 0xDFFF) return whole
      if (cp === 0) return whole
      if (cp >= 0x80 && cp <= 0x9f) cp = C1_MAP[cp] ?? cp
      try {
        return String.fromCodePoint(cp)
      } catch {
        return whole
      }
    }
    if (inAttr && !whole.endsWith(';') && str[offset + whole.length] === '=') return whole
    const val = NAMED[body]
    return val === undefined ? whole : val
  })
}
