// FlashMark: a dependency-free, fast renderer whose parse(markdown) returns
// exactly the HTML marked 18.1.3 renders with its defaults (gfm on, breaks
// off). Written from the CommonMark 0.31.2 / GFM 0.29 rules plus marked's
// observed behaviour on the spec examples. No third-party code.

export function parse(markdown) {
  return renderDoc(markdown);
}

// ---------------------------------------------------------------------------
// Small character helpers
// ---------------------------------------------------------------------------

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\u1680' || ch === '\u2000' || ch === '\u2001' || ch === '\u2002' || ch === '\u2003' || ch === '\u2004' || ch === '\u2005' || ch === '\u2006' || ch === '\u2007' || ch === '\u2008' || ch === '\u2009' || ch === '\u200a' || ch === '\u2028' || ch === '\u2029' || ch === '\u202f' || ch === '\u205f' || ch === '\u3000';
}

function isPunct(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return ASCII_PUNCT.has(ch);
  return /[\p{P}\p{S}]/u.test(ch);
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAlphaNum(ch) {
  if (ch === '') return false;
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isWordChar(ch) {
  return isAlphaNum(ch) || ch === '_';
}

// Escape text and attribute values: marked escapes &, <, >, " and '.
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's cleanUrl: encodeURI, keeping % literal, null on lone surrogates.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entities (named references marked decodes; Tab/NewLine are left literal)
// ---------------------------------------------------------------------------

const ENTITIES = {
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'",
  nbsp: '\u00a0', copy: '\u00a9', COPY: '\u00a9', reg: '\u00ae', REG: '\u00ae', trade: '\u2122', TRADE: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb', times: '\u00d7',
  divide: '\u00f7', plusmn: '\u00b1', deg: '\u00b0', micro: '\u00b5', para: '\u00b6',
  sect: '\u00a7', middot: '\u00b7', bull: '\u2022', dagger: '\u2020', Dagger: '\u2021',
  permil: '\u2030', prime: '\u2032', Prime: '\u2033', oline: '\u203e', frasl: '\u2044',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', curren: '\u00a4',
  brvbar: '\u00a6', uml: '\u00a8', ordf: '\u00aa', ordm: '\u00ba', iexcl: '\u00a1',
  iquest: '\u00bf', szlig: '\u00df', agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2',
  atilde: '\u00e3', auml: '\u00e4', aring: '\u00e5', aelig: '\u00e6', ccedil: '\u00e7',
  egrave: '\u00e8', eacute: '\u00e9', ecirc: '\u00ea', euml: '\u00eb', igrave: '\u00ec',
  iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef', eth: '\u00f0', ntilde: '\u00f1',
  ograve: '\u00f2', oacute: '\u00f3', ocirc: '\u00f4', otilde: '\u00f5', ouml: '\u00f6',
  oslash: '\u00f8', ugrave: '\u00f9', uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc',
  yacute: '\u00fd', yuml: '\u00ff', thorn: '\u00fe', AElig: '\u00c6', Aacute: '\u00c1',
  Acirc: '\u00c2', Atilde: '\u00c3', Auml: '\u00c4', Aring: '\u00c5', Ccedil: '\u00c7',
  Egrave: '\u00c8', Eacute: '\u00c9', Ecirc: '\u00ca', Euml: '\u00cb', Igrave: '\u00cc',
  Iacute: '\u00cd', Icirc: '\u00ce', Iuml: '\u00cf', Eth: '\u00d0', Ntilde: '\u00d1',
  Ograve: '\u00d2', Oacute: '\u00d3', Ocirc: '\u00d4', Otilde: '\u00d5', Ouml: '\u00d6',
  Oslash: '\u00d8', Ugrave: '\u00d9', Uacute: '\u00da', Ucirc: '\u00db', Uuml: '\u00dc',
  Yacute: '\u00dd', Thorn: '\u00de', Dcaron: '\u010e', dcaron: '\u010f', frac14: '\u00bc',
  frac12: '\u00bd', frac34: '\u00be', sup1: '\u00b9', sup2: '\u00b2', sup3: '\u00b3',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', epsilon: '\u03b5',
  zeta: '\u03b6', eta: '\u03b7', theta: '\u03b8', iota: '\u03b9', kappa: '\u03ba',
  lambda: '\u03bb', mu: '\u03bc', nu: '\u03bd', xi: '\u03be', omicron: '\u03bf',
  pi: '\u03c0', rho: '\u03c1', sigma: '\u03c3', tau: '\u03c4', upsilon: '\u03c5',
  phi: '\u03c6', chi: '\u03c7', psi: '\u03c8', omega: '\u03c9', Alpha: '\u0391',
  Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395', Zeta: '\u0396',
  Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039a', Lambda: '\u039b',
  Mu: '\u039c', Nu: '\u039d', Xi: '\u039e', Omicron: '\u039f', Pi: '\u03a0', Rho: '\u03a1',
  Sigma: '\u03a3', Tau: '\u03a4', Upsilon: '\u03a5', Phi: '\u03a6', Chi: '\u03a7',
  Psi: '\u03a8', Omega: '\u03a9', infin: '\u221e', ne: '\u2260', le: '\u2264', ge: '\u2265',
  minus: '\u2212', lowast: '\u2217', radic: '\u221a', prop: '\u221d', empty: '\u2205',
  isin: '\u2208', notin: '\u2209', ni: '\u220b', prod: '\u220f', sum: '\u2211',
  part: '\u2202', int: '\u222b', there4: '\u2234', sim: '\u223c', cong: '\u2245',
  asymp: '\u2248', equiv: '\u2261', sub: '\u2282', sup: '\u2283', nsub: '\u2284',
  sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22a5',
  sdot: '\u22c5', lceil: '\u2308', rceil: '\u2309', lfloor: '\u230a', rfloor: '\u230b',
  lang: '\u2329', rang: '\u232a', loz: '\u25ca', spades: '\u2660', clubs: '\u2663',
  hearts: '\u2665', diams: '\u2666', HilbertSpace: '\u210b', DifferentialD: '\u2146',
  ClockwiseContourIntegral: '\u2232', ngE: '\u2267\u0338', ensp: '\u2002', emsp: '\u2003',
  thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  sbquo: '\u201a', bdquo: '\u201e', circ: '\u02c6', tilde: '\u02dc', shy: '\u00ad',
  ecirc2: '', fnof: '\u0192', yuml2: '', weierp: '\u2118', image: '\u2111', real: '\u211c',
  alefsym: '\u2135', larr: '\u2190', uarr: '\u2191', rarr: '\u2192', darr: '\u2193',
  harr: '\u2194', crarr: '\u21b5', lArr: '\u21d0', uArr: '\u21d1', rArr: '\u21d2',
  dArr: '\u21d3', hArr: '\u21d4', forall: '\u2200', exist: '\u2203', nabla: '\u2207',
  and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a', lceil2: '',
};

// Length of a valid entity reference starting at s[i] === '&' (0 when
// there is none). Named references are any &name; with a letter first;
// numeric references are &#DDDDDDD; (at most 7 digits) or &#[xX]HHHHHH;
// (at most 6). marked preserves named references literally and decodes
// only numeric ones.
function entityRefLen(s, i) {
  const n = s.length;
  if (s[i] !== '&') return 0;
  let j = i + 1;
  if (j < n && s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    const max = hex ? 6 : 7;
    while (j < n && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
    if (j === start || j - start > max || j >= n || s[j] !== ';') return 0;
    return j + 1 - i;
  }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return 0;
  j++;
  while (j < n && /[A-Za-z0-9]/.test(s[j])) j++;
  if (j >= n || s[j] !== ';') return 0;
  return j + 1 - i;
}

// Decode a numeric entity reference at s[i] === '&'. Returns [char, next]
// or null when there is no valid numeric reference. Out-of-range values
// (0, surrogates, above U+10FFFF) become U+FFFD.
function decodeNumericEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n || s[i + 1] !== '#') return null;
  let j = i + 2;
  let hex = false;
  if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
  const start = j;
  const max = hex ? 6 : 7;
  while (j < n && (hex ? /[0-9a-fA-F]/.test(s[j]) : isDigit(s[j]))) j++;
  if (j === start || j - start > max || j >= n || s[j] !== ';') return null;
  const num = parseInt(s.slice(start, j), hex ? 16 : 10);
  if (num === 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) return ['\ufffd', j + 1];
  return [String.fromCodePoint(num), j + 1];
}

// Escape an attribute value (link href/title, image alt, code info string):
// escape & < > " ' except that valid entity references are left as-is.
function escAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const len = entityRefLen(s, i);
      if (len > 0) { i += len - 1; continue; }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Backslash escapes: \X -> X for ASCII punctuation, else literal backslash.
function unescapeStr(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && ASCII_PUNCT.has(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing. Nodes: text, code, html, br, em, strong, del, link, img,
// delim (unresolved * _ ~ runs, resolved later by processEmphasis).
// ---------------------------------------------------------------------------

const DISALLOWED = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Match an inline HTML construct at s[i] === '<'. Returns [raw, nextIndex] or null.
// Forms: <!--...-->, <?...?>, <!A...>, <![CDATA[...]]>, <tag ...>, </tag>.
function matchInlineHtml(s, i) {
  const n = s.length;
  if (s[i + 1] === '!') {
    if (s.startsWith('<!--', i)) {
      // <!--> and <!---> close immediately
      if (s[i + 4] === '>') return [s.slice(i, i + 5), i + 5];
      if (s.startsWith('->', i + 4)) return [s.slice(i, i + 6), i + 6];
      const end = s.indexOf('-->', i + 4);
      if (end === -1) return null;
      return [s.slice(i, end + 3), end + 3];
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return null;
      return [s.slice(i, end + 3), end + 3];
    }
    // <!A ...> declaration: letter after !
    if (i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
      const end = s.indexOf('>', i + 2);
      if (end === -1) return null;
      return [s.slice(i, end + 1), end + 1];
    }
    return null;
  }
  if (s[i + 1] === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return null;
    return [s.slice(i, end + 2), end + 2];
  }
  let j = i + 1;
  let closing = false;
  if (s[j] === '/') { closing = true; j++; }
  if (j >= n || !/[A-Za-z]/.test(s[j])) return null;
  const nameStart = j;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  const tagName = s.slice(nameStart, j).toLowerCase();
  // a closing tag takes no attributes: only whitespace then '>'
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
    if (j < n && s[j] === '>') return [s.slice(i, j + 1), j + 1];
    return null;
  }
  // attributes until '>' or '/>': each attribute must be preceded by
  // whitespace, and its name starts with a letter, '_' or ':'.
  while (j < n) {
    const c = s[j];
    if (c === '>') return [s.slice(i, j + 1), j + 1];
    if (c === '/') {
      if (j + 1 < n && s[j + 1] === '>') return [s.slice(i, j + 2), j + 2];
      return null;
    }
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r' && c !== '\f') return null;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
    if (j >= n) return null;
    if (s[j] === '>' || s[j] === '/') continue;
    if (!/[A-Za-z_:]/.test(s[j])) return null;
    j++;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // optional =value
    let k = j;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (k < n && s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
      if (k < n && (s[k] === '"' || s[k] === "'")) {
        const q = s[k];
        k++;
        while (k < n && s[k] !== q) k++;
        if (k >= n) return null;
        j = k + 1;
      } else {
        // unquoted value
        const vs = k;
        while (k < n && !/[\s>]/.test(s[k])) {
          const vc = s[k];
          if (vc === '"' || vc === "'" || vc === '=' || vc === '<' || vc === '`') return null;
          k++;
        }
        if (k === vs) return null;
        j = k;
      }
    }
    // no value: leave j at the end of the attribute name; the loop top
    // skips the whitespace before the next attribute
  }
  return null;
}

// If s[i] === '<' starts an inline HTML tag or an autolink <...>, return
// the index just past it; otherwise -1. Used to skip such constructs when
// scanning for a link text's closing bracket (a ']' inside one does not
// close the link text).
function matchAngle(s, i) {
  const h = matchInlineHtml(s, i);
  if (h) return h[1];
  const n = s.length;
  const gt = s.indexOf('>', i + 1);
  if (gt === -1) return -1;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0 || inner.includes(' ') || inner.includes('\n') || inner.includes('<')) return -1;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner)) return gt + 1;
  if (matchEmailAt(inner, 0) === inner.length) return gt + 1;
  return -1;
}

// A link label must not contain an unescaped '[' (outside code spans).
function isValidLabel(label) {
  let i = 0;
  while (i < label.length) {
    const c = label[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (k < label.length && label[k] === '`') k++;
      const len = k - i;
      let j = k;
      let closed = false;
      while (j < label.length) {
        if (label[j] === '`') {
          let m = j;
          while (m < label.length && label[m] === '`') m++;
          if (m - j === len) { closed = true; j = m; break; }
          j = m;
        } else j++;
      }
      if (!closed) return true;
      i = j;
      continue;
    }
    if (c === '[') return false;
    i++;
  }
  return true;
}

// Recursively check whether any node (at any depth) is an explicit link
// (autolinks do not count: they may appear inside link text).
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link' && !nd.auto) return true;
    if (nd.c && containsLink(nd.c)) return true;
  }
  return false;
}

// Find the index of the ']' matching the '[' at start (depth-aware, escapes
// and code spans respected). Returns -1 when there is none.
function findClosingBracket(s, start) {
  const n = s.length;
  let depth = 0;
  let i = start;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let k = i;
      while (k < n && s[k] === '`') k++;
      const len = k - i;
      // find a matching run of the same length; an unterminated code
      // span is literal text and does not block the bracket scan
      let j = k;
      let closed = false;
      while (j < n) {
        if (s[j] === '`') {
          let m = j;
          while (m < n && s[m] === '`') m++;
          if (m - j === len) { closed = true; j = m; break; }
          j = m;
        } else if (s[j] === '\\') { j += 2; }
        else j++;
      }
      i = closed ? j : k;
      continue;
    }
    if (c === '<') {
      const ae = matchAngle(s, i);
      if (ae !== -1) { i = ae; continue; }
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function normalizeLabel(label) {
  // Unicode case folding: ß/ẞ fold to "ss", final sigma ς folds to σ.
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Parse a link destination + optional title starting at s[i] (where s[i]
// is '(' for an inline link, or at the destination for a definition).
// Returns {href, title, next} or null. `i` is the index just after '(' (or
// the destination start for defs, where afterParen is false and the caller
// handles line ends via the same string with \n in it).
function parseLinkTarget(s, i, refs) {
  const n = s.length;
  // skip whitespace (spaces, tabs, newlines)
  while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  if (i >= n) return null;
  let href = '';
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n && s[j] !== '>') {
      if (s[j] === '\n' || s[j] === '<') return null;
      // a backslash-escaped '>' does not close the destination
      if (s[j] === '\\' && j + 1 < n && ASCII_PUNCT.has(s[j + 1])) { j += 2; continue; }
      j++;
    }
    if (j >= n) return null;
    href = s.slice(i + 1, j);
    i = j + 1;
  } else {
    // bare destination: no spaces/control, balanced parens
    let j = i;
    let depth = 0;
    while (j < n) {
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '\\' && j + 1 < n && ASCII_PUNCT.has(s[j + 1])) { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (depth !== 0) return null;
    href = s.slice(i, j);
    i = j;
  }
  href = unescapeStr(href);
  // optional title
  let save = i;
  while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  let title = null;
  if (i < n && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const q = s[i];
    const close = q === '(' ? ')' : q;
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const c = s[j];
      if (c === '\n') break;
      if (c === '\\' && j + 1 < n) { j += 2; continue; }
      if (c === close) { ok = true; break; }
      j++;
    }
    if (!ok) return null;
    title = unescapeStr(s.slice(i + 1, j));
    i = j + 1;
    save = i;
    while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  } else {
    i = save;
  }
  return { href, title, next: i };
}

// GFM extended autolink: at position i in s, try to match a www./scheme/
// email link. `prev` is the character before i ('' at start). Returns
// {href, text, next} or null. Only called when not inside a link.
const WWW_DOMAIN_RE = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/y;
const SCHEME_RE = /(https?|ftp):\/\//iy;
const MAILTO_RE = /mailto:/iy;

function matchExtAutolink(s, i, prev) {
  const n = s.length;
  // www. links
  if (s.startsWith('www.', i)) {
    if (prev !== '' && (isWordChar(prev) || prev === '/')) return null;
    WWW_DOMAIN_RE.lastIndex = i + 4;
    const m = WWW_DOMAIN_RE.exec(s);
    if (!m || m[0].length === 0) return null;
    let end = i + 4 + m[0].length;
    // path/query/fragment: any chars except whitespace and '<'
    while (end < n && s[end] !== ' ' && s[end] !== '\t' && s[end] !== '\n' && s[end] !== '<' && s[end].charCodeAt(0) > 32) end++;
    const raw = s.slice(i, end);
    const trimmed = trimAutolink(raw);
    if (trimmed.length === 0) return null;
    return { href: 'http://' + trimmed, text: trimmed, next: i + trimmed.length };
  }
  // scheme links: http://, https://, ftp:// (any case), mailto:
  SCHEME_RE.lastIndex = i;
  const sm = SCHEME_RE.exec(s);
  if (sm) {
    let end = i + sm[0].length;
    while (end < n && s[end] !== ' ' && s[end] !== '\t' && s[end] !== '\n' && s[end] !== '<' && s[end].charCodeAt(0) > 32) end++;
    const raw = s.slice(i, end);
    const trimmed = trimAutolink(raw);
    if (trimmed.length === 0) return null;
    return { href: trimmed, text: trimmed, next: i + trimmed.length };
  }
  MAILTO_RE.lastIndex = i;
  if (MAILTO_RE.exec(s)) {
    const em = matchEmailAt(s, i + 7);
    if (!em) return null;
    const raw = s.slice(i, i + 7 + em);
    return { href: raw, text: raw, next: i + raw.length };
  }
  // xmpp: links are an email address with an optional single-segment
  // resource (a bare word, or a word@domain)
  if (s.slice(i, i + 5).toLowerCase() === 'xmpp:') {
    if (prev !== '' && (isWordChar(prev) || prev === '/')) return null;
    const em = matchEmailAt(s, i + 5);
    if (!em) return null;
    let end = i + 5 + em;
    if (end < n && s[end] === '/') {
      let r = end + 1;
      const rstart = r;
      while (r < n && isAlphaNum(s[r])) r++;
      if (r > rstart) {
        end = r;
        if (end < n && s[end] === '@') {
          let d = end + 1;
          const dstart = d;
          while (d < n && (isAlphaNum(s[d]) || s[d] === '.' || s[d] === '-')) d++;
          // strip trailing dots from the resource domain
          while (d > dstart && s[d - 1] === '.') d--;
          if (d > dstart) end = d;
        }
      }
    }
    const raw = s.slice(i, end);
    return { href: raw, text: raw, next: end };
  }
  return null;
}

// Match an email address starting at s[i]. Returns its length or 0.
// Trailing dots are not part of the address; a trailing hyphen or an
// underscore right after it invalidates the match.
// Is there an underscore delimiter that can open among the nodes built
// so far? Used to decide whether a `_` after an email is a closing
// emphasis delimiter (the email still autolinks) or a literal trailing
// underscore (it does not).
function hasOpenUnderscore(nodes) {
  for (const nd of nodes) if (nd.t === 'delim' && nd.ch === '_' && nd.canOpen) return true;
  return false;
}

function matchEmailAt(s, i, allowTrailingUnderscore) {
  const n = s.length;
  let j = i;
  while (j < n && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/.test(s[j])) j++;
  const local = s.slice(i, j);
  if (local.length === 0 || j >= n || s[j] !== '@') return 0;
  j++;
  const dstart = j;
  // domain: labels separated by dots, at least one dot
  let dots = 0;
  let lastDot = -1;
  while (j < n) {
    const c = s[j];
    if (isAlphaNum(c) || c === '-') { j++; continue; }
    if (c === '.') { dots++; lastDot = j; j++; continue; }
    break;
  }
  if (dots === 0) return 0;
  // strip trailing dots: they are not part of the address
  let dend = j;
  while (dend > dstart && s[dend - 1] === '.') dend--;
  if (dend === dstart) return 0;
  const domain = s.slice(dstart, dend);
  if (domain.startsWith('.') || domain.endsWith('.') || domain.startsWith('-') || domain.endsWith('-')) return 0;
  if (domain.includes('..') || domain.includes('-.') || domain.includes('.-')) return 0;
  // an underscore right after the address means it is part of a longer
  // word, not a standalone email -- unless the underscore is a closing
  // emphasis delimiter (an opener is already open), in which case the
  // email still autolinks
  if (dend < n && s[dend] === '_' && !allowTrailingUnderscore) return 0;
  return dend - i;
}

// Trim trailing punctuation from a GFM autolink candidate per the spec:
// trailing ? ! . , : ; * _ ~ are dropped; a trailing ')' is dropped while
// the parens are unbalanced; a trailing ';' that closes a named entity
// reference drops the whole &name;, one closing a numeric reference
// drops only the ';'.
function trimAutolink(raw) {
  let s = raw;
  for (;;) {
    if (s.length === 0) return s;
    const last = s[s.length - 1];
    if (last === ')') {
      let open = 0, close = 0;
      for (let k = 0; k < s.length; k++) {
        if (s[k] === '(') open++;
        else if (s[k] === ')') close++;
      }
      if (close > open) { s = s.slice(0, -1); continue; }
      return s;
    }
    if (last === '?' || last === '!' || last === '.' || last === ',' || last === ':' || last === '*' || last === '_' || last === '~') {
      s = s.slice(0, -1);
      continue;
    }
    if (last === ';') {
      const amp = s.lastIndexOf('&');
      if (amp !== -1) {
        const inner = s.slice(amp + 1, s.length - 1);
        if (/^#[0-9]+$/.test(inner) || /^#[xX][0-9a-fA-F]+$/.test(inner)) {
          // numeric reference: drop only the ';'
          s = s.slice(0, -1);
          continue;
        }
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(inner)) {
          // named reference: drop the whole &name;
          s = s.slice(0, amp);
          continue;
        }
      }
      s = s.slice(0, -1);
      continue;
    }
    return s;
  }
}

// Characters allowed in the local part of an email address.
const LOCAL_RE = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;

// Is src[i] a character inside the local part of an email address (so it
// must stay plain text even when it would otherwise start a code span,
// emphasis or an image)? `lastBreak` is the index just after the last
// non-text node emitted, which the local part may not cross.
function partOfEmail(src, i, lastBreak) {
  if (i === 0 || i <= lastBreak) return false;
  if (!LOCAL_RE.test(src[i - 1])) return false;
  let j = i;
  while (j < src.length && LOCAL_RE.test(src[j])) j++;
  if (j >= src.length || src[j] !== '@') return false;
  let ls = i - 1;
  while (ls > lastBreak && LOCAL_RE.test(src[ls - 1])) ls--;
  return matchEmailAt(src, ls) > 0;
}

// The main inline parser. `refs` is the document's link-reference map.
// Returns an array of nodes.
function parseInline(src, refs, inLink) {
  const n = src.length;
  const nodes = [];
  let text = '';
  let lastBreak = 0;
  const flush = () => {
    if (text.length > 0) { nodes.push({ t: 'text', s: text }); text = ''; }
  };
  let i = 0;
  while (i < n) {
    const ch = src[i];
    // newline: soft or hard break
    if (ch === '\n') {
      let k = text.length;
      let spaces = 0;
      while (k > 0 && text[k - 1] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        text = text.slice(0, text.length - spaces);
        flush();
        nodes.push({ t: 'br' });
      } else {
        flush();
        nodes.push({ t: 'text', s: '\n' });
      }
      lastBreak = i + 1;
      i++;
      // a hard break swallows the next line's leading whitespace
      if (nodes.length > 0 && nodes[nodes.length - 1].t === 'br') {
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        lastBreak = i;
      }
      continue;
    }
    // backslash escape / hard break
    if (ch === '\\') {
      if (i + 1 < n && src[i + 1] === '\n') {
        flush();
        nodes.push({ t: 'br' });
        i += 2;
        lastBreak = i;
        // a hard break swallows the next line's leading whitespace
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        lastBreak = i;
        continue;
      }
      if (i + 1 < n && ASCII_PUNCT.has(src[i + 1])) {
        text += src[i + 1];
        i += 2;
        continue;
      }
      text += '\\';
      i++;
      continue;
    }
    // code span
    if (ch === '`') {
      if (!inLink && partOfEmail(src, i, lastBreak)) { text += '`'; i++; continue; }
      let k = i;
      while (k < n && src[k] === '`') k++;
      const len = k - i;
      let j = k;
      let close = -1;
      while (j < n) {
        if (src[j] === '`') {
          let m = j;
          while (m < n && src[m] === '`') m++;
          if (m - j === len) { close = j; break; }
          j = m;
        } else j++;
      }
      if (close !== -1) {
        const content = src.slice(k, close);
        if (!content.includes('\n\n')) {
          flush();
          let c = content.replace(/\n/g, ' ');
          if (c.length >= 2 && c[0] === ' ' && c[c.length - 1] === ' ' && /[^ ]/.test(c)) c = c.slice(1, -1);
          nodes.push({ t: 'code', s: c });
          i = close + len;
          lastBreak = i;
          continue;
        }
      }
      // no matching closing run (or a blank line inside): the whole
      // opening run is literal text, so a shorter run inside it cannot
      // start a code span either
      text += src.slice(i, k);
      i = k;
      continue;
    }
    // entity reference: numeric references decode, named references are
    // emitted literally, anything else is a plain '&'.
    if (ch === '&') {
      const d = decodeNumericEntity(src, i);
      if (d) { text += d[0]; i = d[1]; continue; }
      const len = entityRefLen(src, i);
      if (len > 0) {
        flush();
        nodes.push({ t: 'html', s: src.slice(i, i + len) });
        i += len;
        lastBreak = i;
        continue;
      }
      text += '&';
      i++;
      continue;
    }
    // raw HTML or autolink <...>
    if (ch === '<') {
      const h = matchInlineHtml(src, i);
      if (h) {
        flush();
        nodes.push({ t: 'html', s: h[0] });
        // an unclosed inline <a> disables GFM extended autolinks for
        // the rest of the document; </a> re-enables them (even a
        // self-closing <a /> counts as opening one)
        if (/^<a(?:[\s/>]|$)/i.test(h[0])) refs.anchor = true;
        else if (/^<\/a(?:[\s/>]|$)/i.test(h[0])) refs.anchor = false;
        i = h[1];
        lastBreak = i;
        continue;
      }
      // autolink <scheme:...> or <email>
      const gt = src.indexOf('>', i + 1);
      if (gt !== -1) {
        const inner = src.slice(i + 1, gt);
        if (!inner.includes(' ') && !inner.includes('\n') && !inner.includes('<')) {
          const sm = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.exec(inner);
          if (sm) {
            flush();
            const href = cleanUrl(inner);
            nodes.push({ t: 'link', auto: true, href: href === null ? inner : href, title: null, c: [{ t: 'text', s: inner }] });
            i = gt + 1;
            lastBreak = i;
            continue;
          }
          if (inner.length > 0 && matchEmailAt(inner, 0) === inner.length) {
            flush();
            nodes.push({ t: 'link', auto: true, href: 'mailto:' + inner, title: null, c: [{ t: 'text', s: inner }] });
            i = gt + 1;
            lastBreak = i;
            continue;
          }
        }
      }
      text += '<';
      i++;
      continue;
    }
    // link or image
    if (ch === '[' || (ch === '!' && i + 1 < n && src[i + 1] === '[')) {
      if (ch === '!' && !inLink && partOfEmail(src, i, lastBreak)) { text += '!'; i++; continue; }
      const isImg = ch === '!';
      const start = isImg ? i + 1 : i;
      const close = findClosingBracket(src, start);
      if (close !== -1) {
        const linkText = src.slice(start + 1, close);
        const parsed = tryLink(src, close + 1, linkText, refs, isImg, inLink);
        if (parsed) {
          flush();
          nodes.push(parsed.node);
          i = parsed.next;
          lastBreak = i;
          continue;
        }
      }
      text += ch;
      i++;
      continue;
    }
    // emphasis / strikethrough delimiter runs
    if (ch === '*' || ch === '_' || ch === '~') {
      if (!inLink && partOfEmail(src, i, lastBreak)) { text += ch; i++; continue; }
      let k = i;
      while (k < n && src[k] === ch) k++;
      const len = k - i;
      if (ch === '~' && len >= 3) {
        text += src.slice(i, k);
        i = k;
        continue;
      }
      const before = i > 0 ? src[i - 1] : ' ';
      const after = k < n ? src[k] : ' ';
      const leftFlank = !isWs(after) && (!isPunct(after) || (isPunct(after) && (isWs(before) || isPunct(before))));
      const rightFlank = !isWs(before) && (!isPunct(before) || (isPunct(before) && (isWs(after) || isPunct(after))));
      let canOpen, canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isPunct(before));
        canClose = rightFlank && (!leftFlank || isPunct(after));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      nodes.push({ t: 'delim', ch, n: len, canOpen, canClose });
      i = k;
      lastBreak = i;
      continue;
    }
    // plain text run, watching for GFM extended autolinks
    let j = i;
    let emailAt = -1;
    while (j < n) {
      const c = src[j];
      if (c === '\n' || c === '\\' || c === '`' || c === '&' || c === '<' || c === '[' || c === '!' || c === '*' || c === '_' || c === '~') break;
      if (!inLink && !refs.anchor) {
        if (c === 'w' && src.startsWith('www.', j)) {
          const prev = j > 0 ? src[j - 1] : (text.length > 0 ? text[text.length - 1] : '');
          if (matchExtAutolink(src, j, prev)) break;
        } else if (c === '@') {
          // the email's local part may start before this run (in `text`)
          let ls = j - 1;
          while (ls >= lastBreak && LOCAL_RE.test(src[ls])) ls--;
          ls++;
          // a local part whose first character is backslash-escaped is
          // not the start of an email (it continues the preceding word)
          if (ls < j && !(ls > 0 && src[ls - 1] === '\\') && matchEmailAt(src, ls, hasOpenUnderscore(nodes)) > 0) { emailAt = ls; j = ls; break; }
        } else if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'M' || c === 'x' || c === 'X') {
          if (matchExtAutolink(src, j, j > 0 ? src[j - 1] : '')) break;
        }
      }
      j++;
    }
    if (emailAt >= 0) {
      // the email's local part is partly in `text`; cut those chars out
      const emLen = matchEmailAt(src, emailAt, hasOpenUnderscore(nodes));
      const email = src.slice(emailAt, emailAt + emLen);
      if (emailAt > i) text += src.slice(i, emailAt);
      const cut = i - emailAt;
      if (cut > 0) text = text.slice(0, text.length - cut);
      flush();
      nodes.push({ t: 'link', href: 'mailto:' + email, title: null, c: [{ t: 'text', s: email }] });
      i = emailAt + emLen;
      lastBreak = i;
      continue;
    }
    if (j > i) { text += src.slice(i, j); i = j; continue; }
    // an autolink starts exactly here
    if (!inLink && !refs.anchor) {
      const a = matchExtAutolink(src, i, i > 0 ? src[i - 1] : (text.length > 0 ? text[text.length - 1] : ''));
      if (a) {
        flush();
        const href = cleanUrl(a.href);
        nodes.push({ t: 'link', href: href === null ? a.href : href, title: null, c: [{ t: 'text', s: a.text }] });
        i = a.next;
        lastBreak = i;
        continue;
      }
      const emLen = matchEmailAt(src, i, hasOpenUnderscore(nodes));
      if (emLen > 0 && !(i > 0 && src[i - 1] === '\\')) {
        flush();
        const email = src.slice(i, i + emLen);
        nodes.push({ t: 'link', href: 'mailto:' + email, title: null, c: [{ t: 'text', s: email }] });
        i += emLen;
        lastBreak = i;
        continue;
      }
    }
    text += src[i];
    i++;
  }
  flush();
  processEmphasis(nodes);
  return nodes;
}

// Try to form a link/image whose text ends at `close` (index of ']').
// `after` is the index just past ']'. Returns {node, next} or null.
function tryLink(s, after, linkText, refs, isImg, inLink) {
  const n = s.length;
  let href = null;
  let title = null;
  let next = -1;
  if (after < n && s[after] === '(') {
    const t = parseLinkTarget(s, after + 1);
    if (t && t.next < n && s[t.next] === ')') {
      href = t.href;
      title = t.title;
      next = t.next + 1;
    }
    // an inline link that fails to parse falls back to a shortcut
    // reference link, if one exists
    if (href === null) {
      if (!isValidLabel(linkText)) return null;
      const def = refs.get(normalizeLabel(linkText));
      if (!def) return null;
      href = def.href;
      title = def.title;
      next = after;
    }
  } else if (after < n && s[after] === '[') {
    const lc = findClosingBracket(s, after);
    if (lc === -1) return null;
    const label = lc === after + 1 ? linkText : s.slice(after + 1, lc);
    if (!isValidLabel(label)) return null;
    const def = refs.get(normalizeLabel(label));
    if (!def) return null;
    href = def.href;
    title = def.title;
    next = lc + 1;
  } else {
    // shortcut reference
    if (!isValidLabel(linkText)) return null;
    const def = refs.get(normalizeLabel(linkText));
    if (!def) return null;
    href = def.href;
    title = def.title;
    next = after;
  }
  if (isImg) {
    const altNodes = parseInline(linkText, refs, false);
    return { node: { t: 'img', href, title, alt: renderPlain(altNodes) }, next };
  }
  const children = parseInline(linkText, refs, true);
  // a link may not contain another link, at any depth
  if (containsLink(children)) return null;
  return { node: { t: 'link', href, title, c: children }, next };
}

// Recursively turn any leftover delimiter node into literal text.
function flattenDelims(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'delim') {
      nd.t = 'text';
      nd.s = nd.ch.repeat(nd.n);
      delete nd.ch; delete nd.n; delete nd.canOpen; delete nd.canClose; delete nd.idx;
    } else if (nd.c) {
      flattenDelims(nd.c);
    }
  }
}

function processEmphasis(nodes) {
  // Collect delimiter nodes in order.
  const delims = [];
  const collect = () => {
    delims.length = 0;
    for (let idx = 0; idx < nodes.length; idx++) {
      const nd = nodes[idx];
      if (nd.t === 'delim') { nd.idx = idx; delims.push(nd); }
    }
  };
  collect();
  if (delims.length === 0) return;
  // bottom[ch] is the index of the last delimiter that failed as a closer
  // and cannot open either, so it can never serve as an opener again.
  const bottom = { '*': -1, '_': -1, '~': -1 };
  // When an emphasis is closed by a delimiter that can itself open, the
  // next closer must not pair with the opener enclosing that emphasis
  // (it stays literal); the closer after that may pair with it again.
  let blockedOpener = null;
  let di = 0;
  while (di < delims.length) {
    const closer = delims[di];
    if (!closer.canClose) { di++; continue; }
    const ch = closer.ch;
    let oi = di - 1;
    let found = null;
    let sawBlocked = false;
    const low = bottom[ch] + 1;
    while (oi >= low) {
      const opener = delims[oi];
      if (opener.ch === ch && opener.canOpen) {
        if (opener === blockedOpener) { sawBlocked = true; oi--; continue; }
        const bothWays = (opener.canOpen && opener.canClose) || (closer.canOpen && closer.canClose);
        const sum = opener.n + closer.n;
        const odd = bothWays && sum % 3 === 0 && !(opener.n % 3 === 0 && closer.n % 3 === 0);
        if (!odd) { found = opener; break; }
      }
      oi--;
    }
    blockedOpener = null;
    if (!found) {
      // A closer that can still open stays available as an opener for a
      // later closer; only a closer that cannot open is dead. A failure
      // caused only by the one-shot block does not kill the opener.
      if (!closer.canOpen && !sawBlocked) bottom[ch] = di;
      di++;
      continue;
    }
    const use = found.n >= 2 && closer.n >= 2 ? 2 : 1;
    const tag = ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    // wrap nodes between found.idx and closer.idx
    const children = nodes.slice(found.idx + 1, closer.idx);
    const wrapper = { t: tag, c: children };
    const newNodes = nodes.slice(0, found.idx);
    // the closer that can itself open blocks the enclosing opener for
    // the next closer only, and only when the opener it paired with
    // could not itself close; the block applies only when the inner
    // opener's run differs in length from the enclosing opener's run
    // (an equal-length pair still closes the outer emphasis)
    let blockTarget = null;
    if (closer.canOpen && !found.canClose) {
      const fi = delims.indexOf(found);
      for (let k = fi - 1; k >= 0; k--) {
        if (delims[k].ch === ch && delims[k].canOpen) { if (delims[k].n !== found.n) blockTarget = delims[k]; break; }
      }
    }
    found.n -= use;
    closer.n -= use;
    if (found.n > 0) newNodes.push(found);
    newNodes.push(wrapper);
    if (closer.n > 0) newNodes.push(closer);
    newNodes.push(...nodes.slice(closer.idx + 1));
    // rebuild nodes in place
    nodes.length = 0;
    for (const nd of newNodes) nodes.push(nd);
    // refresh indices and the delimiter list; bottoms are invalid now
    collect();
    bottom['*'] = -1; bottom['_'] = -1; bottom['~'] = -1;
    blockedOpener = blockTarget;
    if (closer.n > 0) {
      di = delims.indexOf(closer);
      if (di === -1) di = 0;
    } else {
      di = delims.length;
      for (let k = 0; k < delims.length; k++) {
        if (delims[k].idx > found.idx) { di = k; break; }
      }
    }
  }
  // Any delimiter left over renders literally.
  flattenDelims(nodes);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += esc(nd.s); break;
      case 'code': out += '<code>' + esc(nd.s) + '</code>'; break;
      case 'html': out += nd.s; break;
      case 'br': out += '<br>'; break;
      case 'em': out += '<em>' + renderNodes(nd.c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderNodes(nd.c) + '</strong>'; break;
      case 'del': out += '<del>' + renderNodes(nd.c) + '</del>'; break;
      case 'link': {
        const href = cleanUrl(nd.href);
        if (href === null) { out += renderNodes(nd.c); break; }
        out += '<a href="' + escAttr(href) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>' + renderNodes(nd.c) + '</a>';
        break;
      }
      case 'img': {
        const src = cleanUrl(nd.href);
        if (src === null) { out += escAttr(nd.alt); break; }
        out += '<img src="' + escAttr(src) + '" alt="' + escAttr(nd.alt) + '"';
        if (nd.title !== null && nd.title !== undefined) out += ' title="' + escAttr(nd.title) + '"';
        out += '>';
        break;
      }
      default: break;
    }
  }
  return out;
}

// Plain-text rendering (for image alt text): emphasis/link/code flatten,
// raw HTML stays raw, breaks vanish.
function renderPlain(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += nd.s; break;
      case 'code': out += nd.s; break;
      case 'html': out += nd.s; break;
      case 'br': break;
      case 'em': case 'strong': case 'del': out += renderPlain(nd.c); break;
      case 'link': out += renderPlain(nd.c); break;
      case 'img': out += nd.alt; break;
      default: break;
    }
  }
  return out;
}

function inline(src, refs) {
  return renderNodes(parseInline(src, refs, false));
}

// ---------------------------------------------------------------------------
// Block parsing. Lines are split on \n after \r\n / \r normalisation.
// parseBlocks builds a tree of block nodes (refs are collected on the way);
// renderBlocks turns the tree into HTML once every definition is known.
// ---------------------------------------------------------------------------

function countIndent(line) {
  let cols = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line[idx];
    if (c === ' ') { cols++; idx++; }
    else if (c === '\t') { cols += 4 - (cols % 4); idx++; }
    else break;
  }
  return { cols, idx };
}

function isBlank(line) {
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

// Remove exactly `cols` columns of indent; null when the line has less.
// A tab straddling the boundary is replaced by spaces.
function stripCols(line, cols) {
  let used = 0;
  let idx = 0;
  let extra = '';
  while (idx < line.length && used < cols) {
    const c = line[idx];
    if (c === ' ') { used++; idx++; }
    else if (c === '\t') {
      const next = used + 4 - (used % 4);
      if (next <= cols) { used = next; idx++; }
      else { extra = ' '.repeat(next - cols); idx++; used = cols; }
    } else break;
  }
  if (used < cols) return null;
  return extra + line.slice(idx);
}

// Strip `cols` columns of leading indent for a container (list item or
// block quote): the remaining leading whitespace is expanded to spaces.
// Null when the line has less indent than `cols`.
function stripContainer(line, cols) {
  let used = 0;
  let idx = 0;
  while (idx < line.length) {
    const c = line[idx];
    if (c === ' ') { used++; idx++; }
    else if (c === '\t') { used += 4 - (used % 4); idx++; }
    else break;
  }
  if (used < cols) return null;
  return ' '.repeat(used - cols) + line.slice(idx);
}

// Remove up to `cols` columns of indent; never null.
function stripUpTo(line, cols) {
  let used = 0;
  let idx = 0;
  let extra = '';
  while (idx < line.length && used < cols) {
    const c = line[idx];
    if (c === ' ') { used++; idx++; }
    else if (c === '\t') {
      const next = used + 4 - (used % 4);
      if (next <= cols) { used = next; idx++; }
      else { extra = ' '.repeat(next - cols); idx++; used = cols; }
    } else break;
  }
  return extra + line.slice(idx);
}

function setextLevel(line) {
  const ind = countIndent(line);
  if (ind.cols > 3) return 0;
  const s = line.slice(ind.idx);
  if (/^=+[ \t]*$/.test(s)) return 1;
  if (/^-+[ \t]*$/.test(s)) return 2;
  return 0;
}

function isHr(s) {
  if (s.length === 0) return false;
  const m = s[0];
  if (m !== '*' && m !== '-' && m !== '_') return false;
  let count = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === m) count++;
    else if (c !== ' ' && c !== '\t') return false;
  }
  return count >= 3;
}

function fenceStart(s) {
  const m = /^(`{3,}|~{3,})/.exec(s);
  if (!m) return null;
  const ch = m[1][0];
  const len = m[1].length;
  const info = s.slice(len);
  if (ch === '`' && info.includes('`')) return null;
  return { ch, len, info };
}

// {type:'bullet'|'ordered', marker, num, delim, markerLen} or null.
// `s` is the line after indent stripping.
function listMarkerInfo(s) {
  let m = /^([-*+])[ \t]/.exec(s);
  if (m) return { type: 'bullet', marker: m[1], num: 0, delim: '', markerLen: 1 };
  m = /^([-*+])$/.exec(s);
  if (m) return { type: 'bullet', marker: m[1], num: 0, delim: '', markerLen: 1 };
  m = /^(\d{1,9})([.)])[ \t]/.exec(s);
  if (m) return { type: 'ordered', marker: m[2], num: parseInt(m[1], 10), delim: m[2], markerLen: m[1].length + 1 };
  m = /^(\d{1,9})([.)])$/.exec(s);
  if (m) return { type: 'ordered', marker: m[2], num: parseInt(m[1], 10), delim: m[2], markerLen: m[1].length + 1 };
  return null;
}

// Does line j start a block that interrupts a paragraph (inPara) or that
// ends a table body / list item content (inPara false)?
function isBlockStart(lines, j, e, state, inPara) {
  const line = lines[j];
  const ind = countIndent(line);
  if (ind.cols > 3) return false;
  const s = line.slice(ind.idx);
  if (s === '') return false;
  const c = s[0];
  if (c === '#') {
    if (/^(#{1,6})([ \t]+|$)/.test(s)) return true;
  } else if (c === '>') {
    return true;
  } else if (c === '`' || c === '~') {
    if (fenceStart(s)) return true;
  } else if (c === '*' || c === '-' || c === '_' || c === '+') {
    if (isHr(s)) return true;
  }
  if (c === '<') {
    const hb = htmlBlockStart(line);
    if (hb && hb.type !== 7) return true;
  }
  const lm = listMarkerInfo(s);
  if (lm) {
    if (!inPara) return true;
    // a list interrupts a paragraph when it is a bullet list with content,
    // or an ordered list starting at 1 with content -- except inside a
    // list item, where any ordered list interrupts
    const rest = s.slice(lm.markerLen);
    if (/^[ \t]*$/.test(rest)) return false;
    if (lm.type === 'bullet') return true;
    return lm.num === 1 || (state.inList || 0) > 0;
  }
  return false;
}

// HTML block start: {type 1..7, endTag?} or null. `line` is the raw line.
function htmlBlockStart(line) {
  const ind = countIndent(line);
  if (ind.cols > 3) return null;
  const s = line.slice(ind.idx);
  if (s[0] !== '<') return null;
  const low = s.toLowerCase();
  const m1 = /^<(script|pre|style|textarea)([\s>]|$)/.exec(low);
  if (m1) return { type: 1, endTag: m1[1] };
  if (low.startsWith('<!--')) return { type: 2 };
  if (low.startsWith('<?')) return { type: 3 };
  if (/^<![a-z]/.test(low)) return { type: 4 };
  if (low.startsWith('<![cdata[')) return { type: 5 };
  const m6 = /^<\/?([a-z][a-z0-9-]*)[\s/>]/.exec(low) || /^<\/?([a-z][a-z0-9-]*)>$/.exec(low);
  if (m6 && BLOCK_TAGS.has(m6[1])) return { type: 6 };
  // type 7: the line is a single open or close tag
  const h = matchInlineHtml(s, 0);
  if (h && h[1] === s.trimEnd().length) return { type: 7 };
  return null;
}

// Split a table row on unescaped pipes; trims outer empty cells.
function splitCells(line) {
  const cells = [];
  let cur = '';
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === '\\' && k + 1 < line.length && line[k + 1] === '|') { cur += '|'; k++; continue; }
    if (c === '\\' && k + 1 < line.length && line[k + 1] === '\\') { cur += '\\\\'; k++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  // drop empty leading / trailing cells (outer pipes)
  let a = 0;
  let b = cells.length;
  if (b > 1 && cells[0].trim() === '') a = 1;
  if (b > 1 && cells[b - 1].trim() === '') b--;
  const out = [];
  for (let k = a; k < b; k++) out.push(cells[k].trim());
  return out;
}

// Parse a table delimiter row; returns the alignments array or null.
function parseDelimiter(line) {
  if (!line.includes('|')) return null;
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    const left = t.startsWith(':');
    const right = t.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// Try to parse a link reference definition starting at lines[s].
// Returns the index of the first line after the definition, or -1.
function tryParseDef(lines, s, e, state) {
  const line = lines[s];
  const ind = countIndent(line);
  if (ind.cols > 3 || line[ind.idx] !== '[') return -1;
  // The label may span lines: join lines (until a blank line) and find
  // the matching ']' in the joined text.
  let joined = line.slice(ind.idx);
  let li = s;
  let close = findClosingBracket(joined, 0);
  while (close === -1 && li + 1 < e && !isBlank(lines[li + 1])) {
    li++;
    joined += '\n' + lines[li];
    close = findClosingBracket(joined, 0);
  }
  if (close === -1) return -1;
  const labelRaw = joined.slice(1, close);
  if (labelRaw.trim() === '' || labelRaw.length > 999) return -1;
  if (!isValidLabel(labelRaw)) return -1;
  const label = normalizeLabel(labelRaw);
  // map `close` (index into `joined`) to a line index and column
  let nls = 0;
  for (let k = 0; k < close; k++) if (joined[k] === '\n') nls++;
  const labelLine = s + nls;
  const lastNl = joined.lastIndexOf('\n', close - 1);
  const labelCol = lastNl === -1 ? ind.idx + close : close - lastNl - 1;
  let p = labelCol + 1;
  li = labelLine;
  // expect ':'
  while (p < lines[li].length && (lines[li][p] === ' ' || lines[li][p] === '\t')) p++;
  if (lines[li][p] !== ':') return -1;
  p++;
  // skip whitespace; the destination may be on the next line
  const skipWs = () => {
    while (true) {
      while (p < lines[li].length && (lines[li][p] === ' ' || lines[li][p] === '\t')) p++;
      if (p < lines[li].length) return true;
      if (li + 1 >= e) return false;
      li++;
      if (isBlank(lines[li])) return false;
      p = countIndent(lines[li]).idx;
    }
  };
  if (!skipWs()) return -1;
  // destination
  let href = '';
  if (lines[li][p] === '<') {
    let q = p + 1;
    while (q < lines[li].length && lines[li][q] !== '>') {
      if (lines[li][q] === '<') return -1;
      if (lines[li][q] === '\\' && q + 1 < lines[li].length && ASCII_PUNCT.has(lines[li][q + 1])) { q += 2; continue; }
      q++;
    }
    if (q >= lines[li].length) return -1;
    href = lines[li].slice(p + 1, q);
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    while (q < lines[li].length) {
      const c = lines[li][q];
      if (c === ' ' || c === '\t') break;
      if (c.charCodeAt(0) < 32) return -1;
      if (c === '\\' && q + 1 < lines[li].length && ASCII_PUNCT.has(lines[li][q + 1])) { q += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (depth !== 0) return -1;
    if (q === p) return -1;
    href = lines[li].slice(p, q);
    p = q;
  }
  href = unescapeStr(href);
  const destLi = li;
  const destP = p;
  // optional title (same line or the next); it must be preceded by
  // whitespace, and it may span lines
  let title = null;
  let titleEndLi = destLi;
  const beforeLi = li;
  const beforeP = p;
  if (skipWs()) {
    const skippedWs = li > beforeLi || p > beforeP;
    const c = lines[li][p];
    if (skippedWs && (c === '"' || c === "'" || c === '(')) {
      const closeCh = c === '(' ? ')' : c;
      let tli = li;
      let tq = p + 1;
      let titleText = '';
      let found = false;
      let endLi = li;
      let endQ = -1;
      while (tli < e) {
        const tl = lines[tli];
        while (tq < tl.length) {
          const ch2 = tl[tq];
          if (ch2 === '\\' && tq + 1 < tl.length) { titleText += tl[tq] + tl[tq + 1]; tq += 2; continue; }
          if (ch2 === closeCh) { found = true; endLi = tli; endQ = tq; break; }
          titleText += ch2;
          tq++;
        }
        if (found) break;
        tli++;
        if (tli >= e || isBlank(lines[tli])) break;
        titleText += '\n';
        tq = 0;
      }
      if (found) {
        let rp = endQ + 1;
        while (rp < lines[endLi].length && (lines[endLi][rp] === ' ' || lines[endLi][rp] === '\t')) rp++;
        if (rp >= lines[endLi].length) {
          title = unescapeStr(titleText);
          titleEndLi = endLi;
        }
      }
    }
  }
  if (title === null) {
    // dest-only: the destination's line must end cleanly
    let rp = destP;
    while (rp < lines[destLi].length && (lines[destLi][rp] === ' ' || lines[destLi][rp] === '\t')) rp++;
    if (rp < lines[destLi].length) return -1;
    if (!state.refs.has(label)) state.refs.set(label, { href, title: null });
    return destLi + 1;
  }
  if (!state.refs.has(label)) state.refs.set(label, { href, title });
  return titleEndLi + 1;
}

// Do the lines end with a paragraph (for lazy continuation)? Scans for an
// open fence or HTML block, then inspects the last non-blank line.
function endsWithParagraph(sub) {
  let inFence = null;
  let inHtml = null;
  for (const line of sub) {
    if (inFence) {
      const ind = countIndent(line);
      if (ind.cols <= 3) {
        const m = /^(`{3,}|~{3,})[ \t]*$/.exec(line.slice(ind.idx));
        if (m && m[1][0] === inFence.ch && m[1].length >= inFence.len) inFence = null;
      }
      continue;
    }
    if (inHtml) {
      if (inHtml.type === 1) { if (line.toLowerCase().includes('</' + inHtml.endTag)) inHtml = null; }
      else if (inHtml.type === 2) { if (line.includes('-->')) inHtml = null; }
      else if (inHtml.type === 3) { if (line.includes('?>')) inHtml = null; }
      else if (inHtml.type === 4) { if (line.includes('>')) inHtml = null; }
      else if (inHtml.type === 5) { if (line.includes(']]>')) inHtml = null; }
      else if (isBlank(line)) inHtml = null;
      continue;
    }
    const ind = countIndent(line);
    if (ind.cols <= 3) {
      const s = line.slice(ind.idx);
      const f = fenceStart(s);
      if (f) { inFence = f; continue; }
      const hb = htmlBlockStart(line);
      if (hb) { inHtml = hb; continue; }
    }
  }
  if (inFence || inHtml) return false;
  // a trailing blank line closes the paragraph: a lazy line cannot follow it
  if (sub.length > 0 && isBlank(sub[sub.length - 1])) return false;
  let k = sub.length - 1;
  while (k >= 0 && isBlank(sub[k])) k--;
  if (k < 0) return false;
  const last = sub[k];
  const ind = countIndent(last);
  if (ind.cols > 3) return false;
  const s = last.slice(ind.idx);
  if (/^(#{1,6})([ \t]+|$)/.test(s)) return false;
  if (isHr(s)) return false;
  if (fenceStart(s)) return false;
  if (htmlBlockStart(last)) return false;
  return true;
}

// Parse a paragraph starting at lines[i] (after leading definitions).
// Returns {node|null, next}.
function parseParagraph(lines, i, e, state, endsNL) {
  let j = i;
  while (j < e) {
    const ni = tryParseDef(lines, j, e, state);
    if (ni === -1) break;
    j = ni;
  }
  if (j >= e) return { node: null, next: j };
  // after definitions, a block start means there is no paragraph here
  if (isBlockStart(lines, j, e, state, false)) return { node: null, next: j };
  const plines = [];
  let k = j;
  while (k < e) {
    const line = lines[k];
    if (isBlank(line)) break;
    if (plines.length > 0) {
      const st = setextLevel(line);
      if (st) return { node: { t: 'h', level: st, text: plines.join('\n').trim() }, next: k + 1 };
      if (plines.length === 1) {
        const aligns = parseDelimiter(line);
        if (aligns) {
          const head = splitCells(plines[0]);
          if (head.length === aligns.length) {
            const rows = [];
            let m = k + 1;
            while (m < e) {
              const rl = lines[m];
              // a line ends the table only when it is empty or spaces-only;
              // a tab-only line is a row of empty cells
              if (/^[ ]*$/.test(rl)) break;
              if (isBlockStart(lines, m, e, state, false)) break;
              rows.push(splitCells(rl));
              m++;
            }
            return { node: { t: 'table', aligns, head, rows }, next: m };
          }
        }
      }
      if (isBlockStart(lines, k, e, state, true)) break;
    }
    plines.push(line);
    k++;
  }
  if (plines.length === 0) return { node: null, next: k };
  return { node: { t: 'para', text: plines.join('\n') }, next: k };
}

function parseIndentedCode(lines, i, e) {
  const content = [];
  let j = i;
  while (j < e) {
    const line = lines[j];
    if (isBlank(line)) {
      let m = j + 1;
      while (m < e && isBlank(lines[m])) m++;
      if (m < e && countIndent(lines[m]).cols >= 4) { content.push(stripUpTo(line, 4)); j++; continue; }
      break;
    }
    if (countIndent(line).cols < 4) break;
    content.push(stripCols(line, 4));
    j++;
  }
  while (content.length > 0 && isBlank(content[content.length - 1])) content.pop();
  return { node: { t: 'code', lang: null, text: content.join('\n') + (content.length ? '\n' : '') }, next: j };
}

function parseFencedCode(lines, i, e, f, fenceIndent) {
  const info = unescapeStr(f.info.trim());
  const lang = info === '' ? null : info.split(/[ \t]+/)[0];
  const content = [];
  let j = i + 1;
  while (j < e) {
    const line = lines[j];
    const ind = countIndent(line);
    if (ind.cols <= 3) {
      const m = /^(`{3,}|~{3,})[ \t]*$/.exec(line.slice(ind.idx));
      if (m && m[1][0] === f.ch && m[1].length >= f.len) { j++; break; }
    }
    // content lines lose up to the fence's indent
    content.push(stripUpTo(line, fenceIndent));
    j++;
  }
  let text = content.join('\n');
  if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  return { node: { t: 'code', lang, text }, next: j };
}

function parseHtmlBlock(lines, i, e, hb, endsNL) {
  const start = i;
  let j = i + 1;
  if (hb.type === 1) {
    const endTag = '</' + hb.endTag;
    if (!lines[i].toLowerCase().includes(endTag)) {
      while (j < e && !lines[j].toLowerCase().includes(endTag)) j++;
      if (j < e) j++;
    }
  } else if (hb.type === 2) {
    if (!lines[i].includes('-->')) {
      while (j < e && !lines[j].includes('-->')) j++;
      if (j < e) j++;
    }
  } else if (hb.type === 3) {
    if (!lines[i].includes('?>')) {
      while (j < e && !lines[j].includes('?>')) j++;
      if (j < e) j++;
    }
  } else if (hb.type === 4) {
    if (!lines[i].includes('>')) {
      while (j < e && !lines[j].includes('>')) j++;
      if (j < e) j++;
    }
  } else if (hb.type === 5) {
    if (!lines[i].includes(']]>')) {
      while (j < e && !lines[j].includes(']]>')) j++;
      if (j < e) j++;
    }
  } else {
    while (j < e && !isBlank(lines[j])) j++;
  }
  let text = lines.slice(start, j).join('\n');
  if (j < e) {
    // a trailing newline is added when the next line is non-empty
    // (a whitespace-only line still counts as non-empty)
    if (lines[j].length > 0) text += '\n';
  } else if (endsNL) {
    text += '\n';
  }
  return { node: { t: 'html', text }, next: j };
}

// Remove a block-quote marker ('>' plus one optional space) and return
// the content line, with the remaining leading whitespace expanded to
// spaces. Null when the line is not a quote line.
function stripQuoteMarker(line) {
  let col = 0;
  let idx = 0;
  while (idx < line.length && (line[idx] === ' ' || line[idx] === '\t')) {
    if (line[idx] === ' ') { col++; idx++; }
    else { col += 4 - (col % 4); idx++; }
  }
  if (col > 3 || line[idx] !== '>') return null;
  idx++;
  col++;
  let prefixEnd = col;
  if (idx < line.length && (line[idx] === ' ' || line[idx] === '\t')) {
    if (line[idx] === ' ') { col++; idx++; prefixEnd = col; }
    else {
      // a tab after '>': one column of it is the marker's space, the rest
      // stays as spaces in the content
      const tabEnd = col + 4 - (col % 4);
      prefixEnd = col + 1;
      col = tabEnd;
      idx++;
    }
  }
  let j = idx;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
    if (line[j] === ' ') { col++; j++; }
    else { col += 4 - (col % 4); j++; }
  }
  return ' '.repeat(col - prefixEnd) + line.slice(j);
}

function parseQuote(lines, i, e, state, endsNL) {
  const qlines = [];
  let lastWasLazy = false;
  let j = i;
  while (j < e) {
    const line = lines[j];
    const rest = stripQuoteMarker(line);
    if (rest !== null) {
      // a quote line that strips to only whitespace keeps that whitespace
      // as a paragraph line: merge it into the previous line, since a
      // bare whitespace line would read as blank
      if (rest !== '' && isBlank(rest)) {
        const lastQ = qlines[qlines.length - 1];
        if (lastQ !== undefined && lastQ !== '' && !isBlank(lastQ) && endsWithParagraph(qlines)) {
          qlines[qlines.length - 1] = lastQ + '\n' + rest;
          lastWasLazy = false;
          j++;
          continue;
        }
      }
      qlines.push(rest);
      lastWasLazy = false;
      j++;
      continue;
    }
    if (isBlank(line)) break;
    if (isBlockStart(lines, j, e, state, true)) break;
    if (!endsWithParagraph(qlines)) break;
    // a lazy setext underline cannot form a heading: merge it into the
    // previous line so the inner parse keeps it as paragraph text; when
    // the previous line was itself lazy, marked indents it by four spaces
    if (setextLevel(line) === 1) {
      const lastQ = qlines[qlines.length - 1];
      if (lastQ !== '' && lastQ !== undefined) {
        qlines[qlines.length - 1] = lastQ + '\n' + (lastWasLazy ? '    ' : '') + line;
      } else {
        qlines.push(line);
      }
    } else {
      // a lazy line indented four or more columns loses four columns;
      // a less-indented line is kept as-is. When the stripped line would
      // itself start a block, it is a paragraph continuation, not a new
      // block: merge it into the previous line.
      const lind = countIndent(line);
      if (lind.cols >= 4) {
        const ded = stripCols(line, 4);
        const lastQ = qlines[qlines.length - 1];
        if (ded !== null && lastQ !== '' && lastQ !== undefined && isBlockStart([ded], 0, 1, state, true)) {
          qlines[qlines.length - 1] = lastQ + '\n' + ded;
        } else {
          qlines.push(ded === null ? line : ded);
        }
      } else {
        qlines.push(line);
      }
    }
    lastWasLazy = true;
    j++;
  }
  const kids = parseBlocks(qlines, 0, qlines.length, state, j === e && endsNL);
  return { node: { t: 'quote', kids }, next: j };
}

// Is the last block in `sub` an unclosed fenced code block?
function subInFence(sub) {
  let fence = null;
  for (const line of sub) {
    if (fence) {
      const ind = countIndent(line);
      if (ind.cols <= 3) {
        const m = /^(`{3,}|~{3,})[ \t]*$/.exec(line.slice(ind.idx));
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      }
      continue;
    }
    const ind = countIndent(line);
    if (ind.cols <= 3) {
      const f = fenceStart(line.slice(ind.idx));
      if (f) fence = f;
    }
  }
  return fence !== null;
}

// Is `sub` inside a fenced code block that already has at least one
// content line? An under-indented line right after the fence opens
// ends the list item (the fence stays empty); once the fence has
// content, under-indented lines are fence content.
function subInFenceWithContent(sub) {
  let fence = null;
  let hasContent = false;
  for (const line of sub) {
    if (fence) {
      const ind = countIndent(line);
      if (ind.cols <= 3) {
        const m = /^(`{3,}|~{3,})[ \t]*$/.exec(line.slice(ind.idx));
        if (m && m[1][0] === fence.ch && m[1].length >= fence.len) { fence = null; hasContent = false; continue; }
      }
      hasContent = true;
      continue;
    }
    const ind = countIndent(line);
    if (ind.cols <= 3) {
      const f = fenceStart(line.slice(ind.idx));
      if (f) { fence = f; hasContent = false; }
    }
  }
  return fence !== null && hasContent;
}

function parseListItem(lines, j, e, state, base, lm, endsNL) {
  const line = lines[j];
  const ind = countIndent(line);
  // each item's marker is measured from its own line (a later sibling
  // may have a longer number, e.g. 99. then 100.)
  lm = listMarkerInfo(line.slice(ind.idx)) || lm;
  const markerCol = ind.cols;
  const markerLen = lm.markerLen;
  let p = ind.idx + markerLen;
  let col = markerCol + markerLen;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    if (line[p] === ' ') { col++; p++; }
    else { col += 4 - (col % 4); p++; }
  }
  const hasContent = p < line.length;
  const pad = col - (markerCol + markerLen);
  const contentIndent = !hasContent ? markerLen + 1 : (pad >= 1 && pad <= 4 ? markerLen + pad : markerLen + 1);
  const contentIndentAbs = markerCol + contentIndent;
  // First-line content: the whitespace run after the marker ends at column
  // `col`; content starts at contentIndentAbs; the gap (when the pad is
  // wider than 4 columns) is expanded to spaces.
  const firstContent = !hasContent ? '' : ' '.repeat(Math.max(0, col - contentIndentAbs)) + line.slice(p);
  const sub = [firstContent];
  // An empty item (marker only) followed by a blank line is empty: the
  // indented lines after the blank belong to the next block, not the item.
  if (!hasContent && (j + 1 >= e || isBlank(lines[j + 1]))) {
    state.inList = (state.inList || 0) + 1;
    const kids = parseBlocks(sub, 0, sub.length, state, j + 1 === e && endsNL);
    state.inList--;
    return { node: { t: 'item', task: false, checked: false, kids }, next: j + 1, hadBlankAfter: false, internalBlank: false, contentIndentAbs };
  }
  let k = j + 1;
  while (k < e) {
    const ln = lines[k];
    if (isBlank(ln)) {
      // a blank line only belongs to this item when the next non-blank
      // line belongs to it too; otherwise the blank (and the item) end
      // here and the blank belongs to the outer level (a blank inside a
      // fenced code block is content, not a separator)
      if (!subInFence(sub)) {
        let m = k + 1;
        while (m < e && isBlank(lines[m])) m++;
        if (m < e && countIndent(lines[m]).cols < contentIndentAbs) break;
      }
      sub.push(''); k++; continue;
    }
    if (countIndent(ln).cols >= contentIndentAbs) {
      sub.push(stripContainer(ln, contentIndentAbs));
      k++;
      continue;
    }
    // under-indented: a list marker line ends the item (it is a sibling
    // or a new list), as does any other block start
    const lind = countIndent(ln);
    if (lind.cols <= 3 && listMarkerInfo(ln.slice(lind.idx))) break;
    if (isBlockStart(lines, k, e, state, true)) break;
    // inside a fenced code block that already has content, an
    // under-indented line is fence content, not the end of the item
    if (subInFenceWithContent(sub)) { sub.push(ln); k++; continue; }
    if (!endsWithParagraph(sub)) break;
    // lazy continuation line: a line indented four or more columns loses
    // four columns (the indented-code amount); a less-indented line is
    // kept as-is. A lazy setext underline cannot form a heading: merge
    // it into the previous line so the inner parse keeps it as text.
    const lastSub = sub[sub.length - 1];
    if (setextLevel(ln) === 1 && lastSub !== '' && lastSub !== undefined) {
      sub[sub.length - 1] = lastSub + '\n' + ln;
    } else if (lind.cols >= 4) {
      const ded = stripCols(ln, 4);
      // a lazy line that dedents to a block start (e.g. a list marker)
      // belongs to the paragraph, not a nested list: merge it into the
      // previous line
      if (lastSub !== '' && lastSub !== undefined && isBlockStart([ded], 0, 1, state, true)) {
        sub[sub.length - 1] = lastSub + '\n' + ded;
      } else {
        sub.push(ded);
      }
    } else {
      sub.push(ln);
    }
    k++;
  }
  let last = sub.length - 1;
  while (last >= 0 && sub[last] === '') last--;
  // a trailing blank only makes the list loose when the item has
  // non-blank content; an empty item's blanks do not count
  const hadBlankAfter = last >= 0 && last < sub.length - 1;
  sub.length = last + 1;
  let task = false;
  let checked = false;
  if (sub.length > 0) {
    const tm = /^\[([ xX])\](?: |$)/.exec(sub[0]);
    if (tm) {
      task = true;
      checked = tm[1] !== ' ';
      sub[0] = sub[0].slice(tm[0].length);
    }
  }
  // Loose only when a blank line separates two top-level blocks of this
  // item; blanks inside a nested list or code block do not count.
  const topBlanks = [];
  state.inList = (state.inList || 0) + 1;
  const kids = parseBlocks(sub, 0, sub.length, state, k === e && endsNL, topBlanks);
  state.inList--;
  return { node: { t: 'item', task, checked, kids }, next: k, hadBlankAfter, internalBlank: topBlanks.length > 0, contentIndentAbs };
}

function parseList(lines, i, e, state, endsNL) {
  const firstLine = lines[i];
  const ind = countIndent(firstLine);
  const base = ind.cols;
  const lm = listMarkerInfo(firstLine.slice(ind.idx));
  const ordered = lm.type === 'ordered';
  const markerChar = lm.marker;
  const startNum = ordered ? lm.num : null;
  const items = [];
  let loose = false;
  let j = i;
  while (j < e) {
    const item = parseListItem(lines, j, e, state, base, lm, endsNL);
    if (item.internalBlank) loose = true;
    items.push(item.node);
    j = item.next;
    if (j >= e) break;
    // blank lines between items: skip them
    let j2 = j;
    while (j2 < e && isBlank(lines[j2])) j2++;
    if (j2 >= e) break;
    const nline = lines[j2];
    const nind = countIndent(nline);
    // a sibling's indent is at most base+3 (it may dedent below base)
    // and below the previous item's content indent; otherwise the line
    // belongs to the item (or starts a new list / block after this one).
    // When there is no sibling, leave j before the blank lines so the
    // caller sees them (a blank between a nested list and the outer
    // item's next paragraph makes the outer list loose).
    if (nind.cols > base + 3) break;
    if (nind.cols >= item.contentIndentAbs) break;
    if (isHr(nline.slice(nind.idx))) break;
    const nlm = listMarkerInfo(nline.slice(nind.idx));
    if (!nlm) break;
    if (ordered !== (nlm.type === 'ordered')) break;
    if (nlm.marker !== markerChar) break;
    // the next line IS a sibling: blank lines between the items, and a
    // trailing blank after this item, make the list loose (a trailing
    // blank with no sibling after it does not)
    if (j2 > j) loose = true;
    if (item.hadBlankAfter) loose = true;
    j = j2;
  }
  return { node: { t: 'list', ordered, start: startNum, loose, items }, next: j };
}

// The main block parser. Returns an array of block nodes. When `topBlanks`
// is given, the indices of blank lines skipped between two top-level
// blocks are recorded in it (used for list looseness).
function parseBlocks(lines, s, e, state, endsNL, topBlanks) {
  const nodes = [];
  let i = s;
  while (i < e) {
    const line = lines[i];
    if (isBlank(line)) {
      if (topBlanks && nodes.length > 0) topBlanks.push(i);
      i++;
      continue;
    }
    const ind = countIndent(line);
    if (ind.cols > 3) {
      const r = parseIndentedCode(lines, i, e);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    const s2 = line.slice(ind.idx);
    const c = s2[0];
    // ATX heading
    const hm = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(s2);
    if (hm) {
      let content = hm[2] === undefined ? '' : hm[2];
      const cm = /^(.*?)[ \t]+#+[ \t]*$/.exec(content);
      if (cm) content = cm[1];
      content = content.replace(/[ \t]+$/, '');
      if (/^#+$/.test(content)) content = '';
      nodes.push({ t: 'h', level: hm[1].length, text: content });
      i++;
      continue;
    }
    // fenced code
    const f = fenceStart(s2);
    if (f) {
      const r = parseFencedCode(lines, i, e, f, ind.cols);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // thematic break
    if (isHr(s2)) {
      nodes.push({ t: 'hr' });
      i++;
      continue;
    }
    // block quote
    if (c === '>') {
      const r = parseQuote(lines, i, e, state, endsNL);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // list
    const lm = listMarkerInfo(s2);
    if (lm) {
      const r = parseList(lines, i, e, state, endsNL);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // HTML block
    const hb = htmlBlockStart(line);
    if (hb) {
      const r = parseHtmlBlock(lines, i, e, hb, endsNL);
      nodes.push(r.node);
      i = r.next;
      continue;
    }
    // paragraph (definitions, setext headings, tables)
    const p = parseParagraph(lines, i, e, state, endsNL);
    if (p.node) nodes.push(p.node);
    i = p.next;
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(nodes, state, paraBare) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'para': {
        const inner = inline(nd.text, state.refs);
        out += paraBare ? inner : '<p>' + inner + '</p>\n';
        break;
      }
      case 'h':
        out += '<h' + nd.level + '>' + inline(nd.text, state.refs) + '</h' + nd.level + '>\n';
        break;
      case 'code': {
        out += '<pre><code';
        if (nd.lang !== null) out += ' class="language-' + escAttr(nd.lang) + '"';
        out += '>' + esc(nd.text) + '</code></pre>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += nd.text;
        break;
      case 'quote':
        out += '<blockquote>\n' + renderBlocks(nd.kids, state, false) + '</blockquote>\n';
        break;
      case 'list': {
        out += nd.ordered ? '<ol' + (nd.start !== 1 ? ' start="' + nd.start + '"' : '') + '>\n' : '<ul>\n';
        for (const item of nd.items) {
          let inner = renderBlocks(item.kids, state, !nd.loose);
          if (item.task) {
            const cb = '<input ' + (item.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
            if (inner.startsWith('<p>')) inner = '<p>' + cb + inner.slice(3);
            else inner = cb + inner;
          }
          out += '<li>' + inner + '</li>\n';
        }
        out += nd.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < nd.head.length; k++) {
          const a = nd.aligns[k];
          out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inline(nd.head[k], state.refs) + '</th>\n';
        }
        out += '</tr>\n</thead>\n';
        if (nd.rows.length > 0) {
          out += '<tbody>';
          for (const row of nd.rows) {
            out += '<tr>\n';
            for (let k = 0; k < nd.head.length; k++) {
              const a = nd.aligns[k];
              const cell = k < row.length ? row[k] : '';
              out += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inline(cell, state.refs) + '</td>\n';
            }
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function renderDoc(src) {
  const norm = src.replace(/\r\n?/g, '\n');
  const endsNL = norm.endsWith('\n');
  const lines = norm.split('\n');
  if (endsNL) lines.pop();
  const state = { refs: new Map() };
  const nodes = parseBlocks(lines, 0, lines.length, state, endsNL);
  return renderBlocks(nodes, state, false);
}
